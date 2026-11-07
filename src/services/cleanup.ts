/**
 * 资源记账清理与归档（T3.3，设计 §8.6）。
 *
 * 三件事：
 * 1. 资源台账：cleanup_items 表按 (taskId, kind, refId) 确定性登记每项待清资源
 *    （env/workspace/dispatch/terminal），重复登记幂等跳过；
 * 2. runCleanup 逐项执行，固定顺序 dispatch → terminal → env → workspace，每项
 *    幂等（done 跳过），失败记 failed+lastError 可单独重试、不阻塞其他项；任一项
 *    未完成 → 任务保持 cleanup_pending（tasks.blocked_reason），不影响已确认
 *    合并/结算事实，也不重开开发；
 * 3. archiveTask 在任何删除之前落盘：任务书全文 + 结算/评审/合并回执快照 +
 *    evidence 产物（内容哈希校验后落盘）。归档失败 → cleanup_pending、不删任何
 *    资源。认领侧（dev）资源清理额外要求「归档完成 + 无活动写入者」。
 *
 * 触发点（意图事件消费者 consumeCleanupIntents）：评审结论受理（含中止）→ 评审
 * 侧资源；task fail/cancel/supersede → 全量；正常完成（归档后）→ 全量。
 * T3.2 服务只发 cleanup_intent 事件，本模块是唯一执行方。
 *
 * 本模块与 services/ 全目录禁止 import node:child_process；外部动作全部经注入
 * 端口（ports.ts）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { GovConfig } from '../config.ts';
import { GovError } from '../domain/errors.ts';
import { applyClaimTransition } from '../state/claim-machine.ts';
import type { EnvPort, JjPort, OrcaSettlementPort } from './ports.ts';
import { loadDeclaredSpec } from './tasks.ts';
import { errorMessage, recordTaskEvent, sha256Hex, withStepTimeout } from './submissions.ts';

/** 任务级清理未完成标记（tasks.blocked_reason）。 */
export const CLEANUP_PENDING_REASON = 'cleanup_pending';

/** 归档完成事件（runCleanup 认领侧门控的真源）。 */
export const ARCHIVED_EVENT_TYPE = 'task_archived';

export const CLEANUP_EVENT_TYPES = {
  scheduled: 'cleanup_scheduled',
  itemFailed: 'cleanup_item_failed',
  receipt: 'cleanup_receipt',
  archiveFailed: 'task_archive_failed',
  claimSettled: 'claim_settled_for_cleanup',
} as const;

export type CleanupItemKind = 'env' | 'workspace' | 'dispatch' | 'terminal';

/** 各资源项应到达的终态（销毁凭据口径，落入 expected_state 列）。 */
const EXPECTED_STATE_BY_KIND: Readonly<Record<CleanupItemKind, string>> = {
  env: 'destroyed',
  workspace: 'forgotten',
  dispatch: 'released',
  terminal: 'settled',
};

/** 执行顺序：先停派工（进程与终端随之关闭），再销毁容器，最后注销工作区。 */
const KIND_RANK: Readonly<Record<CleanupItemKind, number>> = {
  dispatch: 0,
  terminal: 1,
  env: 2,
  workspace: 3,
};

export type CleanupScope =
  | { readonly kind: 'full' }
  | { readonly kind: 'review'; readonly reviewId: string }
  | { readonly kind: 'claim'; readonly claimId: string };

export interface CleanupItemRow {
  readonly id: string;
  readonly kind: CleanupItemKind;
  readonly refId: string;
  readonly taskId: string;
  readonly expectedState: string;
  readonly status: 'pending' | 'done' | 'failed';
  readonly lastError: string | null;
}

export interface CleanupServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly jj: JjPort;
  readonly env: EnvPort;
  readonly orca: OrcaSettlementPort;
  /** 单个清理外部步骤的 in-process 超时上限（清理无宿主 30s 信封约束，默认放宽）。 */
  readonly stepTimeoutMs?: number | undefined;
}

/** 台账行 id：(taskId, kind, refId) 确定性派生——重复登记被主键去重。 */
export function cleanupItemId(taskId: string, kind: CleanupItemKind, refId: string): string {
  return `gci_${sha256Hex(`${taskId}|${kind}|${refId}`)}`;
}

