/**
 * 提交服务与任务收尾出口（T3.2 submit / task fail / task cancel，设计 §6.2/§8.2）。
 *
 * submit 固定顺序（简报口径）：snapshot 锚定版本 →（同 claim 同 commit 的重复
 * 提交幂等返回原回执）→ 状态门（ACTIVE/CHANGES_REQUESTED）→ 路径范围 → 冲突
 * 残留 → 目标漂移（漂移不报错，返回 requiresRebase 让执行者先走 rebase）→
 * 原子写 submissions 行 + submit 迁移进 REVIEW_REQUESTED，立即返回回执。
 * 回执经 T1.3 信封（requestId 幂等）落 operations；服务自身不再阻塞任何外部步骤。
 *
 * 状态迁移一律走 T1.2 applyTaskTransition；本模块与 services/ 全目录禁止
 * import node:child_process，一切外部动作经注入端口。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import { evidenceItemSchema, type EvidenceItem } from './evidence.ts';
import type { JjVersionPort } from './ports.ts';
import { loadDeclaredSpec } from './tasks.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

const SUBMISSION_ID_PREFIX = 'gsu_';

/** rebase 审计事件 type 值（submit 的目标漂移判定按此读取最近已知目标）。 */
export const TASK_REBASE_EVENT_TYPE = 'task_rebase';

/** 清理意图事件 type 值：T3.3 清理执行器消费，本层只发意图不执行。 */
export const CLEANUP_INTENT_EVENT_TYPE = 'cleanup_intent';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 键序无关的稳定序列化（与 operations.canonicalRequestHash 同一算法）。 */
export function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeysDeep(value));
}

export function recordTaskEvent(
  db: DatabaseSync,
  taskId: string,
  type: string,
  actor: string,
  payload: unknown,
): void {
  const json = JSON.stringify(payload);
  db.prepare(
    'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, type, actor, json, sha256Hex(json), new Date().toISOString());
}

/** 单个外部步骤的 in-process 超时上限（与 claims 同规：先于宿主 30s 信封超时）。 */
export function withStepTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GovError('E_TIMEOUT', `外部步骤超时(${stage}, ${ms}ms)`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** T3.3 清理意图：只记录待回收资源，不执行任何销毁。 */
export function recordCleanupIntent(
  db: DatabaseSync,
  taskId: string,
  actor: string,
  payload: {
    readonly reason: string;
    readonly claim?: { readonly claimId: string; readonly workspaceId: string | null; readonly envInstanceId: string | null } | undefined;
    readonly review?: { readonly reviewId: string; readonly workspaceId: string | null; readonly envInstanceId: string | null; readonly dispatchId: string | null } | undefined;
  },
): void {
  recordTaskEvent(db, taskId, CLEANUP_INTENT_EVENT_TYPE, actor, payload);
}

// ---------------------------------------------------------------------------
// 查询助手（events 为真源的口径与 T3.1 适配一致）
// ---------------------------------------------------------------------------

export interface SubmissionRow {
  readonly submissionId: string;
  readonly claimId: string;
  readonly commitId: string;
  readonly treeId: string | null;
  readonly createdAt: string;
}

/** 被 rebase 作废的 submission id 集合（task_rebase 事件 supersededSubmissionIds）。 */
export function supersededSubmissionIds(db: DatabaseSync, taskId: string): Set<string> {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
    .all(taskId, TASK_REBASE_EVENT_TYPE);
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as { supersededSubmissionIds?: unknown };
      if (Array.isArray(payload.supersededSubmissionIds)) {
        for (const id of payload.supersededSubmissionIds) {
          if (typeof id === 'string') {
            ids.add(id);
          }
        }
      }
    } catch {
      // 单条损坏事件不阻断判定：未列入集合的提交仍按有效处理。
    }
  }
  return ids;
}

