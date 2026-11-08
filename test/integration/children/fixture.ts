/**
 * T4.2 父子任务集成测试共享夹具（test/integration/children/）。
 *
 * 真实面与 lifecycle 夹具同规：真实 jj（0.41）/ 真实 Docker 环境 / 真实 Orca
 * CLI + 临时 gov 库；工作文件由测试自写模拟开发。本文件自持 SharedContext
 *（独立 Run），不与 lifecycle/recovery 共用——T4.1 报告遗留观察：并发集成文件
 * 争用共享协调者终端的 Run 绑定会触发 consumer_fenced 误报；本目录按「每场景
 * 独立 rail」构建并在 after() 回基准。
 *
 * 在 lifecycle 夹具之上追加三类 T4.2 专用件：
 * 1. ChildEnv——suspend 失败注入（父环境暂停失败场景）；
 * 2. ChildAdvanceJj——JjChildAdvancePort 的真实 jj CLI 实现（isAncestorOrEqual
 *    用 `a::b` 区间非空判定、advanceWorkingCopy 用 `jj edit -r`——T3.3 评审
 *    工作区夹具同口径；T2.2 适配器面无此动词，生产接线归 T6.x）；
 * 3. 子任务书构造与子任务驱动（accept → 写文件 → submit → 评审真实走）。
 *
 * Orca worker 仅作 dispatch 载体（启动后即被 workerStop 结算，最小真实模型
 * 用量；opencode 本机 readiness 超时，claude 为 T2.1 已验证路径）。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { GovConfig } from '../../../src/config.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import { GovError } from '../../../src/domain/errors.ts';
import type { JjAdapter } from '../../../src/adapters/jj.ts';
import { createJjAdapter } from '../../../src/adapters/jj.ts';
import { createEnvironmentAdapter, type SuspendReceipt } from '../../../src/adapters/environment.ts';
import { createOrcaAdapter, predictWorktreePath, type OrcaAdapter } from '../../../src/adapters/orca.ts';
import type { JjChildAdvancePort, JjFactsPort, JjMergePort } from '../../../src/services/ports.ts';
import { createChildrenService, type SplitResult } from '../../../src/services/children.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { createSubmissionService, isSubmitAccepted } from '../../../src/services/submissions.ts';
import { createReviewService } from '../../../src/services/reviews.ts';
import { manualApprove } from '../../../src/services/evidence.ts';
import type { TrustHandle, TrustProvision } from '../../../src/services/ports.ts';
import {
  CountingJj,
  DispatchOrcaShim,
  EXEC_SESSION,
  InjectingEnv,
  OPERATOR_SESSION,
  dockerBin,
  dockerPsNames,
  envExists,
  execJj,
  expectGovError,
  rawCommitId,
  sha256,
} from '../lifecycle/fixture.ts';

const execFileAsync = promisify(execFile);

export const STAMP = `${Date.now()}`;
export const noOpTrust: TrustProvision = async (): Promise<TrustHandle> => ({ cleanup: async () => {} });
export { EXEC_SESSION, OPERATOR_SESSION, envExists, execJj, rawCommitId, sha256, dockerPsNames };
export const expectGovErrorLike = expectGovError;

/** 任务事件读取（同 lifecycle 口径，按本目录 SharedContext 类型收窄）。 */
export function taskEvents(shared: ChildrenSharedContext, taskId: string, type: string): Array<Record<string, unknown>> {
  return shared.db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq ASC')
    .all(taskId, type)
    .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// 环境注入包装：suspend 失败注入（父环境暂停失败场景）
// ---------------------------------------------------------------------------

export class ChildEnv extends InjectingEnv {
  readonly failSuspendFor = new Set<string>();

  async suspend(envId: string): Promise<SuspendReceipt> {
    if (this.failSuspendFor.has(envId)) {
      throw new GovError('E_ENV_LIFECYCLE_FAILED', `注入的 suspend 失败(集成测试): ${envId}`);
    }
    return super.suspend(envId);
  }
}

// ---------------------------------------------------------------------------
// JjChildAdvancePort 的真实 jj CLI 实现（适配器面外动词；探针实证：
// `a::b` 非空 ⟺ a 是 b 的祖先或相等；被 forget 的工作区提交仍可寻址）
// ---------------------------------------------------------------------------

export class ChildAdvanceJj implements JjChildAdvancePort {
  private readonly repoDir: string;

  constructor(repoDir: string) {
    this.repoDir = repoDir;
  }

  async isAncestorOrEqual(input: {
    readonly ancestor: string;
    readonly descendant: string;
  }): Promise<{ ok: true; result: boolean }> {
    const { stdout } = await execJj(this.repoDir, [
      'log',
      '-r',
      `${input.ancestor}::${input.descendant}`,
      '--no-graph',
      '-T',
      'commit_id ++ "\\n"',
    ]);
    return { ok: true, result: stdout.trim().length > 0 };
  }

  async advanceWorkingCopy(input: {
    readonly dir: string;
    readonly rev: string;
    readonly expectedCurrent: string;
  }): Promise<{ ok: true; commitId: string; opIds: string[] }> {
    const current = await rawCommitId(input.dir, '@');
    if (current !== input.expectedCurrent) {
      throw new GovError(
        'E_JJ_TARGET_MOVED',
        `父工作副本已不在锁定版本(${current} ≠ ${input.expectedCurrent})，拒绝快进`,
      );
    }
    await execJj(input.dir, ['edit', '-r', input.rev]);
    const after = await rawCommitId(input.dir, '@');
    if (after !== input.rev) {
      throw new GovError('E_JJ_SCHEMA', `jj edit 后工作副本未到目标(${after} ≠ ${input.rev})`);
    }
    const { stdout } = await execJj(input.dir, ['op', 'log', '-n', '3', '--no-graph', '-T', 'id ++ "\\n"']);
    return {
      ok: true,
      commitId: after,
      opIds: stdout.trim().split('\n').filter((line) => line.length > 0),
    };
  }
}

// ---------------------------------------------------------------------------
// 轨道（rail）：一场景 = 一临时仓 + 一父任务 + 一组服务依赖
// ---------------------------------------------------------------------------

export interface ChildrenSharedContext {
  readonly stamp: string;
  readonly db: DatabaseSync;
  readonly envReal: ReturnType<typeof createEnvironmentAdapter>;
  readonly env: ChildEnv;
  readonly orcaReal: OrcaAdapter;
  readonly runId: string;
  readonly rails: ChildrenRail[];
  readonly tmpRoots: string[];
}

export interface ChildrenRail {
  readonly scenario: string;
  readonly tmpRoot: string;
  readonly repoDir: string;
  readonly repoDirReal: string;
  readonly orcaRepoId: string;
  readonly repoDisplayName: string;
  readonly config: GovConfig;
  readonly jj: CountingJj;
  readonly orca: DispatchOrcaShim;
  /** resumeParent 经真实 Orca 发出的恢复消息（sendToDispatch 记录）。 */
  readonly sentMessages: Array<{ dispatch: string; subject: string; body: string }>;
  readonly parentTaskId: string;
  readonly repoId: string;
  readonly baseCommit: string;
}

export async function createChildrenSharedContext(): Promise<ChildrenSharedContext> {
  const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t42it-${STAMP}-shared-`));
  const db = openDatabase(join(tmpRoot, 'gov.db'));
  migrate(db);
  const envReal = createEnvironmentAdapter({ repoRoot: join(import.meta.dirname, '..', '..', '..') });
  const env = new ChildEnv(envReal);
  const orcaReal = createOrcaAdapter();
  await orcaReal.doctor();
  const run = await orcaReal.runCreate(`gov-t42it-${STAMP} 父子任务集成`);
  return { stamp: STAMP, db, envReal, env, orcaReal, runId: run.raw.run.id, rails: [], tmpRoots: [tmpRoot] };
}

export async function buildChildrenRail(shared: ChildrenSharedContext, scenario: string): Promise<ChildrenRail> {
  const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t42it-${STAMP}-${scenario}-`));
  const repoDir = join(tmpRoot, `repo${scenario}`);
  await execJj(tmpRoot, ['git', 'init', '--colocate', repoDir]);
  fs.mkdirSync(join(repoDir, 'src', 'a'), { recursive: true });
  fs.writeFileSync(join(repoDir, 'src', 'a', 'keep.txt'), 'base\n');
  await execJj(repoDir, ['commit', '-m', 'init']);
  const baseCommit = await rawCommitId(repoDir, '@-');
  await execJj(repoDir, ['bookmark', 'create', 'main', '-r', baseCommit]);

  const repoDirReal = fs.realpathSync(repoDir);
  // 与 recovery 夹具同规：hostPath 归一到 realpath，保证回滚删除的 startsWith
  // 守卫可命中（/tmp → /private/tmp）。
  const repoId = `it-${scenario}`;
  const config: GovConfig = {
    schemaVersion: 1,
    repos: [{ repoId, hostPath: repoDirReal, targets: ['main'] }],
    archiveRoot: join(tmpRoot, 'archive'),
  };
  const jj = new CountingJj(createJjAdapter({ repoRoot: repoDir, config }));
  const added = await shared.orcaReal.repoAdd(repoDirReal);
  const orcaRepoId = added.raw.repo.id;
  const repoDisplayName = added.raw.repo.displayName ?? `repo${scenario}`;
  const orca = new DispatchOrcaShim(shared.orcaReal, repoDirReal, repoDisplayName);
  const sentMessages: Array<{ dispatch: string; subject: string; body: string }> = [];
  const originalSend = orca.sendToDispatch.bind(orca);
  (orca as unknown as { sendToDispatch: typeof orca.sendToDispatch }).sendToDispatch = async (input) => {
    sentMessages.push({ dispatch: input.dispatch, subject: input.subject, body: input.body });
    return originalSend(input);
  };
  const rail: ChildrenRail = {
    scenario,
    tmpRoot,
    repoDir,
    repoDirReal,
    orcaRepoId,
    repoDisplayName,
    config,
    jj,
    orca,
    sentMessages,
    parentTaskId: `gt-t42-${scenario}-p`,
    repoId,
    baseCommit,
  };
  shared.rails.push(rail);
  shared.tmpRoots.push(tmpRoot);
  return rail;
}