function insertItem(
  db: DatabaseSync,
  taskId: string,
  kind: CleanupItemKind,
  refId: string,
): boolean {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO cleanup_items
         (id, kind, ref_id, task_id, expected_state, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
    )
    .run(cleanupItemId(taskId, kind, refId), kind, refId, taskId, EXPECTED_STATE_BY_KIND[kind], now, now);
  return Number(result.changes) > 0;
}

// ---------------------------------------------------------------------------
// 资源清单推导（从库内事实出发，不信任意图事件载荷快照）
// ---------------------------------------------------------------------------

function workspaceEnvId(db: DatabaseSync, workspaceId: string | null): string | null {
  if (workspaceId === null) {
    return null;
  }
  const ws = db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(workspaceId);
  return ws?.env_instance_id === null || ws?.env_instance_id === undefined ? null : String(ws.env_instance_id);
}

/** 评审侧资源：评审派工 + 评审环境 + 评审工作区（评审终端随派工结算关闭）。 */
function reviewResourceRefs(
  db: DatabaseSync,
  reviewId: string,
): { dispatchId: string | null; envInstanceId: string | null; workspaceId: string | null } {
  const row = db
    .prepare('SELECT dispatch_id, workspace_id FROM reviews WHERE review_id = ?')
    .get(reviewId);
  if (row === undefined) {
    throw new GovError('E_REQUEST_INVALID', `评审不存在: ${reviewId}`);
  }
  const workspaceId = row.workspace_id === null ? null : String(row.workspace_id);
  return {
    dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
    workspaceId,
    envInstanceId: workspaceEnvId(db, workspaceId),
  };
}

/** 认领侧资源：执行派工（终端同源）+ 开发环境 + 开发工作区。 */
function claimResourceRefs(
  db: DatabaseSync,
  claimId: string,
): { dispatchId: string | null; terminalDispatch: string | null; envInstanceId: string | null; workspaceId: string | null } {
  const row = db
    .prepare('SELECT dispatch_id, workspace_id FROM claims WHERE claim_id = ?')
    .get(claimId);
  if (row === undefined) {
    throw new GovError('E_REQUEST_INVALID', `认领不存在: ${claimId}`);
  }
  const workspaceId = row.workspace_id === null ? null : String(row.workspace_id);
  const dispatchId = row.dispatch_id === null ? null : String(row.dispatch_id);
  return {
    dispatchId,
    // terminal 项 refId 取派工 id：workerStop 是关闭 agent 终端的真实动作，
    // 终端句柄本身没有独立结算动词（T2.1 适配层口径）。
    terminalDispatch: dispatchId,
    workspaceId,
    envInstanceId: workspaceEnvId(db, workspaceId),
  };
}

function taskCurrentOrLatestClaimId(db: DatabaseSync, taskId: string): string | null {
  const task = db.prepare('SELECT current_claim_id FROM tasks WHERE task_id = ?').get(taskId);
  if (task?.current_claim_id !== undefined && task.current_claim_id !== null) {
    return String(task.current_claim_id);
  }
  const latest = db
    .prepare('SELECT claim_id FROM claims WHERE task_id = ? ORDER BY rowid DESC LIMIT 1')
    .get(taskId);
  return latest === undefined ? null : String(latest.claim_id);
}

/** 全量 = 认领侧 + 最新有效提交的最新一轮评审侧。 */
function fullResourceRefs(
  db: DatabaseSync,
  taskId: string,
): { claimId: string | null; reviewId: string | null } {
  const claimId = taskCurrentOrLatestClaimId(db, taskId);
  let reviewId: string | null = null;
  const row = db
    .prepare(
      `SELECT r.review_id FROM reviews r
         JOIN submissions s ON r.submission_id = s.submission_id
         JOIN claims c ON s.claim_id = c.claim_id
        WHERE c.task_id = ? ORDER BY r.rowid DESC LIMIT 1`,
    )
    .get(taskId);
  if (row !== undefined) {
    reviewId = String(row.review_id);
  }
  return { claimId, reviewId };
}