/** 最新未作废提交（无则 undefined）。按插入序取最大，同秒提交也有稳定全序。 */
export function latestActiveSubmission(db: DatabaseSync, taskId: string): SubmissionRow | undefined {
  const rows = db
    .prepare(
      `SELECT s.rowid AS rid, s.submission_id, s.claim_id, s.commit_id, s.tree_id, s.created_at
         FROM submissions s JOIN claims c ON s.claim_id = c.claim_id
        WHERE c.task_id = ? ORDER BY s.rowid DESC`,
    )
    .all(taskId);
  const superseded = supersededSubmissionIds(db, taskId);
  for (const row of rows) {
    if (!superseded.has(String(row.submission_id))) {
      return {
        submissionId: String(row.submission_id),
        claimId: String(row.claim_id),
        commitId: String(row.commit_id),
        treeId: row.tree_id === null ? null : String(row.tree_id),
        createdAt: String(row.created_at),
      };
    }
  }
  return undefined;
}

/**
 * 最近已知目标 commit：最近一次 task_rebase 的 newBase，无 rebase 记录时退回
 * 任务书 baseCommitId。submit 的漂移判定接受「声明基线或最近 rebase 基线」。
 */
export function lastKnownTargetCommit(db: DatabaseSync, taskId: string, fallback: string): string {
  const row = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1')
    .get(taskId, TASK_REBASE_EVENT_TYPE);
  if (row === undefined) {
    return fallback;
  }
  try {
    const payload = JSON.parse(String(row.payload_json)) as { newBase?: unknown };
    return typeof payload.newBase === 'string' && payload.newBase.length > 0 ? payload.newBase : fallback;
  } catch {
    return fallback;
  }
}

/** 执行者工作区事实：当前认领 → workspace（host_path 与挂载环境）。 */
export function loadDevWorkspace(
  db: DatabaseSync,
  taskId: string,
): { claimId: string; dispatchId: string | null; workspaceId: string; hostPath: string; envInstanceId: string | null } {
  const task = db.prepare('SELECT current_claim_id FROM tasks WHERE task_id = ?').get(taskId);
  const claimId = task?.current_claim_id;
  if (claimId === undefined || claimId === null) {
    throw new GovError('E_SUBMIT_INVALID', `任务无当前认领: ${taskId}`);
  }
  const claim = db
    .prepare('SELECT task_id, status, dispatch_id, workspace_id FROM claims WHERE claim_id = ?')
    .get(String(claimId));
  if (claim === undefined || String(claim.task_id) !== taskId) {
    throw new GovError('E_SUBMIT_INVALID', `当前认领不属于该任务: ${String(claimId)}`);
  }
  if (claim.workspace_id === null) {
    throw new GovError('E_SUBMIT_INVALID', `当前认领未绑定工作区: ${String(claimId)}`);
  }
  const ws = db
    .prepare('SELECT host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(String(claim.workspace_id));
  if (ws === undefined) {
    throw new GovError('E_SUBMIT_INVALID', `认领工作区行缺失: ${String(claim.workspace_id)}`);
  }
  return {
    claimId: String(claimId),
    dispatchId: claim.dispatch_id === null ? null : String(claim.dispatch_id),
    workspaceId: String(claim.workspace_id),
    hostPath: String(ws.host_path),
    envInstanceId: ws.env_instance_id === null ? null : String(ws.env_instance_id),
  };
}

// ---------------------------------------------------------------------------
// submit
// ---------------------------------------------------------------------------

export interface SubmissionServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly jj: JjVersionPort;
  readonly stepTimeoutMs?: number | undefined;
}

export interface SubmitInput {
  readonly taskId: string;
  readonly claimId: string;
  /** executor 令牌绑定的认领；必须与 claimId 一致（与 accept 同口径）。 */
  readonly tokenClaimId: string | null;
  readonly session: string;
  readonly evidenceManifest: readonly EvidenceItem[];
}

export interface SubmitAccepted {
  readonly taskId: string;
  readonly submissionId: string;
  readonly claimId: string;
  readonly commitId: string;
  readonly treeId: string;
  readonly taskStatus: 'REVIEW_REQUESTED';
  /** 同 claim 同 commit 重复提交：返回原回执且不再迁移。 */
  readonly idempotentReplay: boolean;
}

export interface SubmitRequiresRebase {
  readonly taskId: string;
  readonly requiresRebase: true;
  readonly currentTarget: string;
  readonly expectedBase: string;
}

export type SubmitResult = SubmitAccepted | SubmitRequiresRebase;

/** 目标未漂移的提交回执（调用方分支 narrowing 用）。 */
export function isSubmitAccepted(result: SubmitResult): result is SubmitAccepted {
  return !('requiresRebase' in result);
}

