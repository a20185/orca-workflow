/**
 * test/unit/reviews 共用测试设施：真实迁移库 + 临时仓根 + 可脚本化的假端口
 * （Orca 评审者身份队列 / jj 版本操作 / 环境暂停恢复）与全链铺轨助手
 * （declare → claim → accept → submit → onMergeReady → review-accept）。
 *
 * 假端口口径与 test/unit/claims 相同（回执形状逐段可脚本化）；jj 假端口为
 * T3.2 扩展端口：每个工作区记住创建时的 base，snapshot 返回可推进的 head。
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import type { GovConfig } from '../../../src/config.ts';
import { GovError } from '../../../src/domain/errors.ts';
import type { WorkerStartReceipt } from '../../../src/adapters/orca.ts';
import type { CreateReceipt } from '../../../src/adapters/environment.ts';
import type {
  EnvLifecyclePort,
  JjVersionPort,
  OrcaMessagingPort,
  TrustHandle,
  TrustProvision,
} from '../../../src/services/ports.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { createSubmissionService, isSubmitAccepted } from '../../../src/services/submissions.ts';
import { createRebaseService } from '../../../src/services/rebases.ts';
import { createReviewService, type ReviewService } from '../../../src/services/reviews.ts';
import { manualApprove, type EvidenceItem } from '../../../src/services/evidence.ts';
import type { SubmissionService } from '../../../src/services/submissions.ts';

export const BASE_COMMIT = '1'.repeat(40);
export const SECOND_COMMIT = '2'.repeat(40);
export const MOVED_TARGET = '3'.repeat(40);
export const DIVERGED_COMMIT = '4'.repeat(40);
export const REBASED_COMMIT = '5'.repeat(40);

export function openReviewsTestDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function sampleReviewSpec(
  overrides: {
    readonly taskId?: string;
    readonly maxReviewRounds?: number;
    readonly reviewer?: 'claude' | 'codex';
    readonly extraManual?: boolean;
  } = {},
): Record<string, unknown> {
  const criteria: Array<Record<string, unknown>> = [
    {
      type: 'command',
      criterionId: 'cmd-1',
      config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
    },
    {
      type: 'artifact',
      criterionId: 'art-1',
      config: { path: 'out/report.md', minBytes: 1, maxBytes: 1_048_576 },
    },
    {
      type: 'manual',
      criterionId: 'man-1',
      config: { description: '人工核验收尾' },
    },
  ];
  if (overrides.extraManual === true) {
    criteria.push({
      type: 'manual',
      criterionId: 'man-2',
      config: { description: '第二项人工核验' },
    });
  }
  return {
    schemaVersion: 1,
    taskId: overrides.taskId ?? 'gt-unit-review',
    problem: '为 T3.2 评审单测实现的示例任务',
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不引入新框架'],
    ownedPaths: ['src/a'],
    repoId: 'demo',
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: BASE_COMMIT,
    acceptanceCriteria: criteria,
    agentPolicy: { executor: 'opencode', reviewer: overrides.reviewer ?? 'claude' },
    budget: {
      maxReviewRounds: overrides.maxReviewRounds ?? 2,
      maxWallSeconds: 3600,
      maxEvidenceBytes: 1_048_576,
    },
  };
}

/** 默认开发证据清单（artifact 哈希与 fullReviewEvidence 对齐）。 */
export function defaultManifest(): EvidenceItem[] {
  return [
    { criterionId: 'cmd-1', exitCode: 0 },
    { criterionId: 'art-1', artifactHash: 'hash-art-1' },
  ];
}

// ---------------------------------------------------------------------------
// 假 Orca 端口：评审者身份按 agent 脚本化（claims 走 opencode 默认新身份）
// ---------------------------------------------------------------------------

export class FakeReviewOrca implements OrcaMessagingPort {
  readonly taskCreateCalls: Array<{ readonly spec: string }> = [];
  readonly workerStartCalls: Array<{
    readonly task: string;
    readonly worktree: string;
    readonly agent?: string;
  }> = [];
  readonly workerStopCalls: string[] = [];
  readonly sendCalls: Array<{
    readonly dispatch: string;
    readonly type: string;
    readonly subject: string;
    readonly body: string;
  }> = [];
  failSend: Error | null = null;
  /** agent → 评审者身份队列（耗尽后新身份 sess-N，永不命中禁任）。 */
  readonly identitiesByAgent = new Map<string, string[]>();
  private nextDispatch = 1;
  private nextSession = 1;