// ---------------------------------------------------------------------------
// scheduleCleanup
// ---------------------------------------------------------------------------

export interface ScheduleCleanupResult {
  readonly taskId: string;
  readonly scope: CleanupScope;
  /** 本次新登记的台账行（重复登记返回空数组）。 */
  readonly newlyRegistered: readonly CleanupItemRow[];
}

export function scheduleCleanup(
  deps: CleanupServiceDeps,
  taskId: string,
  scope: CleanupScope,
  actor: string,
): ScheduleCleanupResult {
  const db = deps.db;
  const task = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(taskId);
  if (task === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${taskId}`);
  }

  const refs: Array<{ kind: CleanupItemKind; refId: string }> = [];
  if (scope.kind === 'review') {
    const r = reviewResourceRefs(db, scope.reviewId);
    if (r.dispatchId !== null) refs.push({ kind: 'dispatch', refId: r.dispatchId });
    if (r.envInstanceId !== null) refs.push({ kind: 'env', refId: r.envInstanceId });
    if (r.workspaceId !== null) refs.push({ kind: 'workspace', refId: r.workspaceId });
  } else if (scope.kind === 'claim') {
    const c = claimResourceRefs(db, scope.claimId);
    if (c.dispatchId !== null) refs.push({ kind: 'dispatch', refId: c.dispatchId });
    if (c.terminalDispatch !== null) refs.push({ kind: 'terminal', refId: c.terminalDispatch });
    if (c.envInstanceId !== null) refs.push({ kind: 'env', refId: c.envInstanceId });
    if (c.workspaceId !== null) refs.push({ kind: 'workspace', refId: c.workspaceId });
  } else {
    const { claimId, reviewId } = fullResourceRefs(db, taskId);
    if (claimId !== null) {
      const c = claimResourceRefs(db, claimId);
      if (c.dispatchId !== null) refs.push({ kind: 'dispatch', refId: c.dispatchId });
      if (c.terminalDispatch !== null) refs.push({ kind: 'terminal', refId: c.terminalDispatch });
      if (c.envInstanceId !== null) refs.push({ kind: 'env', refId: c.envInstanceId });
      if (c.workspaceId !== null) refs.push({ kind: 'workspace', refId: c.workspaceId });
    }
    if (reviewId !== null) {
      const r = reviewResourceRefs(db, reviewId);
      if (r.dispatchId !== null) refs.push({ kind: 'dispatch', refId: r.dispatchId });
      if (r.envInstanceId !== null) refs.push({ kind: 'env', refId: r.envInstanceId });
      if (r.workspaceId !== null) refs.push({ kind: 'workspace', refId: r.workspaceId });
    }
  }

  const newlyRegistered: CleanupItemRow[] = [];
  for (const ref of refs) {
    if (insertItem(db, taskId, ref.kind, ref.refId)) {
      newlyRegistered.push({
        id: cleanupItemId(taskId, ref.kind, ref.refId),
        kind: ref.kind,
        refId: ref.refId,
        taskId,
        expectedState: EXPECTED_STATE_BY_KIND[ref.kind],
        status: 'pending',
        lastError: null,
      });
    }
  }
  if (newlyRegistered.length > 0) {
    recordTaskEvent(db, taskId, CLEANUP_EVENT_TYPES.scheduled, actor, {
      scope: scope.kind,
      items: newlyRegistered.map((item) => ({ id: item.id, kind: item.kind, refId: item.refId })),
    });
  }
  return { taskId, scope, newlyRegistered };
}

// ---------------------------------------------------------------------------
// runCleanup
// ---------------------------------------------------------------------------

export interface RunCleanupResult {
  readonly taskId: string;
  readonly total: number;
  readonly done: number;
  readonly failed: number;
  readonly pending: number;
  readonly items: readonly CleanupItemRow[];
}

export function cleanupItems(db: DatabaseSync, taskId: string): CleanupItemRow[] {
  return db
    .prepare(
      `SELECT id, kind, ref_id, task_id, expected_state, status, last_error
         FROM cleanup_items WHERE task_id = ?`,
    )
    .all(taskId)
    .map((row) => ({
      id: String(row.id),
      kind: row.kind as CleanupItemKind,
      refId: String(row.ref_id),
      taskId: String(row.task_id),
      expectedState: String(row.expected_state),
      status: row.status as 'pending' | 'done' | 'failed',
      lastError: row.last_error === null ? null : String(row.last_error),
    }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.id.localeCompare(b.id));
}

function markItem(
  db: DatabaseSync,
  item: CleanupItemRow,
  status: 'done' | 'failed',
  lastError: string | null,
): CleanupItemRow {
  db.prepare('UPDATE cleanup_items SET status = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
    status,
    lastError,
    new Date().toISOString(),
    item.id,
  );
  return { ...item, status, lastError };
}

function isArchived(db: DatabaseSync, taskId: string): boolean {
  return (
    db
      .prepare('SELECT 1 AS hit FROM events WHERE task_id = ? AND type = ? LIMIT 1')
      .get(taskId, ARCHIVED_EVENT_TYPE) !== undefined
  );
}

/**
 * 认领侧资源门控：归档完成 + 任务已到收尾面（终态或 MERGED/COMPLETED）+
 * 无活动写入者。claim 仍 ACTIVE 时由本流程就地结算（正常完成 → RELEASED，
 * 失败/取消/被替代 → FENCED）——写权限随派工停止与环境销毁在本轮收回。
 */
function enforceClaimGate(deps: CleanupServiceDeps, taskId: string, actor: string): void {
  const db = deps.db;
  const task = db.prepare('SELECT status, current_claim_id FROM tasks WHERE task_id = ?').get(taskId);
  if (task === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${taskId}`);
  }
  const status = String(task.status);
  if (!['MERGED', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status)) {
    throw new GovError(
      'E_CLEANUP_FAILED',
      `任务状态 ${status} 未到收尾面，不允许清理认领侧资源: ${taskId}`,
    );
  }
  if (!isArchived(db, taskId)) {
    throw new GovError('E_CLEANUP_FAILED', `归档未完成，拒绝清理认领侧资源（先 archive）: ${taskId}`);
  }
  const claimId = task.current_claim_id === null ? null : String(task.current_claim_id);
  if (claimId === null) {
    return;
  }
  const claim = db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId);
  if (claim === undefined || String(claim.status) !== 'ACTIVE') {
    return;
  }
  const next = status === 'MERGED' || status === 'COMPLETED' ? 'RELEASED' : 'FENCED';
  applyClaimTransition(db, claimId, next);
  recordTaskEvent(db, taskId, CLEANUP_EVENT_TYPES.claimSettled, actor, { claimId, from: 'ACTIVE', to: next });
}