/** jj 合成端口：CountingJj（计数/编辑钩子）+ ChildAdvanceJj + workspaceList 事实面。 */
export function childrenJj(rail: ChildrenRail): JjMergePort & JjChildAdvancePort & JjFactsPort {
  const real = (rail.jj as unknown as { real: JjAdapter }).real;
  const advance = new ChildAdvanceJj(rail.repoDir);
  const wrapper = Object.create(rail.jj) as JjMergePort & JjChildAdvancePort & JjFactsPort;
  const record = wrapper as unknown as Record<string, unknown>;
  record['isAncestorOrEqual'] = advance.isAncestorOrEqual.bind(advance);
  record['advanceWorkingCopy'] = advance.advanceWorkingCopy.bind(advance);
  record['workspaceList'] = () => real.workspaceList();
  return wrapper;
}

export function childrenServiceFor(rail: ChildrenRail, shared: ChildrenSharedContext) {
  return createChildrenService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: childrenJj(rail),
    env: shared.env,
    // 与 lifecycle driveToActive 同规：执行派工走 Orca new-child 工作树（Shim
    // 自带信任种子），gov 工作区的宿主信任预置以 noOp 注入，不写 ~/.claude.json。
    trustProvision: noOpTrust,
    stepTimeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// 父任务与子任务驱动
// ---------------------------------------------------------------------------

export interface ParentActive {
  readonly claimId: string;
  readonly dispatchId: string;
  readonly workspaceId: string;
  readonly parentWsPath: string;
  readonly parentEnvId: string;
}

/**
 * 父任务铺到 ACTIVE（声明→认领→接受）。默认走 worker 消失路径（启动后立即
 * workerStop 结算，最小真实模型用量）；keepDispatchAlive 时保留活派工——
 * Orca 对已结算派工拒发消息（dispatch_inactive「其 worker 永不读该邮箱」，
 * 首轮实测），恢复消息送达断言的场景用活派工。
 */
export async function driveParentActive(
  rail: ChildrenRail,
  shared: ChildrenSharedContext,
  options: { readonly keepDispatchAlive?: boolean } = {},
): Promise<ParentActive> {
  const { declareTask } = await import('../../../src/services/tasks.ts');
  await declareTask(
    { db: shared.db, config: rail.config, orca: rail.orca },
    { spec: parentSpecFor(rail), session: 'gov-it-decl' },
  );
  const claims = createClaimService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    trustProvision: noOpTrust,
    stepTimeoutMs: 120_000,
  });
  const claim = await claims.claim('gov-it-coord', { taskId: rail.parentTaskId });
  if (options.keepDispatchAlive !== true) {
    await rail.orca.workerStop(claim.dispatchId);
  }
  await claims.accept({
    taskId: rail.parentTaskId,
    claimId: claim.claimId,
    tokenClaimId: claim.claimId,
    session: EXEC_SESSION,
  });
  const ws = shared.db
    .prepare('SELECT host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(claim.workspace.workspaceId) as { host_path: string; env_instance_id: string } | undefined;
  if (ws === undefined) {
    throw new Error('父任务工作区行缺失');
  }
  return {
    claimId: claim.claimId,
    dispatchId: claim.dispatchId,
    workspaceId: claim.workspace.workspaceId,
    parentWsPath: String(ws.host_path),
    parentEnvId: String(ws.env_instance_id),
  };
}