  async taskCreate(input: { readonly spec: string; readonly taskTitle?: string }): Promise<{
    ok: true;
    raw: { task: { id: string; run_id: string; status: string } };
  }> {
    this.taskCreateCalls.push({ spec: input.spec });
    return { ok: true, raw: { task: { id: `ot-${this.nextDispatch++}`, run_id: 'run-1', status: 'ready' } } };
  }

  async workerStart(input: {
    readonly task: string;
    readonly worktree: string;
    readonly agent?: string;
    readonly terminal?: string;
    readonly retryOf?: string;
    readonly repo?: string;
    readonly name?: string;
  }): Promise<{ ok: true; raw: WorkerStartReceipt & { sessionId?: string } }> {
    this.workerStartCalls.push({
      task: input.task,
      worktree: input.worktree,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
    });
    const dispatchId = `disp-${this.nextDispatch++}`;
    const queue = input.agent !== undefined ? this.identitiesByAgent.get(input.agent) : undefined;
    const scripted = queue?.shift();
    const sessionId = scripted ?? `sess-${this.nextSession++}`;
    const terminalHandle = `term-${dispatchId}`;
    return {
      ok: true,
      raw: {
        runId: 'run-1',
        taskId: input.task,
        dispatchId,
        state: 'ready',
        effects: [{ kind: 'terminal', role: 'agent', id: terminalHandle }],
        residualResources: [],
        terminalHandle,
        sessionId,
      },
    };
  }

  async workerStop(dispatch: string): Promise<{ ok: true; raw: unknown }> {
    this.workerStopCalls.push(dispatch);
    return { ok: true, raw: { dispatch, settled: true } };
  }

  async sendToDispatch(input: {
    readonly dispatch: string;
    readonly type: 'status' | 'merge_ready' | 'question';
    readonly subject: string;
    readonly body: string;
    readonly filesModified?: readonly string[];
  }): Promise<{ ok: true; raw: unknown }> {
    this.sendCalls.push({
      dispatch: input.dispatch,
      type: input.type,
      subject: input.subject,
      body: input.body,
    });
    if (this.failSend !== null) {
      throw this.failSend;
    }
    return { ok: true, raw: { message: { id: `msg-${this.sendCalls.length}` } } };
  }
}

// ---------------------------------------------------------------------------
// 假 jj 端口：snapshot = 每工作区可推进的 head；bookmark/rebase/diff 可脚本
// ---------------------------------------------------------------------------

export class FakeReviewJj implements JjVersionPort {
  readonly workspaceAddCalls: Array<{ readonly name: string; readonly path: string; readonly rev?: string }> = [];
  readonly workspaceForgetCalls: string[] = [];
  readonly rebaseCalls: Array<{ readonly rev: string; readonly newBase: string }> = [];
  readonly diffPathsCalls: Array<{ readonly rev: string; readonly ownedPaths: readonly string[] }> = [];
  readonly createdDirs: string[] = [];
  /** 工作区 realpath → 创建时 base（snapshot 未推进时返回它）。 */
  readonly baseByDir = new Map<string, string>();
  /** 工作区 realpath → 当前 head（测试用 advanceHead 推进）。 */
  readonly headByDir = new Map<string, string>();
  /** bookmark 当前指向（默认任务书 base）。 */
  bookmarkCommit: string = BASE_COMMIT;
  /** diffPaths 抛错脚本（路径越界等）；按次消耗。 */
  nextDiffPathsError: GovError | null = null;
  /** commit → 冲突清单（conflictList 与 rebase 后 submit 兜底共用）。 */
  readonly conflictsByRev = new Map<string, string[]>();
  /** rebase 结果脚本；耗尽后默认 {newCommitId: REBASED_COMMIT, conflicts: []}。 */
  readonly rebaseScript: Array<{ newCommitId: string; conflicts: string[] }> = [];

  advanceHead(dir: string, commitId: string): void {
    this.headByDir.set(dir, commitId);
  }

  async workspaceAdd(input: {
    readonly name: string;
    readonly path: string;
    readonly rev?: string;
  }): Promise<{ ok: true; name: string; path: string; opIds: string[] }> {
    this.workspaceAddCalls.push({
      name: input.name,
      path: input.path,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
    });
    const dir = fs.mkdtempSync(input.path);
    const real = fs.realpathSync(dir);
    this.createdDirs.push(real);
    if (input.rev !== undefined) {
      this.baseByDir.set(real, input.rev);
    }
    return { ok: true, name: input.name, path: dir, opIds: ['op-add-1'] };
  }