export async function runCleanup(
  deps: CleanupServiceDeps,
  input: { taskId: string; actor: string },
): Promise<RunCleanupResult> {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 60_000;
  const task = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(input.taskId);
  if (task === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
  }

  const before = cleanupItems(db, input.taskId);
  if (before.length === 0) {
    return { taskId: input.taskId, total: 0, done: 0, failed: 0, pending: 0, items: [] };
  }

  // 认领侧项存在时先过门控（评审侧资源销毁不依赖任务结局，无门控）。
  const claimId = taskCurrentOrLatestClaimId(db, input.taskId);
  const claimItemIds = new Set<string>();
  if (claimId !== null) {
    const c = claimResourceRefs(db, claimId);
    if (c.dispatchId !== null) {
      claimItemIds.add(cleanupItemId(input.taskId, 'dispatch', c.dispatchId));
      // terminal 与 dispatch 同源（claimResourceRefs），?? 仅收窄 null 类型。
      claimItemIds.add(cleanupItemId(input.taskId, 'terminal', c.terminalDispatch ?? c.dispatchId));
    }
    if (c.envInstanceId !== null) claimItemIds.add(cleanupItemId(input.taskId, 'env', c.envInstanceId));
    if (c.workspaceId !== null) claimItemIds.add(cleanupItemId(input.taskId, 'workspace', c.workspaceId));
  }
  if (before.some((item) => claimItemIds.has(item.id))) {
    enforceClaimGate(deps, input.taskId, input.actor);
  }

  const outcomes: CleanupItemRow[] = [];
  for (const item of before) {
    if (item.status === 'done') {
      outcomes.push(item);
      continue;
    }
    try {
      await executeItem(deps, item, stepTimeoutMs);
      outcomes.push(markItem(db, item, 'done', null));
    } catch (err) {
      const message = errorMessage(err);
      const failed = markItem(db, item, 'failed', message);
      outcomes.push(failed);
      recordTaskEvent(db, input.taskId, CLEANUP_EVENT_TYPES.itemFailed, input.actor, {
        id: item.id,
        kind: item.kind,
        refId: item.refId,
        message,
        uncertain: err instanceof GovError && err.code === 'E_TIMEOUT',
      });
      // 单项失败不阻塞其他项（§8.6）：继续逐项执行。
    }
  }

  const failed = outcomes.filter((item) => item.status === 'failed').length;
  const done = outcomes.filter((item) => item.status === 'done').length;
  const pending = outcomes.filter((item) => item.status === 'pending').length;
  if (failed + pending > 0) {
    db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
      CLEANUP_PENDING_REASON,
      new Date().toISOString(),
      input.taskId,
    );
  } else {
    db.prepare(
      'UPDATE tasks SET blocked_reason = NULL, updated_at = ? WHERE task_id = ? AND blocked_reason = ?',
    ).run(new Date().toISOString(), input.taskId, CLEANUP_PENDING_REASON);
  }

  recordTaskEvent(db, input.taskId, CLEANUP_EVENT_TYPES.receipt, input.actor, {
    total: outcomes.length,
    done,
    failed,
    pending,
    items: outcomes.map((item) => ({ kind: item.kind, refId: item.refId, status: item.status })),
  });

  return { taskId: input.taskId, total: outcomes.length, done, failed, pending, items: outcomes };
}