export function parentSpecFor(rail: ChildrenRail): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: rail.parentTaskId,
    problem: `T4.2 父任务 ${rail.scenario}`,
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不改 src/b'],
    ownedPaths: ['src/a', 'out'],
    repoId: rail.repoId,
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: rail.baseCommit,
    acceptanceCriteria: [
      {
        type: 'command',
        criterionId: 'cmd-1',
        config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
      },
      { type: 'manual', criterionId: 'man-1', config: { description: '人工核验收尾' } },
    ],
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 3, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
  };
}

export function childSpecFor(input: {
  readonly scenario: string;
  readonly repoId: string;
  readonly parentTaskId: string;
  readonly parentRevision: string;
  readonly gen?: string;
  readonly ownedPaths?: readonly string[];
  readonly baseCommitId?: string;
}): Record<string, unknown> {
  const gen = input.gen ?? 'c1';
  return {
    schemaVersion: 1,
    taskId: `gt-t42-${input.scenario}-${gen}`,
    problem: `T4.2 子任务 ${input.scenario}/${gen}`,
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不改父任务范围外文件'],
    ownedPaths: input.ownedPaths ?? ['src/a', 'out'],
    repoId: input.repoId,
    target: { kind: 'parent-claim', parentClaimId: input.parentTaskId },
    baseCommitId: input.baseCommitId ?? input.parentRevision,
    acceptanceCriteria: [
      {
        type: 'command',
        criterionId: 'cmd-1',
        config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
      },
      {
        type: 'artifact',
        criterionId: 'art-1',
        config: { path: 'out/report-child.md', minBytes: 1, maxBytes: 1_048_576 },
      },
      { type: 'manual', criterionId: 'man-1', config: { description: '人工核验收尾' } },
    ],
    parentTaskId: input.parentTaskId,
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 3, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
  };
}