export interface TaskExitResult {
  readonly taskId: string;
  readonly taskStatus: 'FAILED' | 'CANCELLED';
}

export interface SubmissionService {
  submit(input: SubmitInput): Promise<SubmitResult>;
  fail(input: { taskId: string; session: string; reason?: string | undefined }): Promise<TaskExitResult>;
  cancel(input: { taskId: string; session: string; reason?: string | undefined }): Promise<TaskExitResult>;
}

export function createSubmissionService(deps: SubmissionServiceDeps): SubmissionService {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;

  /** 认领资源的清理意图载荷（workspace 可能尚未绑定/env 可能未建，均如实置空）。 */
  function claimCleanupPayload(claimId: string): { claimId: string; workspaceId: string | null; envInstanceId: string | null } {
    const row = db.prepare('SELECT workspace_id FROM claims WHERE claim_id = ?').get(claimId);
    const workspaceId = row?.workspace_id;
    if (workspaceId === undefined || workspaceId === null) {
      return { claimId, workspaceId: null, envInstanceId: null };
    }
    const ws = db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(String(workspaceId));
    return {
      claimId,
      workspaceId: String(workspaceId),
      envInstanceId: ws?.env_instance_id === null || ws?.env_instance_id === undefined ? null : String(ws.env_instance_id),
    };
  }

  /** 在飞评审的清理意图载荷（最新提交的最新评审行；无则 undefined）。 */
  function reviewCleanupPayload(
    submissionId: string,
  ): { reviewId: string; workspaceId: string | null; envInstanceId: string | null; dispatchId: string | null } | undefined {
    const review = db
      .prepare(
        'SELECT review_id, workspace_id, dispatch_id FROM reviews WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(submissionId);
    if (review === undefined) {
      return undefined;
    }
    const workspaceId = review.workspace_id;
    const ws = workspaceId === null ? undefined : db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(String(workspaceId));
    return {
      reviewId: String(review.review_id),
      workspaceId: workspaceId === null ? null : String(workspaceId),
      envInstanceId: ws?.env_instance_id === null || ws?.env_instance_id === undefined ? null : String(ws.env_instance_id),
      dispatchId: review.dispatch_id === null ? null : String(review.dispatch_id),
    };
  }

  async function submit(input: SubmitInput): Promise<SubmitResult> {
    if (input.tokenClaimId === null || input.tokenClaimId !== input.claimId) {
      throw new GovError(
        'E_SUBMIT_INVALID',
        `令牌未绑定该认领(令牌绑定 ${input.tokenClaimId ?? '无'}, 请求 ${input.claimId})`,
      );
    }
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const claim = db
      .prepare('SELECT task_id, status FROM claims WHERE claim_id = ?')
      .get(input.claimId);
    if (claim === undefined || String(claim.task_id) !== input.taskId) {
      throw new GovError('E_SUBMIT_INVALID', `认领不属于该任务: ${input.claimId}`);
    }
    if (String(claim.status) !== 'ACTIVE') {
      throw new GovError('E_SUBMIT_INVALID', `认领状态 ${String(claim.status)} 不可提交(须 ACTIVE): ${input.claimId}`);
    }
    const dev = loadDevWorkspace(db, input.taskId);
    if (dev.claimId !== input.claimId) {
      throw new GovError('E_SUBMIT_INVALID', `认领不是任务当前认领: ${input.claimId}`);
    }
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);

    // 第 1 步：版本锚定。快照同时触发脏工作副本落盘，commitId 即本次受审版本。
    const snap = await withStepTimeout(
      deps.jj.snapshot(dev.hostPath),
      stepTimeoutMs,
      'submit_snapshot',
    );

    // 幂等门（先于状态门）：同 claim 同 commit 的重复提交原样返回首次回执。
    const existing = db
      .prepare('SELECT submission_id, tree_id, created_at FROM submissions WHERE claim_id = ? AND commit_id = ?')
      .get(input.claimId, snap.commitId);
    if (existing !== undefined) {
      return {
        taskId: input.taskId,
        submissionId: String(existing.submission_id),
        claimId: input.claimId,
        commitId: snap.commitId,
        treeId: existing.tree_id === null ? snap.treeId : String(existing.tree_id),
        taskStatus: 'REVIEW_REQUESTED',
        idempotentReplay: true,
      };
    }

    if (String(task.status) !== 'ACTIVE' && String(task.status) !== 'CHANGES_REQUESTED') {
      throw new GovError(
        'E_SUBMIT_INVALID',
        `任务状态 ${String(task.status)} 不可提交(须 ACTIVE 或 CHANGES_REQUESTED): ${input.taskId}`,
      );
    }

    // 第 2 步：路径范围（越界由适配器以 E_JJ_PATH_OUT_OF_SCOPE 拒绝，状态不动）。
    await withStepTimeout(
      deps.jj.diffPaths(snap.commitId, spec.ownedPaths),
      stepTimeoutMs,
      'submit_diff_paths',
    );

    // 第 3 步：冲突残留（rebase 后未解决场景，提交即拒）。
    const conflicts = await withStepTimeout(
      deps.jj.conflictList(snap.commitId),
      stepTimeoutMs,
      'submit_conflict_list',
    );
    if (conflicts.conflicts.length > 0) {
      throw new GovError(
        'E_JJ_CONFLICT',
        `提交版本仍有未解决冲突(${conflicts.conflicts.length} 处)，先解决再提交: ${input.taskId}`,
      );
    }

    // 第 4 步：目标漂移。漂移不是错误：返回 requiresRebase，任务不动。
    if (spec.target.kind === 'top-level') {
      const expected = lastKnownTargetCommit(db, input.taskId, spec.baseCommitId);
      const current = await withStepTimeout(
        deps.jj.bookmarkCurrent(spec.target.bookmark),
        stepTimeoutMs,
        'submit_bookmark_current',
      );
      if (current.commitId !== spec.baseCommitId && current.commitId !== expected) {
        return {
          taskId: input.taskId,
          requiresRebase: true,
          currentTarget: current.commitId,
          expectedBase: expected,
        };
      }
    }

    // 第 5 步：submit 迁移 + submissions 行。applyTaskTransition 自带事务边界
    // （T1.2 层不可嵌套调用），两步紧邻且中间无 await——单写入者纪律下没有交错
    // 窗口；事件载荷携带完整开发证据清单（供 review-submit 的 artifact 哈希比
    // 对），行内只存清单哈希。并发同 claim 同 commit 提交撞唯一索引时按幂等回执。
    const submissionId = SUBMISSION_ID_PREFIX + randomBytes(12).toString('base64url');
    const manifestHash = sha256Hex(canonicalJson(input.evidenceManifest));
    const transition = applyTaskTransition(db, input.taskId, 'submit', {
      actor: input.session,
      payload: {
        submissionId,
        claimId: input.claimId,
        commitId: snap.commitId,
        treeId: snap.treeId,
        evidenceManifest: input.evidenceManifest,
      },
    });
    try {
      db.prepare(
        'INSERT INTO submissions (submission_id, claim_id, commit_id, tree_id, dev_evidence_manifest_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(submissionId, input.claimId, snap.commitId, snap.treeId, manifestHash, new Date().toISOString());
    } catch (err) {
      if (errorMessage(err).includes('UNIQUE')) {
        const raced = db
          .prepare('SELECT submission_id, tree_id FROM submissions WHERE claim_id = ? AND commit_id = ?')
          .get(input.claimId, snap.commitId);
        if (raced !== undefined) {
          return {
            taskId: input.taskId,
            submissionId: String(raced.submission_id),
            claimId: input.claimId,
            commitId: snap.commitId,
            treeId: raced.tree_id === null ? snap.treeId : String(raced.tree_id),
            taskStatus: 'REVIEW_REQUESTED',
            idempotentReplay: true,
          };
        }
      }
      throw err;
    }

    return {
      taskId: input.taskId,
      submissionId,
      claimId: input.claimId,
      commitId: snap.commitId,
      treeId: snap.treeId,
      taskStatus: transition.to as 'REVIEW_REQUESTED',
      idempotentReplay: false,
    };
  }

  async function fail(input: { taskId: string; session: string; reason?: string | undefined }): Promise<TaskExitResult> {
    const task = db.prepare('SELECT status, current_claim_id FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    // 简报口径：业务失败只从 ACTIVE / CHANGES_REQUESTED 出口（在飞评审走
    // review_aborted 或 cancel 收口）；worker_done --outcome failed 的门控归 T5.1。
    if (String(task.status) !== 'ACTIVE' && String(task.status) !== 'CHANGES_REQUESTED') {
      throw new GovError(
        'E_SUBMIT_INVALID',
        `任务状态 ${String(task.status)} 不可执行 task fail(须 ACTIVE 或 CHANGES_REQUESTED): ${input.taskId}`,
      );
    }
    const transition = applyTaskTransition(db, input.taskId, 'fail', {
      actor: input.session,
      payload: { reason: input.reason ?? null },
    });
    const claimPayload = task.current_claim_id === null ? undefined : claimCleanupPayload(String(task.current_claim_id));
    recordCleanupIntent(db, input.taskId, input.session, { reason: 'task_failed', ...(claimPayload !== undefined ? { claim: claimPayload } : {}) });
    return { taskId: input.taskId, taskStatus: transition.to as 'FAILED' };
  }

  async function cancel(input: { taskId: string; session: string; reason?: string | undefined }): Promise<TaskExitResult> {
    const task = db.prepare('SELECT status, current_claim_id FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    // 迁移合法性（DECLARED/ACTIVE/CHANGES_REQUESTED/REVIEW_REQUESTED/IN_REVIEW →
    // CANCELLED）由状态机裁决；终态重复取消抛 E_TRANSITION_INVALID。
    const transition = applyTaskTransition(db, input.taskId, 'cancel', {
      actor: input.session,
      payload: { reason: input.reason ?? null },
    });
    // 在飞评审资源销毁意图（T3.3 执行）；认领资源随任务收尾一并列入意图载荷。
    const submission = latestActiveSubmission(db, input.taskId);
    const reviewPayload = submission === undefined ? undefined : reviewCleanupPayload(submission.submissionId);
    const claimPayload = task.current_claim_id === null ? undefined : claimCleanupPayload(String(task.current_claim_id));
    recordCleanupIntent(db, input.taskId, input.session, {
      reason: 'task_cancelled',
      ...(claimPayload !== undefined ? { claim: claimPayload } : {}),
      ...(reviewPayload !== undefined ? { review: reviewPayload } : {}),
    });
    return { taskId: input.taskId, taskStatus: transition.to as 'CANCELLED' };
  }

  return { submit, fail, cancel };
}

// ---------------------------------------------------------------------------
// api.ts 接线
// ---------------------------------------------------------------------------

const submitPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  claimId: z.string().min(1).optional(),
  evidenceManifest: z.array(evidenceItemSchema),
});

const failPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

const cancelPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  reason: z.string().min(1).optional(),
});