/** 单项执行：每项幂等（env.destroy 容器缺席视为成功；jj/orca 均幂等）。 */
async function executeItem(
  deps: CleanupServiceDeps,
  item: CleanupItemRow,
  stepTimeoutMs: number,
): Promise<void> {
  const db = deps.db;
  if (item.kind === 'dispatch') {
    // 已结算才 release；未结算先 stop。stop 本身幂等（已结算 → alreadySettled、
    // 无进程动作，T2.1 实测），故无条件先 stop 再 release，不猜状态枚举。
    await withStepTimeout(deps.orca.workerStop(item.refId), stepTimeoutMs, `cleanup_stop_${item.refId}`);
    await withStepTimeout(deps.orca.workerRelease(item.refId), stepTimeoutMs, `cleanup_release_${item.refId}`);
    return;
  }
  if (item.kind === 'terminal') {
    await withStepTimeout(deps.orca.workerStop(item.refId), stepTimeoutMs, `cleanup_terminal_${item.refId}`);
    return;
  }
  if (item.kind === 'env') {
    await withStepTimeout(deps.env.destroy(item.refId), stepTimeoutMs, `cleanup_destroy_${item.refId}`);
    db.prepare('UPDATE workspaces SET env_status = NULL WHERE env_instance_id = ?').run(item.refId);
    return;
  }
  // workspace：forget 注销（幂等：已注销的 "No workspace named" 视为完成）+ 目录删除。
  const ws = db
    .prepare('SELECT jj_workspace_name, host_path FROM workspaces WHERE workspace_id = ?')
    .get(item.refId);
  if (ws === undefined) {
    throw new GovError('E_CLEANUP_FAILED', `工作区行缺失，无法清理: ${item.refId}`);
  }
  const name = ws.jj_workspace_name === null ? null : String(ws.jj_workspace_name);
  if (name !== null) {
    try {
      await withStepTimeout(deps.jj.workspaceForget(name), stepTimeoutMs, `cleanup_forget_${name}`);
    } catch (err) {
      if (!/No workspace named/i.test(errorMessage(err))) {
        throw err;
      }
    }
  }
  const hostPath = ws.host_path === null ? null : String(ws.host_path);
  if (hostPath !== null) {
    const spec = loadDeclaredSpec(db, item.taskId, deps.config);
    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    const wsRoot = repo === undefined ? undefined : join(repo.hostPath, '.gov-workspaces');
    // 守卫同 workspaces.ts：路径不在锁定 workspace 根下时宁可残留也不误删异位目录。
    if (wsRoot !== undefined && (hostPath === wsRoot || hostPath.startsWith(`${wsRoot}/`))) {
      rmSync(hostPath, { recursive: true, force: true });
    }
  }
  db.prepare('UPDATE workspaces SET cleanup_status = ?, env_status = NULL WHERE workspace_id = ?').run(
    'released',
    item.refId,
  );
}