export interface ChildWorkspace {
  readonly childWsPath: string;
  readonly childEnvId: string;
}

/** 子任务铺到 ACTIVE：接受认领（父环境此时已暂停；子环境独立可写）。 */
export async function driveChildActive(
  rail: ChildrenRail,
  shared: ChildrenSharedContext,
  split: SplitResult,
): Promise<ChildWorkspace> {
  const claims = createClaimService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    trustProvision: noOpTrust,
    stepTimeoutMs: 120_000,
  });
  await claims.accept({
    taskId: split.childTaskId,
    claimId: split.childClaimId,
    tokenClaimId: split.childClaimId,
    session: EXEC_SESSION,
  });
  // worker 消失路径：子派工启动后立即结算（最小真实模型用量）。
  await rail.orca.workerStop(split.childDispatchId);
  const ws = shared.db
    .prepare(
      'SELECT w.host_path, w.env_instance_id FROM claims c JOIN workspaces w ON c.workspace_id = w.workspace_id WHERE c.claim_id = ?',
    )
    .get(split.childClaimId) as { host_path: string; env_instance_id: string } | undefined;
  if (ws === undefined) {
    throw new Error('子任务工作区行缺失');
  }
  return { childWsPath: String(ws.host_path), childEnvId: String(ws.env_instance_id) };
}

export interface ChildRound {
  readonly submissionId: string;
  readonly commitId: string;
  readonly artHash: string;
  readonly reviewId: string;
  readonly taskStatus: string;
}

/**
 * 子任务一轮开发+评审：写文件（真实 jj 快照）→ submit → onMergeReady →
 * reviewAccept → manual → reviewSubmit（approved 或 changes_requested）。
 */