  async workspaceForget(name: string): Promise<{ ok: true; name: string; path?: undefined; opIds: string[] }> {
    this.workspaceForgetCalls.push(name);
    return { ok: true, name, opIds: ['op-forget-1'] };
  }

  async snapshot(dir?: string): Promise<{ ok: true; commitId: string; treeId: string; opIds: string[] }> {
    const key = dir ?? '(root)';
    const commitId = this.headByDir.get(key) ?? this.baseByDir.get(key) ?? BASE_COMMIT;
    return { ok: true, commitId, treeId: `tree-${commitId.slice(0, 8)}`, opIds: ['op-snap'] };
  }

  async diffPaths(
    rev: string,
    ownedPaths: readonly string[],
  ): Promise<{ ok: true; paths: string[] }> {
    this.diffPathsCalls.push({ rev, ownedPaths });
    if (this.nextDiffPathsError !== null) {
      const err = this.nextDiffPathsError;
      this.nextDiffPathsError = null;
      throw err;
    }
    return { ok: true, paths: [] };
  }

  async conflictList(rev: string): Promise<{ ok: true; conflicts: string[] }> {
    return { ok: true, conflicts: this.conflictsByRev.get(rev) ?? [] };
  }

  async bookmarkCurrent(bookmark: string): Promise<{ ok: true; commitId: string }> {
    return { ok: true, commitId: this.bookmarkCommit };
  }

  async rebase(input: {
    readonly rev: string;
    readonly newBase: string;
  }): Promise<{ ok: true; newCommitId: string; conflicts: string[]; opIds: string[] }> {
    this.rebaseCalls.push({ rev: input.rev, newBase: input.newBase });
    const scripted = this.rebaseScript.shift();
    return {
      ok: true,
      newCommitId: scripted?.newCommitId ?? REBASED_COMMIT,
      conflicts: scripted?.conflicts ?? [],
      opIds: ['op-rebase'],
    };
  }
}

// ---------------------------------------------------------------------------
// 假环境端口：暂停/恢复可失败、可断言
// ---------------------------------------------------------------------------

export class FakeReviewEnv implements EnvLifecyclePort {
  readonly createCalls: Array<{ readonly workspaceHostPath: string; readonly taskDirRel: string }> = [];
  readonly setWritableCalls: string[] = [];
  readonly setReadonlyCalls: string[] = [];
  readonly destroyCalls: string[] = [];
  readonly suspendCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  failSuspend: Error | null = null;
  failResume: Error | null = null;
  private nextEnv = 1;

  async create(input: { readonly workspaceHostPath: string; readonly taskDirRel: string }): Promise<CreateReceipt> {
    this.createCalls.push({ workspaceHostPath: input.workspaceHostPath, taskDirRel: input.taskDirRel });
    const envInstanceId = `env-${this.nextEnv++}`;
    const connection = { type: 'ssh', host: '127.0.0.1', port: 2222, username: 'dev', projectRoot: '/work' } as const;
    return {
      ok: true,
      envInstanceId,
      connection,
      raw: { schemaVersion: 1, connection, userData: { resourceId: envInstanceId } },
    };
  }

  async setWritable(envId: string): Promise<{ ok: true; target: 'writable'; hostDir: string; verified: true }> {
    this.setWritableCalls.push(envId);
    return { ok: true, target: 'writable', hostDir: `/fake/host/${envId}`, verified: true };
  }

  async setReadonly(envId: string): Promise<{ ok: true; target: 'readonly'; hostDir: string; verified: true }> {
    this.setReadonlyCalls.push(envId);
    return { ok: true, target: 'readonly', hostDir: `/fake/host/${envId}`, verified: true };
  }

  async destroy(envId: string): Promise<{ ok: true; destroyed: boolean; resourceId: string; existed: boolean }> {
    this.destroyCalls.push(envId);
    return { ok: true, destroyed: true, resourceId: envId, existed: true };
  }

  async suspend(envId: string): Promise<{
    ok: true;
    suspended: boolean;
    resourceId: string;
    existed: boolean;
  }> {
    this.suspendCalls.push(envId);
    if (this.failSuspend !== null) {
      throw this.failSuspend;
    }
    return { ok: true, suspended: true, resourceId: envId, existed: true };
  }

  async resume(envId: string): Promise<{
    ok: true;
    resourceId: string;
    connection: {
      type: 'ssh';
      host: string;
      port: number;
      username: string;
      projectRoot: string;
    };
  }> {
    this.resumeCalls.push(envId);
    if (this.failResume !== null) {
      throw this.failResume;
    }
    return {
      ok: true,
      resourceId: envId,
      connection: { type: 'ssh', host: '127.0.0.1', port: 2222, username: 'dev', projectRoot: '/work' },
    };
  }
}