// ---------------------------------------------------------------------------
// 意图事件消费者（触发点接线）
// ---------------------------------------------------------------------------

export interface ConsumeCleanupIntentsResult {
  readonly taskId: string;
  readonly consumed: number;
  readonly newlyRegistered: number;
}

/**
 * 消费任务的 cleanup_intent 事件并登记对应范围。幂等：台账主键去重使重复
 * 消费无副作用。reason 口径：task_failed/task_cancelled/task_superseded → 全量；
 * 其余（评审结论受理、中止、rebase 作废）→ 评审侧资源。
 */
export function consumeCleanupIntents(
  deps: CleanupServiceDeps,
  input: { taskId: string; actor: string },
): ConsumeCleanupIntentsResult {
  const db = deps.db;
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq ASC')
    .all(input.taskId, 'cleanup_intent');
  let consumed = 0;
  let newlyRegistered = 0;
  for (const row of rows) {
    let payload: {
      reason?: unknown;
      claim?: { claimId?: unknown } | undefined;
      review?: { reviewId?: unknown } | undefined;
    };
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch {
      continue;
    }
    const reason = typeof payload.reason === 'string' ? payload.reason : '';
    const reviewId = typeof payload.review?.reviewId === 'string' ? payload.review.reviewId : null;
    const claimId = typeof payload.claim?.claimId === 'string' ? payload.claim.claimId : null;
    let scope: CleanupScope | undefined;
    if (reason === 'task_failed' || reason === 'task_cancelled' || reason === 'task_superseded') {
      scope = { kind: 'full' };
    } else if (reviewId !== null) {
      scope = { kind: 'review', reviewId };
    } else if (claimId !== null) {
      scope = { kind: 'claim', claimId };
    }
    if (scope === undefined) {
      continue;
    }
    consumed += 1;
    newlyRegistered += scheduleCleanup(deps, input.taskId, scope, input.actor).newlyRegistered.length;
  }
  return { taskId: input.taskId, consumed, newlyRegistered };
}

// ---------------------------------------------------------------------------
// archiveTask
// ---------------------------------------------------------------------------

export interface ArchiveResult {
  readonly taskId: string;
  readonly dir: string;
  readonly fileCount: number;
  readonly evidenceCopied: number;
  readonly idempotentReplay: boolean;
}

/** 任务的全部回执快照（库内行 + 事件流 + 关联 operations 回执）。 */
function buildDbSnapshot(db: DatabaseSync, taskId: string): Record<string, unknown> {
  const rows = <T extends Record<string, unknown>>(sql: string) => db.prepare(sql).all(taskId) as T[];
  return {
    task: db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId),
    // claims 不带 token_hash：归档不落任何凭据哈希。
    claims: rows(
      'SELECT claim_id, task_id, dispatch_id, claimer_session, terminal_handle, workspace_id, status, created_at, updated_at FROM claims WHERE task_id = ?',
    ),
    workspaces: db
      .prepare(
        `SELECT w.* FROM workspaces w WHERE w.workspace_id IN (
           SELECT workspace_id FROM claims WHERE task_id = ?
           UNION
           SELECT r.workspace_id FROM reviews r
             JOIN submissions s ON r.submission_id = s.submission_id
             JOIN claims c ON s.claim_id = c.claim_id
            WHERE c.task_id = ? AND r.workspace_id IS NOT NULL
         )`,
      )
      .all(taskId, taskId),
    submissions: db
      .prepare(
        `SELECT s.* FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE c.task_id = ?`,
      )
      .all(taskId),
    reviews: db
      .prepare(
        `SELECT r.* FROM reviews r
           JOIN submissions s ON r.submission_id = s.submission_id
           JOIN claims c ON s.claim_id = c.claim_id
          WHERE c.task_id = ?`,
      )
      .all(taskId),
    findings: db
      .prepare(
        `SELECT f.* FROM findings f
           JOIN reviews r ON f.review_id = r.review_id
           JOIN submissions s ON r.submission_id = s.submission_id
           JOIN claims c ON s.claim_id = c.claim_id
          WHERE c.task_id = ?`,
      )
      .all(taskId),
    evidence: db
      .prepare(
        `SELECT e.* FROM evidence e
           JOIN reviews r ON e.review_id = r.review_id
           JOIN submissions s ON r.submission_id = s.submission_id
           JOIN claims c ON s.claim_id = c.claim_id
          WHERE c.task_id = ?`,
      )
      .all(taskId),
    merges: db
      .prepare(
        `SELECT m.* FROM merges m
           JOIN submissions s ON m.submission_id = s.submission_id
           JOIN claims c ON s.claim_id = c.claim_id
          WHERE c.task_id = ?`,
      )
      .all(taskId),
    events: db
      .prepare('SELECT seq, type, actor, payload_json, payload_hash, created_at FROM events WHERE task_id = ? ORDER BY seq ASC')
      .all(taskId),
  };
}