export async function childRound(
  rail: ChildrenRail,
  shared: ChildrenSharedContext,
  child: { readonly taskId: string; readonly claimId: string },
  wsPath: string,
  phase: string,
  verdict: 'approved' | 'changes_requested',
): Promise<ChildRound> {
  fs.writeFileSync(join(wsPath, 'src', 'a', `child-${phase}.ts`), `export const phase = '${phase}';\n`);
  const report = `# child ${phase}\n${STAMP}\n`;
  fs.mkdirSync(join(wsPath, 'out'), { recursive: true });
  fs.writeFileSync(join(wsPath, 'out', 'report-child.md'), report);
  const artHash = sha256(report);

  const submissions = createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj, stepTimeoutMs: 120_000 });
  const submitted = await submissions.submit({
    taskId: child.taskId,
    claimId: child.claimId,
    tokenClaimId: child.claimId,
    session: EXEC_SESSION,
    evidenceManifest: [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: artHash },
    ],
  });
  if (!isSubmitAccepted(submitted)) {
    throw new Error(`子任务 submit 不应要求 rebase: ${JSON.stringify(submitted)}`);
  }

  rail.jj.armEditOnNextRevAdd = true;
  const reviews = createReviewService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    stepTimeoutMs: 120_000,
  });
  const session = await reviews.onMergeReady({ taskId: child.taskId, session: 'gov-poll' });
  await reviews.reviewAccept({
    taskId: child.taskId,
    reviewId: session.reviewId,
    tokenReviewId: session.reviewId,
    session: session.reviewerCapabilityId ?? 'reviewer',
  });
  const manual = manualApprove(
    { db: shared.db },
    { taskId: child.taskId, criterionId: 'man-1', session: OPERATOR_SESSION, note: 'T4.2 集成人工核验' },
  );
  const result = await reviews.reviewSubmit({
    taskId: child.taskId,
    reviewId: session.reviewId,
    tokenReviewId: session.reviewId,
    session: session.reviewerCapabilityId ?? 'reviewer',
    payload: {
      verdict,
      ...(verdict === 'changes_requested' ? { reasonClass: 'code' as const } : {}),
      findings: [],
      evidence: [
        { criterionId: 'cmd-1', exitCode: 0 },
        { criterionId: 'art-1', artifactHash: artHash },
        { criterionId: 'man-1', manualDecisionId: manual.manualDecisionId },
      ],
      reportRef: `gov-it://${child.taskId}/review-${phase}`,
    },
  });
  return {
    submissionId: submitted.submissionId,
    commitId: submitted.commitId,
    artHash,
    reviewId: session.reviewId,
    taskStatus: result.taskStatus,
  };
}

// ---------------------------------------------------------------------------
// 查询/断言助手
// ---------------------------------------------------------------------------

export function taskStatusOf(shared: ChildrenSharedContext, taskId: string): string {
  return String(shared.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status);
}

export function blockedReasonOf(shared: ChildrenSharedContext, taskId: string): string | null {
  const value = shared.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason;
  return value === null || value === undefined ? null : String(value);
}

export function claimStatusOf(shared: ChildrenSharedContext, claimId: string): string {
  return String(shared.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status);
}

export function opStatusOf(shared: ChildrenSharedContext, requestId: string): string | null {
  const value = shared.db.prepare('SELECT status FROM operations WHERE request_id = ?').get(requestId)?.status;
  return value === null || value === undefined ? null : String(value);
}

export function opReceiptOf(shared: ChildrenSharedContext, requestId: string): Record<string, unknown> | null {
  const row = shared.db.prepare('SELECT receipt_json FROM operations WHERE request_id = ?').get(requestId);
  if (row === undefined || row.receipt_json === null) {
    return null;
  }
  return JSON.parse(String(row.receipt_json)) as Record<string, unknown>;
}

/** 容器 paused 状态（docker inspect；容器缺失即抛——断言场景应先确认存在）。 */
export async function dockerPaused(envId: string): Promise<boolean> {
  const { stdout } = await execFileAsync(dockerBin(), ['inspect', '--format', '{{.State.Paused}}', envId], {
    timeout: 30_000,
    encoding: 'utf8',
  });
  return stdout.trim() === 'true';
}

export async function jjWorkspaceNames(rail: ChildrenRail): Promise<string[]> {
  const { stdout } = await execJj(rail.repoDir, ['workspace', 'list', '-T', 'name ++ "\\n"']);
  return stdout.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
}

export { predictWorktreePath };