// ---------------------------------------------------------------------------
// 假信任预置（认领服务依赖）
// ---------------------------------------------------------------------------

export class FakeTrust {
  readonly provisionCalls: string[] = [];
  readonly cleanupCalls: string[] = [];

  readonly provision: TrustProvision = async (workspaceRealPath: string): Promise<TrustHandle> => {
    this.provisionCalls.push(workspaceRealPath);
    const self = this;
    return {
      async cleanup(): Promise<void> {
        self.cleanupCalls.push(workspaceRealPath);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// 宿主与铺轨助手
// ---------------------------------------------------------------------------

export interface ReviewHost {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: FakeReviewOrca;
  readonly jj: FakeReviewJj;
  readonly env: FakeReviewEnv;
  readonly trust: FakeTrust;
  readonly stepTimeoutMs: number;
  dispose(): void;
}

export function createReviewHost(): ReviewHost {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-reviews-test-'));
  const repoRoot = fs.realpathSync(rawRoot);
  const config: GovConfig = {
    schemaVersion: 1,
    repos: [{ repoId: 'demo', hostPath: path.join(repoRoot, 'repo'), targets: ['main'] }],
  };
  const db = openReviewsTestDb();
  const orca = new FakeReviewOrca();
  const jj = new FakeReviewJj();
  const env = new FakeReviewEnv();
  const trust = new FakeTrust();
  return {
    db,
    config,
    orca,
    jj,
    env,
    trust,
    stepTimeoutMs: 50,
    dispose() {
      db.close();
      for (const dir of jj.createdDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.rmSync(rawRoot, { recursive: true, force: true });
    },
  };
}

export function makeSubmissionService(h: ReviewHost): SubmissionService {
  return createSubmissionService({ db: h.db, config: h.config, jj: h.jj, stepTimeoutMs: h.stepTimeoutMs });
}

export function makeRebaseService(h: ReviewHost) {
  return createRebaseService({ db: h.db, config: h.config, jj: h.jj, stepTimeoutMs: h.stepTimeoutMs });
}

export function makeReviewService(h: ReviewHost): ReviewService {
  return createReviewService({
    db: h.db,
    config: h.config,
    orca: h.orca,
    jj: h.jj,
    env: h.env,
    stepTimeoutMs: h.stepTimeoutMs,
  });
}

/** 声明者/认领者身份常量（身份三拒断言用）。 */
export const DECLARER_SESSION = 'cap-decl';
export const COORD_SESSION = 'cap-coord-1';
export const EXEC_SESSION = 'cap-exec-1';
export const HIST_COORD_SESSION = 'cap-coord-hist';
export const OPERATOR_SESSION = 'cap-op-1';

export interface ActiveTask {
  readonly taskId: string;
  readonly claimId: string;
  readonly devWsPath: string;
  readonly devEnvId: string;
  readonly executorDispatchId: string;
}

/** 铺到 ACTIVE：declare → claim → accept（全真服务路径）。 */
export async function setupActiveTask(
  h: ReviewHost,
  spec: Record<string, unknown> = sampleReviewSpec(),
): Promise<ActiveTask> {
  const taskId = String((spec as { taskId?: unknown }).taskId ?? 'gt-unit-review');
  await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec, session: DECLARER_SESSION });
  const claims = createClaimService({
    db: h.db,
    config: h.config,
    orca: h.orca,
    jj: h.jj,
    env: h.env,
    trustProvision: h.trust.provision,
    stepTimeoutMs: h.stepTimeoutMs,
  });
  const claim = await claims.claim(COORD_SESSION, { taskId });
  await claims.accept({ taskId, claimId: claim.claimId, tokenClaimId: claim.claimId, session: EXEC_SESSION });
  const ws = h.db
    .prepare('SELECT w.host_path, w.env_instance_id FROM workspaces w WHERE w.workspace_id = ?')
    .get(claim.workspace.workspaceId) as { host_path: string; env_instance_id: string } | undefined;
  assert.ok(ws !== undefined, '认领工作区行缺失');
  return {
    taskId,
    claimId: claim.claimId,
    devWsPath: String(ws.host_path),
    devEnvId: String(ws.env_instance_id),
    executorDispatchId: claim.dispatchId,
  };
}

/** 铺到 REVIEW_REQUESTED：submit（默认清单，可覆盖）。 */
export async function submitForReview(
  h: ReviewHost,
  task: { readonly taskId: string; readonly claimId: string },
  manifest: readonly EvidenceItem[] = defaultManifest(),
): Promise<{ submissionId: string; commitId: string }> {
  const result = await makeSubmissionService(h).submit({
    taskId: task.taskId,
    claimId: task.claimId,
    tokenClaimId: task.claimId,
    session: EXEC_SESSION,
    evidenceManifest: manifest,
  });
  if (!isSubmitAccepted(result)) {
    throw new Error(`submit 不应要求 rebase: ${JSON.stringify(result)}`);
  }
  return { submissionId: result.submissionId, commitId: result.commitId };
}

export interface InReview {
  readonly taskId: string;
  readonly claimId: string;
  readonly reviewId: string;
  readonly submissionId: string;
  readonly commitId: string;
  readonly reviewWsPath: string;
  readonly reviewEnvId: string;
  readonly reviewerDispatchId: string;
}

/** 铺到 IN_REVIEW：submit → onMergeReady → review-accept。 */
export async function setupInReview(
  h: ReviewHost,
  spec: Record<string, unknown> = sampleReviewSpec(),
): Promise<{ task: ActiveTask; review: InReview }> {
  const task = await setupActiveTask(h, spec);
  const submission = await submitForReview(h, task);
  const session = await makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' });
  await makeReviewService(h).reviewAccept({
    taskId: task.taskId,
    reviewId: session.reviewId,
    tokenReviewId: session.reviewId,
    session: session.reviewerCapabilityId ?? 'reviewer',
  });
  const reviewWs = h.db
    .prepare('SELECT w.host_path, w.env_instance_id FROM workspaces w WHERE w.workspace_id = ?')
    .get(session.workspaceId) as { host_path: string; env_instance_id: string } | undefined;
  assert.ok(reviewWs !== undefined, '评审工作区行缺失');
  return {
    task,
    review: {
      taskId: task.taskId,
      claimId: task.claimId,
      reviewId: session.reviewId,
      submissionId: submission.submissionId,
      commitId: submission.commitId,
      reviewWsPath: String(reviewWs.host_path),
      reviewEnvId: String(reviewWs.env_instance_id),
      reviewerDispatchId: session.dispatchId,
    },
  };
}

/** 开一张人工验收回执（宿主侧 manual-approve 全真路径）。 */
export function approveManual(
  h: ReviewHost,
  taskId: string,
  criterionId: string,
): string {
  return manualApprove(
    { db: h.db },
    { taskId, criterionId, session: OPERATOR_SESSION, note: '操作员人工核验通过' },
  ).manualDecisionId;
}

/** 与 sampleReviewSpec 对齐的全量评审证据（manual 回执需先开）。 */
export function fullReviewEvidence(
  manualDecisionId: string,
  overrides: { readonly artHash?: string; readonly cmdExit?: number } = {},
): EvidenceItem[] {
  return [
    { criterionId: 'cmd-1', exitCode: overrides.cmdExit ?? 0 },
    { criterionId: 'art-1', artifactHash: overrides.artHash ?? 'hash-art-1' },
    { criterionId: 'man-1', manualDecisionId },
  ];
}

export async function expectGovError(
  promise: Promise<unknown>,
  code: string,
  messageNeedle?: string,
): Promise<GovError> {
  let threw: unknown;
  try {
    await promise;
  } catch (err) {
    threw = err;
  }
  if (!(threw instanceof GovError)) {
    throw new Error(`预期 GovError(${code})，实际: ${String(threw)}`);
  }
  if (threw.code !== code) {
    throw new Error(`预期错误码 ${code}，实际 ${threw.code}: ${threw.message}`);
  }
  if (messageNeedle !== undefined && !threw.message.includes(messageNeedle)) {
    throw new Error(`错误 message 不含 "${messageNeedle}": ${threw.message}`);
  }
  return threw;
}

/** 任务当前状态（一行查询助手）。 */
export function taskStatus(h: ReviewHost, taskId: string): string {
  return String(h.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status);
}

export function blockedReason(h: ReviewHost, taskId: string): string | null {
  const value = h.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason;
  return value === null || value === undefined ? null : String(value);
}

/** 任务的 type 类审计事件载荷清单（断言意图/审计用）。 */
export function taskEvents(
  h: ReviewHost,
  taskId: string,
  type: string,
): Array<Record<string, unknown>> {
  return h.db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq ASC')
    .all(taskId, type)
    .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
}