function buildOperationsSnapshot(db: DatabaseSync, taskId: string): unknown {
  const claimIds = (db.prepare('SELECT claim_id FROM claims WHERE task_id = ?').all(taskId) as Array<{ claim_id: string }>).map(
    (row) => String(row.claim_id),
  );
  const submissionIds = (
    db
      .prepare(
        'SELECT s.submission_id FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE c.task_id = ?',
      )
      .all(taskId) as Array<{ submission_id: string }>
  ).map((row) => String(row.submission_id));
  const rows: unknown[] = [];
  for (const claimId of claimIds) {
    rows.push(
      ...db
        .prepare("SELECT request_id, kind, status, current_step, receipt_json, error_code, created_at, updated_at FROM operations WHERE request_id LIKE ?")
        .all(`claim:${claimId}:%`),
    );
  }
  for (const submissionId of submissionIds) {
    rows.push(
      ...db
        .prepare("SELECT request_id, kind, status, current_step, receipt_json, error_code, created_at, updated_at FROM operations WHERE request_id LIKE ?")
        .all(`merge:${submissionId}:%`),
    );
  }
  return rows;
}

interface EvidenceCopyPlan {
  readonly criterionId: string;
  readonly path: string;
  readonly expectedHash: string | null;
}

/**
 * 归档：archiveRoot/<taskId>/ 下落任务书全文、库内回执快照、operations 回执与
 * evidence 产物（内容哈希校验后落盘；文件缺失/哈希不符如实记入 manifest，不伪造
 * 产物）。幂等：已归档（task_archived 事件为真源）直接回放。任何落盘失败 →
 * 任务置 cleanup_pending、不删任何资源，抛 E_ARCHIVE_FAILED。
 */