export interface SubmissionHandlersDeps {
  readonly config: GovConfig;
  readonly jj: JjVersionPort;
  readonly stepTimeoutMs?: number | undefined;
}

function buildService(deps: SubmissionHandlersDeps, ctx: ActionContext): SubmissionService {
  return createSubmissionService({
    db: ctx.db,
    config: deps.config,
    jj: deps.jj,
    ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
  });
}

export function createSubmitHandler(deps: SubmissionHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = submitPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(submit): ${formatZodIssues(parsed.error)}`);
    }
    const claimId = parsed.data.claimId ?? ctx.token.claimId ?? '';
    return buildService(deps, ctx).submit({
      taskId: parsed.data.taskId,
      claimId,
      tokenClaimId: ctx.token.claimId,
      session: ctx.token.capabilityId,
      evidenceManifest: parsed.data.evidenceManifest,
    });
  };
}

export function createFailHandler(deps: SubmissionHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = failPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(fail): ${formatZodIssues(parsed.error)}`);
    }
    return buildService(deps, ctx).fail({
      taskId: parsed.data.taskId,
      session: ctx.token.capabilityId,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    });
  };
}

export function createCancelHandler(deps: SubmissionHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = cancelPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(cancel): ${formatZodIssues(parsed.error)}`);
    }
    return buildService(deps, ctx).cancel({
      taskId: parsed.data.taskId,
      session: ctx.token.capabilityId,
      ...(parsed.data.reason !== undefined ? { reason: parsed.data.reason } : {}),
    });
  };
}