export function archiveTask(
  deps: CleanupServiceDeps,
  input: { taskId: string; actor: string },
): ArchiveResult {
  const db = deps.db;
  const task = db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(input.taskId);
  if (task === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
  }
  if (isArchived(db, input.taskId)) {
    const dir = join(deps.config.archiveRoot, input.taskId);
    return { taskId: input.taskId, dir, fileCount: 0, evidenceCopied: 0, idempotentReplay: true };
  }

  try {
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    const dir = join(deps.config.archiveRoot, input.taskId);
    mkdirSync(dir, { recursive: true });
    const written: Array<{ name: string; bytes: number; sha256: string }> = [];
    const writeFile = (name: string, content: string): void => {
      writeFileSync(join(dir, name), content, 'utf8');
      written.push({ name, bytes: Buffer.byteLength(content, 'utf8'), sha256: sha256Hex(content) });
    };

    writeFile('task-spec.json', JSON.stringify(spec, null, 2));
    writeFile('db-snapshot.json', JSON.stringify(buildDbSnapshot(db, input.taskId), null, 2));
    writeFile('operations.json', JSON.stringify(buildOperationsSnapshot(db, input.taskId), null, 2));

    // evidence 产物：artifact 标准的期望哈希取该 criterion 最新评审证据行；
    // 候选来源按「归档先于清理」假设：开发工作区与评审工作区仍可能存在。
    const plans: EvidenceCopyPlan[] = spec.acceptanceCriteria
      .filter((c) => c.type === 'artifact')
      .map((c) => ({ criterionId: c.criterionId, path: c.config.path, expectedHash: null }))
      .map((plan) => {
        const row = db
          .prepare(
            `SELECT e.content_hash FROM evidence e
               JOIN reviews r ON e.review_id = r.review_id
               JOIN submissions s ON r.submission_id = s.submission_id
               JOIN claims cl ON s.claim_id = cl.claim_id
              WHERE cl.task_id = ? AND e.criterion_id = ?
              ORDER BY e.rowid DESC LIMIT 1`,
          )
          .get(input.taskId, plan.criterionId);
        return { ...plan, expectedHash: row?.content_hash === null || row?.content_hash === undefined ? null : String(row.content_hash) };
      });

    const wsRows = db
      .prepare(
        `SELECT w.host_path FROM workspaces w WHERE w.host_path IS NOT NULL AND w.workspace_id IN (
           SELECT workspace_id FROM claims WHERE task_id = ?
           UNION
           SELECT r.workspace_id FROM reviews r
             JOIN submissions s ON r.submission_id = s.submission_id
             JOIN claims c ON s.claim_id = c.claim_id
            WHERE c.task_id = ? AND r.workspace_id IS NOT NULL
         )`,
      )
      .all(input.taskId, input.taskId)
      .map((row) => String(row.host_path));
    const evidenceManifest: Array<Record<string, unknown>> = [];
    let evidenceCopied = 0;
    for (const plan of plans) {
      const record: Record<string, unknown> = {
        criterionId: plan.criterionId,
        path: plan.path,
        expectedHash: plan.expectedHash,
      };
      let copied = false;
      for (const hostPath of wsRows) {
        const candidate = join(hostPath, plan.path);
        let content: Buffer;
        try {
          content = readFileSync(candidate);
        } catch {
          continue;
        }
        const actualHash = createHash('sha256').update(content).digest('hex');
        if (plan.expectedHash !== null && actualHash !== plan.expectedHash) {
          record['status'] = 'hash_mismatch';
          record['source'] = candidate;
          break;
        }
        const destName = `evidence/${plan.criterionId}__${basename(plan.path)}`;
        mkdirSync(join(dir, 'evidence'), { recursive: true });
        writeFileSync(join(dir, destName), content);
        written.push({ name: destName, bytes: content.length, sha256: actualHash });
        record['status'] = 'copied';
        record['source'] = candidate;
        copied = true;
        break;
      }
      if (!copied && record['status'] === undefined) {
        record['status'] = 'missing';
      }
      if (record['status'] === 'copied') {
        evidenceCopied += 1;
      }
      evidenceManifest.push(record);
    }

    const manifest = {
      taskId: input.taskId,
      archivedAt: new Date().toISOString(),
      files: written,
      evidence: evidenceManifest,
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    writeFileSync(join(dir, 'archive-manifest.json'), manifestJson, 'utf8');

    recordTaskEvent(db, input.taskId, ARCHIVED_EVENT_TYPE, input.actor, {
      dir,
      fileCount: written.length + 1,
      manifestSha256: sha256Hex(manifestJson),
    });
    return {
      taskId: input.taskId,
      dir,
      fileCount: written.length + 1,
      evidenceCopied,
      idempotentReplay: false,
    };
  } catch (err) {
    // 归档失败不删任何资源：任务停在 cleanup_pending 等人工修复后重试。
    db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
      CLEANUP_PENDING_REASON,
      new Date().toISOString(),
      input.taskId,
    );
    recordTaskEvent(db, input.taskId, CLEANUP_EVENT_TYPES.archiveFailed, input.actor, {
      message: errorMessage(err),
    });
    throw new GovError('E_ARCHIVE_FAILED', `归档失败(资源保留，任务置 cleanup_pending): ${errorMessage(err)}`);
  }
}
