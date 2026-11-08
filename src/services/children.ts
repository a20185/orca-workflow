/**
 * 单阻塞子任务与父任务恢复（T4.2，设计 §8.5）。
 *
 * task split（执行者；父任务 ACTIVE 或 CHANGES_REQUESTED；持久阻塞语义）：
 * 1. 校验子任务书（完整 TaskSpec；target 必为 parent-claim 且指向父当前认领、
 *    ownedPaths ⊆ 父 ownedPaths 前缀、沿 parentTaskId 链深度 ≤3、父无活动子任务）；
 * 2. `jj.snapshot(parentWs)` 锁定父版本 parentRevision（含父未提交 WIP），父任务
 *    迁移 split→WAITING_CHILD（锁定事实落 split 迁移事件载荷——tasks 表无
 *    parentRevision 列且迁移不归本任务改，事件即持久真源，同 declared 任务书先例）；
 * 3. `env.suspend(parentEnv)` 失败 → 父认领 UNCERTAIN + blockedReason，不建子任务
 *    （split 操作 FAILED 可重试：WAITING_CHILD + 最近 split 操作 FAILED + 无存活
 *    子认领时按续跑处理，重锁版本、补建子任务）；
 * 4. 建子任务：declare（幂等）+ 回填 parent_task_id + claim（复用 T3.1 服务）；
 *    子任务此后走正常声明/接受/提交/评审流（T3.2/T3.3，无新代码路径）；
 * 5. split 操作（requestId `split:<parentTaskId>:<n>`，kind=split）保持 IN_FLIGHT，
 *    子任务达终态并 resumeParent 后才 CONFIRMED 并携带恢复结果（原 requestId
 *    查询即得）。
 *
 * 子任务确认合入（completeChildTask）：target.kind=parent-claim 不动顶层
 * bookmark——断言子提交是 parentRevision 后代（否则 E_PARENT_DIVERGED）→ 落
 * merges 行（target_bookmark 空、expected=parentRevision、result=子提交）→ 子
 * 任务 merge_confirmed→MERGED → 在父任务上记 child_advance_pending 事件 → 子
 * 任务照常归档清理 → COMPLETED。快进在父恢复时才应用。
 *
 * 父恢复（resumeParent(childTaskId)；幂等键 = parentRevision）：
 * - 重复调用以 parent_resumed 事件去重，已应用则跳过全部动作；
 * - 父工作副本偏离锁定版本（既非 parentRevision 也非待合入子提交）→
 *   E_WORKSPACE_DIVERGED + blockedReason 转人工，不覆盖；
 * - 子 COMPLETED → jj 快进父工作副本到子提交 → child_merged→ACTIVE →
 *   env.resume → 向父执行者派工发恢复消息 → split 操作 CONFIRMED；
 * - 子 FAILED/CANCELLED → child_terminated→ACTIVE（不快进）→ 恢复环境 + 消息
 *   注明子未产出；
 * - 子 SUPERSEDED → child_superseded→WAITING_CHILD，沿 supersedesTaskId 链找
 *   最新替代任务，恢复条件沿用（替代任务仍活 → 继续等待）。
 *
 * 与既有服务的结构适配（以既有为准，详见 phase 报告）：
 * - merges.ts confirmMerge 拒绝 parent-claim 目标且不归本任务改动，子任务确认
 *   合入在本模块以同口径步骤实现（复核 reviewed_commit_id、merges 行唯一键、
 *   归档清理链复用 T3.3 cleanup）；
 * - supersedeTaskId 无库列，替代链沿声明事件任务书扫描（库内任务量小）；
 * - replaceExecutor/supersedeTask 对 WAITING_CHILD 父任务的拒绝由 T4.1 接口
 *   断言（本任务补单测）。
 *
 * 本模块与 services/ 全目录同规：禁止 import node:child_process；一切外部动作
 * 经注入端口（ports.ts）；jj 快进经 JjChildAdvancePort（适配器面外的扩展动词，
 * 由调用方注入实现）。
 */
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { parseTaskSpec, type TaskSpec } from '../domain/task-spec.ts';
import { applyClaimTransition } from '../state/claim-machine.ts';
import { applyTaskTransition, TASK_TERMINAL_STATUSES } from '../state/task-machine.ts';
import { beginOperation, canonicalRequestHash, finalizeOperation } from '../operations.ts';
import type {
  EnvLifecyclePort,
  JjChildAdvancePort,
  JjMergePort,
  OrcaSettlementPort,
  TrustProvision,
} from './ports.ts';
import { isUncertainOutcome } from './ports.ts';
import { createDefaultTrustProvision } from './workspaces.ts';
import { declareTask, loadDeclaredSpec } from './tasks.ts';
import { createClaimService } from './claims.ts';
import {
  errorMessage,
  latestActiveSubmission,
  loadDevWorkspace,
  recordTaskEvent,
  withStepTimeout,
} from './submissions.ts';
import {
  archiveTask,
  consumeCleanupIntents,
  runCleanup,
  scheduleCleanup,
  type ArchiveResult,
  type CleanupServiceDeps,
  type RunCleanupResult,
} from './cleanup.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

/** 子任务链深度上限：沿 parentTaskId 的链数（根任务为 0）不得超过 3。 */
export const MAX_CHILD_DEPTH = 3;

/** 父子任务审计事件（事件表自由 type；锁定/快进/恢复事实的持久真源）。 */
export const CHILD_EVENT_TYPES = {
  relocked: 'split_relocked',
  failed: 'split_failed',
  advancePending: 'child_advance_pending',
  resumed: 'parent_resumed',
  resumeBlocked: 'parent_resume_blocked',
  messageFailed: 'parent_resume_message_failed',
} as const;

/** 与 reviews.ts / merges.ts 同语义共用同串（同一事实不造两套词）。 */
export const CHILD_BLOCKED_REASONS = {
  envSuspendFailed: 'env_suspend_failed',
  childClaimFailed: 'child_claim_failed',
  workspaceDiverged: 'parent_workspace_diverged',
  advanceFailed: 'parent_advance_failed',
  envResumeFailed: 'env_resume_failed',
} as const;

const SPLIT_OP_PREFIX = 'split:';
const MERGE_ID_PREFIX = 'gmg_';

export interface ChildrenDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: OrcaSettlementPort;
  readonly jj: JjMergePort & JjChildAdvancePort;
  readonly env: EnvLifecyclePort;
  readonly trustProvision?: TrustProvision | undefined;
  readonly stepTimeoutMs?: number | undefined;
}

export interface ChildTaskService {
  taskSplit(input: SplitInput): Promise<SplitResult>;
  completeChildTask(input: CompleteChildInput): Promise<CompleteChildResult>;
  resumeParent(input: ResumeParentInput): Promise<ResumeParentResult>;
}

// ---------------------------------------------------------------------------
// 持久事实读取（事件表为真源）
// ---------------------------------------------------------------------------

interface SplitLock {
  readonly parentRevision: string;
  readonly childTaskId: string | null;
  readonly requestId: string | null;
}

/**
 * 最近一次拆分锁定：扫父任务的 split 迁移事件与 split_relocked 事件，按序取
 * 最后一条带 parentRevision 的载荷（重锁晚于首锁，天然覆盖）。
 */
function latestSplitLock(db: DatabaseSync, parentTaskId: string): SplitLock | undefined {
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
        WHERE task_id = ? AND type IN ('split', 'split_relocked') ORDER BY seq ASC`,
    )
    .all(parentTaskId);
  let lock: SplitLock | undefined;
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as {
        parentRevision?: unknown;
        childTaskId?: unknown;
        requestId?: unknown;
      };
      if (typeof payload.parentRevision === 'string' && payload.parentRevision.length > 0) {
        lock = {
          parentRevision: payload.parentRevision,
          childTaskId: typeof payload.childTaskId === 'string' ? payload.childTaskId : null,
          requestId: typeof payload.requestId === 'string' ? payload.requestId : null,
        };
      }
    } catch {
      // 损坏行跳过：以下一条合法锁定为准。
    }
  }
  return lock;
}

interface SplitOpRow {
  readonly operationId: string;
  readonly requestId: string;
  readonly status: string;
}

/** 按尝试序取最新 split 操作行（rowid 与 attempt 序一致）。 */
function latestSplitOperation(db: DatabaseSync, parentTaskId: string): SplitOpRow | undefined {
  const prefix = `${SPLIT_OP_PREFIX}${parentTaskId}:`;
  const row = db
    .prepare(
      `SELECT operation_id, request_id, status FROM operations
        WHERE substr(request_id, 1, ?) = ? ORDER BY rowid DESC LIMIT 1`,
    )
    .get(prefix.length, prefix);
  if (row === undefined) {
    return undefined;
  }
  return {
    operationId: String(row.operation_id),
    requestId: String(row.request_id),
    status: String(row.status),
  };
}

/** 父任务当前处于等待中的 split 操作（恢复终态化对象）。 */
function inFlightSplitOperation(db: DatabaseSync, parentTaskId: string): SplitOpRow | undefined {
  const latest = latestSplitOperation(db, parentTaskId);
  return latest !== undefined && latest.status === 'IN_FLIGHT' ? latest : undefined;
}

/** 活动子任务：tasks 里 parent=本任务且非终态（首版单阻塞的判定面）。 */
function activeChildTaskIds(db: DatabaseSync, parentTaskId: string): string[] {
  const placeholders = TASK_TERMINAL_STATUSES.map(() => '?').join(',');
  return db
    .prepare(`SELECT task_id FROM tasks WHERE parent_task_id = ? AND status NOT IN (${placeholders})`)
    .all(parentTaskId, ...TASK_TERMINAL_STATUSES)
    .map((row) => String(row.task_id));
}

/** 存活认领（与 claim() 的部分唯一索引同口径：RELEASED/FENCED 不算存活）。 */
function taskHasLiveClaim(db: DatabaseSync, taskId: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM claims WHERE task_id = ? AND status NOT IN ('RELEASED','FENCED') LIMIT 1")
      .get(taskId) !== undefined
  );
}

/** 沿 parent_task_id 数链长（根为 0）；成环即拒绝（防御，正常流不可能出现）。 */
export function childChainDepth(db: DatabaseSync, taskId: string): number {
  let depth = 0;
  let current = taskId;
  const seen = new Set<string>([taskId]);
  for (;;) {
    const row = db.prepare('SELECT parent_task_id FROM tasks WHERE task_id = ?').get(current);
    if (row === undefined || row.parent_task_id === null || row.parent_task_id === undefined) {
      return depth;
    }
    current = String(row.parent_task_id);
    depth += 1;
    if (seen.has(current) || depth > 16) {
      throw new GovError('E_REQUEST_INVALID', `parentTaskId 链存在环或超长: ${taskId}`);
    }
    seen.add(current);
  }
}

/** ownedPaths 覆盖判定（与 jj 适配器 isCoveredBy 同语义：相等或前缀目录）。 */
function coveredBy(path: string, ownedPaths: readonly string[]): boolean {
  return ownedPaths.some((owned) => path === owned || path.startsWith(owned.endsWith('/') ? owned : `${owned}/`));
}

interface ChildTaskRow {
  readonly status: string;
  readonly parentTaskId: string | null;
  readonly currentClaimId: string | null;
  readonly reviewedCommitId: string | null;
}

function taskRow(db: DatabaseSync, taskId: string): ChildTaskRow {
  const row = db
    .prepare('SELECT status, parent_task_id, current_claim_id, reviewed_commit_id FROM tasks WHERE task_id = ?')
    .get(taskId);
  if (row === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${taskId}`);
  }
  return {
    status: String(row.status),
    parentTaskId: row.parent_task_id === null || row.parent_task_id === undefined ? null : String(row.parent_task_id),
    currentClaimId: row.current_claim_id === null || row.current_claim_id === undefined ? null : String(row.current_claim_id),
    reviewedCommitId: row.reviewed_commit_id === null || row.reviewed_commit_id === undefined ? null : String(row.reviewed_commit_id),
  };
}

function setBlockedReason(db: DatabaseSync, taskId: string, reason: string): void {
  db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
    reason,
    new Date().toISOString(),
    taskId,
  );
}

function clearSplitBlockedReasons(db: DatabaseSync, taskId: string): void {
  const reasons = [
    CHILD_BLOCKED_REASONS.envSuspendFailed,
    CHILD_BLOCKED_REASONS.childClaimFailed,
    CHILD_BLOCKED_REASONS.advanceFailed,
  ];
  db.prepare(
    `UPDATE tasks SET blocked_reason = NULL, updated_at = ? WHERE task_id = ? AND blocked_reason IN (${reasons.map(() => '?').join(',')})`,
  ).run(new Date().toISOString(), taskId, ...reasons);
}

function workspaceEnvStatus(db: DatabaseSync, workspaceId: string): string | null {
  const row = db.prepare('SELECT env_status FROM workspaces WHERE workspace_id = ?').get(workspaceId);
  return row?.env_status === null || row?.env_status === undefined ? null : String(row.env_status);
}

function claimStatusOf(db: DatabaseSync, claimId: string): string | null {
  const row = db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId);
  return row === undefined ? null : String(row.status);
}

/** 事件表读取：任务上指定 type 且载荷匹配的最新一条。 */
function latestEventPayload(
  db: DatabaseSync,
  taskId: string,
  type: string,
  match: (payload: Record<string, unknown>) => boolean,
): Record<string, unknown> | undefined {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
    .all(taskId, type);
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as Record<string, unknown>;
      if (match(payload)) {
        return payload;
      }
    } catch {
      // 损坏行跳过。
    }
  }
  return undefined;
}

function findResumedEvent(db: DatabaseSync, parentTaskId: string, parentRevision: string): Record<string, unknown> | undefined {
  return latestEventPayload(db, parentTaskId, CHILD_EVENT_TYPES.resumed, (p) => p['parentRevision'] === parentRevision);
}

function hasTransitionEvent(db: DatabaseSync, parentTaskId: string, event: string, childTaskId: string): boolean {
  return latestEventPayload(db, parentTaskId, event, (p) => p['childTaskId'] === childTaskId) !== undefined;
}

function findAdvancePending(
  db: DatabaseSync,
  parentTaskId: string,
  childTaskId: string,
): { childCommitId: string; parentRevision: string } | undefined {
  const payload = latestEventPayload(db, parentTaskId, CHILD_EVENT_TYPES.advancePending, (p) => p['childTaskId'] === childTaskId);
  if (payload === undefined) {
    return undefined;
  }
  const childCommitId = payload['childCommitId'];
  const parentRevision = payload['parentRevision'];
  return typeof childCommitId === 'string' && typeof parentRevision === 'string'
    ? { childCommitId, parentRevision }
    : undefined;
}

/** 替代链尾：沿 supersedesTaskId 找最新任务（库内任务量小，全扫声明任务书）。 */
function followSupersedesChain(
  db: DatabaseSync,
  config: GovConfig,
  childTaskId: string,
): { taskId: string; status: string } {
  let current = childTaskId;
  const seen = new Set<string>([childTaskId]);
  for (let hops = 0; hops < 8; hops += 1) {
    const replacement = findReplacement(db, config, current);
    if (replacement === undefined) {
      const status = taskRow(db, current).status;
      if (status === 'SUPERSEDED') {
        throw new GovError(
          'E_RECOVERY_STATE_INVALID',
          `子任务被替代但替代链断裂(找不到替代者): ${current}`,
        );
      }
      return { taskId: current, status };
    }
    current = replacement;
    if (seen.has(current)) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `supersedesTaskId 链存在环: ${childTaskId}`);
    }
    seen.add(current);
  }
  throw new GovError('E_RECOVERY_STATE_INVALID', `supersedesTaskId 链超长: ${childTaskId}`);
}

function findReplacement(db: DatabaseSync, config: GovConfig, supersededTaskId: string): string | undefined {
  const rows = db.prepare('SELECT task_id FROM tasks').all();
  for (const row of rows) {
    const taskId = String(row.task_id);
    if (taskId === supersededTaskId) {
      continue;
    }
    try {
      const spec = loadDeclaredSpec(db, taskId, config);
      if (spec.supersedesTaskId === supersededTaskId) {
        return taskId;
      }
    } catch {
      // 声明任务书不可恢复的任务不可能构成替代链，跳过。
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

export interface SplitInput {
  readonly taskId: string;
  /** 完整子任务书（TaskSpec 形态；target 必为 parent-claim）。 */
  readonly childSpec: unknown;
  readonly session: string;
}

export interface SplitResult {
  readonly parentTaskId: string;
  readonly parentStatus: 'WAITING_CHILD';
  readonly childTaskId: string;
  readonly childClaimId: string;
  readonly childDispatchId: string;
  readonly childExecutorToken: string;
  readonly childExecutorCapabilityId: string;
  readonly parentRevision: string;
  readonly splitRequestId: string;
  /** true = 暂停/建子失败后的续跑重试（复用既有 WAITING_CHILD，不重复迁移）。 */
  readonly retryContinuation: boolean;
}

export interface CompleteChildInput {
  readonly childTaskId: string;
  readonly session: string;
}

export interface CompleteChildResult {
  readonly childTaskId: string;
  readonly taskStatus: 'COMPLETED';
  readonly parentTaskId: string;
  readonly parentRevision: string;
  readonly childCommitId: string;
  readonly archive: ArchiveResult;
  readonly cleanup: RunCleanupResult;
  readonly idempotentReplay: boolean;
}

export interface ResumeParentInput {
  readonly childTaskId: string;
  readonly session: string;
}

export type ResumeParentResult =
  | {
      readonly outcome: 'merged';
      readonly parentTaskId: string;
      readonly parentStatus: 'ACTIVE';
      readonly childTaskId: string;
      readonly childCommitId: string;
      readonly parentRevision: string;
      readonly splitRequestId: string | null;
      readonly messageSent: boolean;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly outcome: 'terminated';
      readonly parentTaskId: string;
      readonly parentStatus: 'ACTIVE';
      readonly childTaskId: string;
      readonly childStatus: string;
      readonly parentRevision: string;
      readonly splitRequestId: string | null;
      readonly messageSent: boolean;
      readonly idempotentReplay: boolean;
    }
  | {
      readonly outcome: 'waiting';
      readonly parentTaskId: string;
      readonly parentStatus: string;
      readonly childTaskId: string;
      readonly childStatus: string;
      readonly successorChildTaskId: string | null;
    };

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

export function createChildrenService(deps: ChildrenDeps): ChildTaskService {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;
  const trustProvision = deps.trustProvision ?? createDefaultTrustProvision();

  function cleanupDeps(): CleanupServiceDeps {
    return {
      db,
      config: deps.config,
      jj: deps.jj,
      env: deps.env,
      orca: deps.orca,
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
    };
  }

  function requireParentLock(parentTaskId: string): SplitLock {
    const lock = latestSplitLock(db, parentTaskId);
    if (lock === undefined) {
      throw new GovError('E_REQUEST_INVALID', `父任务无拆分锁定记录: ${parentTaskId}`);
    }
    return lock;
  }

  // -------------------------------------------------------------------------
  // taskSplit
  // -------------------------------------------------------------------------

  async function taskSplit(input: SplitInput): Promise<SplitResult> {
    const parent = taskRow(db, input.taskId);
    if (parent.currentClaimId === null) {
      throw new GovError('E_REQUEST_INVALID', `父任务无当前认领，不可拆分: ${input.taskId}`);
    }

    // 续跑门：WAITING_CHILD 只在「最近 split 操作 FAILED 且无存活子认领」时续跑
    //（暂停失败/建子失败后的可重试路径）；否则即重复拆分，拒绝（有活动子任务时
    // 用更精确的 E_CHILD_EXISTS 报因）。
    let retryContinuation = false;
    if (parent.status === 'WAITING_CHILD') {
      const latest = latestSplitOperation(db, input.taskId);
      if (latest === undefined || latest.status !== 'FAILED') {
        const waitingActives = activeChildTaskIds(db, input.taskId);
        if (waitingActives.length > 0) {
          throw new GovError('E_CHILD_EXISTS', `父任务已有活动子任务(首版单阻塞): ${waitingActives.join(', ')}`);
        }
        throw new GovError(
          'E_REQUEST_INVALID',
          `父任务已在等待子任务(WAITING_CHILD)，不可重复拆分: ${input.taskId}`,
        );
      }
      const actives = activeChildTaskIds(db, input.taskId);
      if (actives.some((id) => taskHasLiveClaim(db, id))) {
        throw new GovError('E_CHILD_EXISTS', `父任务子任务认领仍在途(先经 T4.1 查明处置): ${actives.join(', ')}`);
      }
      retryContinuation = true;
    } else if (parent.status !== 'ACTIVE' && parent.status !== 'CHANGES_REQUESTED') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务状态 ${parent.status} 不可拆分(须 ACTIVE/CHANGES_REQUESTED): ${input.taskId}`,
      );
    }

    // —— 第 1 步：子任务书校验（任何状态改动之前完成全部拒绝判定）——
    const spec: TaskSpec = parseTaskSpec(input.childSpec, deps.config);
    if (spec.taskId === input.taskId) {
      throw new GovError('E_REQUEST_INVALID', `子任务 taskId 不得与父任务相同: ${spec.taskId}`);
    }
    if (spec.parentTaskId !== input.taskId) {
      throw new GovError(
        'E_REQUEST_INVALID',
        `子任务书 parentTaskId 必须指向父任务: ${spec.parentTaskId ?? '(缺席)'} ≠ ${input.taskId}`,
      );
    }
    if (spec.target.kind !== 'parent-claim') {
      throw new GovError('E_REQUEST_INVALID', `子任务目标必须为 parent-claim: ${spec.taskId}`);
    }
    // T1.2 冻结 schema 钉 parentClaimId 为 gt- 形态（任务 id）：认领在本系统由
    // 「任务至多一行存活认领」唯一锚定，故 parentClaimId 携带父任务 id 即锚定其
    // 当前认领；父无认领已在上方先行拒绝。
    if (spec.target.parentClaimId !== input.taskId) {
      throw new GovError(
        'E_REQUEST_INVALID',
        `子任务 parentClaimId 必须锚定父任务(当前认领所属任务)(${spec.target.parentClaimId} ≠ ${input.taskId})`,
      );
    }
    const parentSpec = loadDeclaredSpec(db, input.taskId, deps.config);
    const offending = spec.ownedPaths.filter((p) => !coveredBy(p, parentSpec.ownedPaths));
    if (offending.length > 0) {
      throw new GovError(
        'E_CHILD_SCOPE_INVALID',
        `子任务 ownedPaths 超出父任务范围: ${offending.join(', ')}(父: ${parentSpec.ownedPaths.join(', ')})`,
      );
    }
    const childDepth = childChainDepth(db, input.taskId) + 1;
    if (childDepth > MAX_CHILD_DEPTH) {
      throw new GovError(
        'E_CHILD_DEPTH_EXCEEDED',
        `子任务深度 ${childDepth} 超过上限 ${MAX_CHILD_DEPTH}(沿 parentTaskId 链): ${spec.taskId}`,
      );
    }
    const actives = activeChildTaskIds(db, input.taskId);
    if (!retryContinuation) {
      if (actives.length > 0) {
        throw new GovError('E_CHILD_EXISTS', `父任务已有活动子任务(首版单阻塞): ${actives.join(', ')}`);
      }
    } else if (actives.length > 1 || (actives.length === 1 && actives[0] !== spec.taskId)) {
      // 续跑只接手失败拆分留下的孤儿子任务书，不得堆积平行子书。
      throw new GovError(
        'E_REQUEST_INVALID',
        `存在未完成拆分的其它子任务书，续跑必须使用同一子任务: ${actives.join(', ')}`,
      );
    }

    // —— 第 2 步：锁定父版本（快照含父未提交 WIP）+ 子基线一致性 ——
    const dev = loadDevWorkspace(db, input.taskId);
    if (dev.envInstanceId === null) {
      throw new GovError('E_REQUEST_INVALID', `父任务缺执行环境，不可拆分: ${input.taskId}`);
    }
    const snap = await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'split_snapshot');
    const parentRevision = snap.commitId;
    if (spec.baseCommitId !== parentRevision) {
      throw new GovError(
        'E_PARENT_DIVERGED',
        `子任务基线 ${spec.baseCommitId} 与父锁定版本 ${parentRevision} 不符(子目标冲突)，拒绝拆分`,
      );
    }

    const prefix = `${SPLIT_OP_PREFIX}${input.taskId}:`;
    const prior = db
      .prepare('SELECT COUNT(*) AS c FROM operations WHERE substr(request_id, 1, ?) = ?')
      .get(prefix.length, prefix);
    const attempt = Number(prior?.c ?? 0) + 1;
    const requestId = `${prefix}${attempt}`;
    const requestHash = canonicalRequestHash(requestId, 'split', {
      taskId: input.taskId,
      childTaskId: spec.taskId,
      parentRevision,
    });
    const begin = beginOperation(db, { requestId, requestHash, kind: 'split' });
    if (begin.type !== 'start') {
      throw new GovError('E_REQUEST_INVALID', `拆分账本 ${requestId} 非新开(${begin.type})`);
    }
    const operationId = begin.operationId;

    if (!retryContinuation) {
      applyTaskTransition(db, input.taskId, 'split', {
        actor: input.session,
        payload: {
          parentRevision,
          childTaskId: spec.taskId,
          requestId,
          parentEnvId: dev.envInstanceId,
          parentWs: dev.hostPath,
        },
      });
    } else {
      recordTaskEvent(db, input.taskId, CHILD_EVENT_TYPES.relocked, input.session, {
        parentRevision,
        childTaskId: spec.taskId,
        requestId,
        attempt,
      });
    }

    // —— 第 3 步：父环境暂停（失败不建子任务；split FAILED 可重试）——
    if (workspaceEnvStatus(db, dev.workspaceId) !== 'suspended') {
      try {
        await withStepTimeout(deps.env.suspend(dev.envInstanceId), stepTimeoutMs, 'split_suspend');
      } catch (err) {
        const message = errorMessage(err);
        finalizeOperation(
          db,
          operationId,
          'FAILED',
          { httpStatus: 502, body: { ok: false, error: { code: 'E_ENV_LIFECYCLE_FAILED', message } } },
          'E_ENV_LIFECYCLE_FAILED',
        );
        recordTaskEvent(db, input.taskId, CHILD_EVENT_TYPES.failed, input.session, {
          requestId,
          stage: 'suspend',
          message,
        });
        if (claimStatusOf(db, dev.claimId) !== 'UNCERTAIN') {
          applyClaimTransition(db, dev.claimId, 'UNCERTAIN');
        }
        setBlockedReason(db, input.taskId, CHILD_BLOCKED_REASONS.envSuspendFailed);
        throw err instanceof GovError
          ? err
          : new GovError('E_ENV_LIFECYCLE_FAILED', `父环境暂停失败(不建子任务，split 可重试): ${message}`);
      }
      db.prepare('UPDATE workspaces SET env_status = ? WHERE workspace_id = ?').run('suspended', dev.workspaceId);
    }

    // —— 第 4 步：建子任务（declare 幂等 + 归属回填 + T3.1 认领）——
    try {
      await declareTask({ db, config: deps.config, orca: deps.orca }, { spec, session: input.session });
      db.prepare('UPDATE tasks SET parent_task_id = ? WHERE task_id = ?').run(input.taskId, spec.taskId);
      const claimService = createClaimService({
        db,
        config: deps.config,
        orca: deps.orca,
        jj: deps.jj,
        env: deps.env,
        trustProvision,
        ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
      });
      const claimed = await claimService.claim(input.session, { taskId: spec.taskId });
      db.prepare('UPDATE operations SET current_step = ?, updated_at = ? WHERE operation_id = ?').run(
        'child-running',
        new Date().toISOString(),
        operationId,
      );
      const result: SplitResult = {
        parentTaskId: input.taskId,
        parentStatus: 'WAITING_CHILD',
        childTaskId: spec.taskId,
        childClaimId: claimed.claimId,
        childDispatchId: claimed.dispatchId,
        childExecutorToken: claimed.executorToken,
        childExecutorCapabilityId: claimed.executorCapabilityId,
        parentRevision,
        splitRequestId: requestId,
        retryContinuation,
      };

      // 受理成功：清除拆分阶段失败标记；续跑路径把 UNCERTAIN 认领查明恢复为
      // ACTIVE（暂停与子认领均已完成，此前的不确定已由本次续跑消除）。
      clearSplitBlockedReasons(db, input.taskId);
      if (retryContinuation && claimStatusOf(db, dev.claimId) === 'UNCERTAIN') {
        applyClaimTransition(db, dev.claimId, 'ACTIVE');
      }
      return result;
    } catch (err) {
      const message = errorMessage(err);
      const code = err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED';
      finalizeOperation(
        db,
        operationId,
        'FAILED',
        { httpStatus: 400, body: { ok: false, error: { code, message } } },
        code,
      );
      recordTaskEvent(db, input.taskId, CHILD_EVENT_TYPES.failed, input.session, {
        requestId,
        stage: 'child_setup',
        message,
        childTaskId: spec.taskId,
      });
      setBlockedReason(db, input.taskId, CHILD_BLOCKED_REASONS.childClaimFailed);
      throw err instanceof GovError
        ? err
        : new GovError('E_CLAIM_PREP_FAILED', `子任务建立失败(父保持 WAITING_CHILD，split 可重试): ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // completeChildTask（子 APPROVED → 记 pendingParentAdvance → 归档清理 → COMPLETED）
  // -------------------------------------------------------------------------

  async function completeChildTask(input: CompleteChildInput): Promise<CompleteChildResult> {
    const child = taskRow(db, input.childTaskId);
    if (child.parentTaskId === null) {
      throw new GovError('E_REQUEST_INVALID', `任务不是子任务(无 parentTaskId): ${input.childTaskId}`);
    }
    const parentTaskId = child.parentTaskId;
    const lock = requireParentLock(parentTaskId);

    if (child.status === 'COMPLETED') {
      // 幂等重入（completeTask 重跑路径同款）。
      const pending = requireAdvancePending(db, parentTaskId, input.childTaskId);
      return {
        childTaskId: input.childTaskId,
        taskStatus: 'COMPLETED',
        parentTaskId,
        parentRevision: pending.parentRevision,
        childCommitId: pending.childCommitId,
        archive: {
          taskId: input.childTaskId,
          dir: join(deps.config.archiveRoot, input.childTaskId),
          fileCount: 0,
          evidenceCopied: 0,
          idempotentReplay: true,
        },
        cleanup: replayCleanup(db, input.childTaskId),
        idempotentReplay: true,
      };
    }
    if (child.status !== 'APPROVED' && child.status !== 'MERGED') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `子任务状态 ${child.status} 不可确认合入(须 APPROVED): ${input.childTaskId}`,
      );
    }
    const spec = loadDeclaredSpec(db, input.childTaskId, deps.config);
    if (spec.target.kind !== 'parent-claim') {
      throw new GovError('E_REQUEST_INVALID', `子任务确认合入仅适用 parent-claim 目标: ${input.childTaskId}`);
    }
    const submission = latestActiveSubmission(db, input.childTaskId);
    if (submission === undefined) {
      throw new GovError('E_REQUEST_INVALID', `子任务无可合并提交: ${input.childTaskId}`);
    }

    let childCommitId: string;
    if (child.status === 'MERGED') {
      const row = db
        .prepare('SELECT result_commit FROM merges WHERE submission_id = ?')
        .get(submission.submissionId);
      if (row === undefined || row.result_commit === null) {
        throw new GovError('E_REQUEST_INVALID', `任务已 MERGED 但缺合并行(库内不一致): ${input.childTaskId}`);
      }
      childCommitId = String(row.result_commit);
    } else {
      if (submission.commitId !== (child.reviewedCommitId ?? '')) {
        throw new GovError(
          'E_REQUEST_INVALID',
          `子任务无可合并的已签核提交(reviewed_commit_id 不匹配): ${input.childTaskId}`,
        );
      }
      childCommitId = submission.commitId;
      const ancestry = await withStepTimeout(
        deps.jj.isAncestorOrEqual({ ancestor: lock.parentRevision, descendant: childCommitId }),
        stepTimeoutMs,
        'child_advance_ancestry',
      );
      if (!ancestry.result) {
        throw new GovError(
          'E_PARENT_DIVERGED',
          `子提交 ${childCommitId} 不是父锁定版本 ${lock.parentRevision} 的后代(子目标冲突)，拒绝记录父版本快进: ${input.childTaskId}`,
        );
      }

      const mergeId = MERGE_ID_PREFIX + randomBytes(12).toString('base64url');
      const confirmedAt = new Date().toISOString();
      try {
        db.prepare(
          `INSERT INTO merges (merge_id, submission_id, target_bookmark, expected_target_commit, result_commit, confirmed_at)
           VALUES (?, ?, NULL, ?, ?, ?)`,
        ).run(mergeId, submission.submissionId, lock.parentRevision, childCommitId, confirmedAt);
      } catch (err) {
        if (!errorMessage(err).includes('UNIQUE')) {
          throw err;
        }
        // 崩断重入：合并行已存在（提交唯一键），复用既有行。
      }
      db.prepare('UPDATE tasks SET merged_commit_id = ?, updated_at = ? WHERE task_id = ?').run(
        childCommitId,
        confirmedAt,
        input.childTaskId,
      );
      applyTaskTransition(db, input.childTaskId, 'merge_confirmed', {
        actor: input.session,
        payload: {
          kind: 'parent-advance',
          parentTaskId,
          parentRevision: lock.parentRevision,
          submissionId: submission.submissionId,
          to: childCommitId,
        },
      });
    }

    // pendingParentAdvance：父恢复时应用的快进事实（先于子资源清理落库——清理
    // 会注销子工作区，此后子提交只能靠本事件与 merges 行寻址）。
    if (findAdvancePending(db, parentTaskId, input.childTaskId) === undefined) {
      recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.advancePending, input.session, {
        childTaskId: input.childTaskId,
        childCommitId,
        parentRevision: lock.parentRevision,
      });
    }

    // 子任务照常归档清理（复用 T3.3；认领门在 MERGED/COMPLETED 收尾面放行）。
    const cleanup = cleanupDeps();
    const archive = archiveTask(cleanup, { taskId: input.childTaskId, actor: input.session });
    consumeCleanupIntents(cleanup, { taskId: input.childTaskId, actor: input.session });
    scheduleCleanup(cleanup, input.childTaskId, { kind: 'full' }, input.session);
    const run = await runCleanup(cleanup, { taskId: input.childTaskId, actor: input.session });
    if (run.failed + run.pending > 0) {
      throw new GovError(
        'E_CLEANUP_FAILED',
        `子任务清理未完成(failed=${run.failed}, pending=${run.pending})，保持 MERGED + cleanup_pending，修复后重跑: ${input.childTaskId}`,
      );
    }
    applyTaskTransition(db, input.childTaskId, 'complete', {
      actor: input.session,
      payload: {
        kind: 'parent-advance',
        parentTaskId,
        parentRevision: lock.parentRevision,
        cleanupItems: run.total,
      },
    });
    return {
      childTaskId: input.childTaskId,
      taskStatus: 'COMPLETED',
      parentTaskId,
      parentRevision: lock.parentRevision,
      childCommitId,
      archive,
      cleanup: run,
      idempotentReplay: false,
    };
  }

  function requireAdvancePending(
    db: DatabaseSync,
    parentTaskId: string,
    childTaskId: string,
  ): { childCommitId: string; parentRevision: string } {
    const pending = findAdvancePending(db, parentTaskId, childTaskId);
    if (pending === undefined) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `子任务已完成但无父版本快进记录: ${childTaskId}`);
    }
    return pending;
  }

  // -------------------------------------------------------------------------
  // resumeParent（幂等键 = parentRevision）
  // -------------------------------------------------------------------------

  async function resumeParent(input: ResumeParentInput): Promise<ResumeParentResult> {
    const child = taskRow(db, input.childTaskId);
    if (child.parentTaskId === null) {
      throw new GovError('E_REQUEST_INVALID', `任务不是子任务(无 parentTaskId): ${input.childTaskId}`);
    }
    const parentTaskId = child.parentTaskId;
    const parent = taskRow(db, parentTaskId);
    const lock = requireParentLock(parentTaskId);
    const parentRevision = lock.parentRevision;

    // 幂等回放：本轮等待（由 parentRevision 唯一标识）已恢复 → 跳过全部动作。
    const prior = findResumedEvent(db, parentTaskId, parentRevision);
    if (prior !== undefined) {
      return replayResumed(prior, parentTaskId, parentRevision);
    }

    // 终态解析（SUPERSEDED 沿替代链改绑；非终态如实等待）。
    let effectiveTaskId = input.childTaskId;
    let effectiveStatus = child.status;
    let successor: string | null = null;
    if (effectiveStatus === 'SUPERSEDED') {
      if (
        parent.status === 'WAITING_CHILD' &&
        !hasTransitionEvent(db, parentTaskId, 'child_superseded', input.childTaskId)
      ) {
        applyTaskTransition(db, parentTaskId, 'child_superseded', {
          actor: input.session,
          payload: { childTaskId: input.childTaskId },
        });
      }
      const chain = followSupersedesChain(db, deps.config, input.childTaskId);
      effectiveTaskId = chain.taskId;
      effectiveStatus = chain.status;
      successor = effectiveTaskId;
    }
    if (!(TASK_TERMINAL_STATUSES as readonly string[]).includes(effectiveStatus)) {
      return {
        outcome: 'waiting',
        parentTaskId,
        parentStatus: parent.status,
        childTaskId: effectiveTaskId,
        childStatus: effectiveStatus,
        successorChildTaskId: successor,
      };
    }

    // 分支前检查父工作副本：必须仍在锁定版本（或快进已应用——崩断续跑）。
    const dev = loadDevWorkspace(db, parentTaskId);
    if (dev.envInstanceId === null) {
      throw new GovError('E_REQUEST_INVALID', `父任务缺执行环境，不可恢复: ${parentTaskId}`);
    }
    let targetCommit: string | null = null;
    if (effectiveStatus === 'COMPLETED') {
      const pending = requireAdvancePending(db, parentTaskId, effectiveTaskId);
      if (pending.parentRevision !== parentRevision) {
        throw new GovError(
          'E_RECOVERY_STATE_INVALID',
          `子任务快进记录与当前锁定版本不符(${pending.parentRevision} ≠ ${parentRevision})，拒绝恢复: ${effectiveTaskId}`,
        );
      }
      targetCommit = pending.childCommitId;
    }
    const snap = await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'resume_snapshot');
    const diverged =
      effectiveStatus === 'COMPLETED'
        ? snap.commitId !== parentRevision && snap.commitId !== targetCommit
        : snap.commitId !== parentRevision;
    if (diverged) {
      setBlockedReason(db, parentTaskId, CHILD_BLOCKED_REASONS.workspaceDiverged);
      recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.resumeBlocked, input.session, {
        reason: CHILD_BLOCKED_REASONS.workspaceDiverged,
        parentRevision,
        actual: snap.commitId,
        childTaskId: effectiveTaskId,
      });
      throw new GovError(
        'E_WORKSPACE_DIVERGED',
        `父工作副本已偏离锁定版本(${snap.commitId} ≠ ${parentRevision})，停止覆盖转人工: ${parentTaskId}`,
      );
    }
    const advanceNeeded = effectiveStatus === 'COMPLETED' && snap.commitId === parentRevision;

    // 快进父工作副本（子 COMPLETED 且尚未应用）。
    if (advanceNeeded && targetCommit !== null) {
      const ancestry = await withStepTimeout(
        deps.jj.isAncestorOrEqual({ ancestor: parentRevision, descendant: targetCommit }),
        stepTimeoutMs,
        'resume_advance_ancestry',
      );
      if (!ancestry.result) {
        throw new GovError(
          'E_PARENT_DIVERGED',
          `子提交 ${targetCommit} 不是父锁定版本 ${parentRevision} 的后代，拒绝快进: ${effectiveTaskId}`,
        );
      }
      try {
        await withStepTimeout(
          deps.jj.advanceWorkingCopy({ dir: dev.hostPath, rev: targetCommit, expectedCurrent: parentRevision }),
          stepTimeoutMs,
          'resume_advance',
        );
      } catch (err) {
        const message = errorMessage(err);
        const inFlight = inFlightSplitOperation(db, parentTaskId);
        if (isUncertainOutcome(err) && inFlight !== undefined) {
          finalizeOperation(
            db,
            inFlight.operationId,
            'UNCERTAIN',
            { httpStatus: 504, body: { ok: false, error: { code: 'E_TIMEOUT', message } } },
            'E_TIMEOUT',
          );
        }
        setBlockedReason(db, parentTaskId, CHILD_BLOCKED_REASONS.advanceFailed);
        recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.resumeBlocked, input.session, {
          reason: CHILD_BLOCKED_REASONS.advanceFailed,
          stage: 'advance',
          parentRevision,
          to: targetCommit,
          message,
        });
        throw err instanceof GovError
          ? err
          : new GovError('E_JJ_CALL_FAILED', `父工作副本快进失败(不覆盖，转人工): ${message}`);
      }
    }

    // 父任务迁移（merged/terminated；崩断续跑时已迁移则跳过）。
    const transitionEvent = effectiveStatus === 'COMPLETED' ? 'child_merged' : 'child_terminated';
    if (!hasTransitionEvent(db, parentTaskId, transitionEvent, effectiveTaskId)) {
      if (parent.status !== 'WAITING_CHILD') {
        throw new GovError(
          'E_RECOVERY_STATE_INVALID',
          `父任务状态 ${parent.status} 不可恢复(须 WAITING_CHILD): ${parentTaskId}`,
        );
      }
      applyTaskTransition(db, parentTaskId, transitionEvent, {
        actor: input.session,
        payload: {
          childTaskId: effectiveTaskId,
          childStatus: effectiveStatus,
          from: parentRevision,
          to: targetCommit,
        },
      });
    }

    // 环境恢复（失败保持已迁移状态，重调 resumeParent 续跑余下步骤）。
    try {
      await withStepTimeout(deps.env.resume(dev.envInstanceId), stepTimeoutMs, 'resume_env');
      db.prepare('UPDATE workspaces SET env_status = ? WHERE workspace_id = ?').run('running', dev.workspaceId);
    } catch (err) {
      const message = errorMessage(err);
      setBlockedReason(db, parentTaskId, CHILD_BLOCKED_REASONS.envResumeFailed);
      recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.resumeBlocked, input.session, {
        reason: CHILD_BLOCKED_REASONS.envResumeFailed,
        parentRevision,
        message,
      });
      throw err instanceof GovError
        ? err
        : new GovError('E_ENV_LIFECYCLE_FAILED', `父环境恢复失败(转人工，可重调 resumeParent 续跑): ${message}`);
    }

    // 恢复消息：子摘要 + 快进事实 + 返回父任务继续处理。意见送达是尽力而为
    //（reviews 退回意见同口径）：派工已死（dispatch_inactive——Orca 明确「其
    // worker 永不读该邮箱」）或发送失败时，恢复事实已全部落库，执行者经
    // status 轮询获知；失败留 parent_resume_message_failed 事件。
    let messageSent = false;
    if (dev.dispatchId !== null) {
      const body =
        effectiveStatus === 'COMPLETED'
          ? `子任务 ${effectiveTaskId} 已完成，父版本已快进(${parentRevision} → ${targetCommit})。返回父任务继续处理。`
          : `子任务 ${effectiveTaskId} 未产出(${effectiveStatus})，父版本未快进(仍为 ${parentRevision})。返回父任务继续处理，请自行处置子任务未完成的部分。`;
      try {
        await withStepTimeout(
          deps.orca.sendToDispatch({
            dispatch: dev.dispatchId,
            type: 'status',
            subject: '子任务收口，返回父任务继续处理',
            body,
          }),
          stepTimeoutMs,
          'resume_message',
        );
        messageSent = true;
      } catch (err) {
        recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.messageFailed, input.session, {
          dispatchId: dev.dispatchId,
          message: errorMessage(err),
        });
      }
    }

    // split 操作 CONFIRMED 并携带恢复结果（原 requestId 查询即得）。
    const outcome = effectiveStatus === 'COMPLETED' ? 'merged' : 'terminated';
    const summary = {
      outcome,
      parentTaskId,
      childTaskId: effectiveTaskId,
      childStatus: effectiveStatus,
      parentRevision,
      advancedTo: targetCommit,
      taskStatus: 'ACTIVE',
      messageSent,
    };
    const inFlight = inFlightSplitOperation(db, parentTaskId);
    if (inFlight !== undefined) {
      finalizeOperation(db, inFlight.operationId, 'CONFIRMED', {
        httpStatus: 200,
        body: { ok: true, result: summary },
      });
    }
    recordTaskEvent(db, parentTaskId, CHILD_EVENT_TYPES.resumed, input.session, {
      parentRevision,
      childTaskId: effectiveTaskId,
      outcome,
      summary,
    });
    clearSplitBlockedReasons(db, parentTaskId);

    if (outcome === 'merged') {
      return {
        outcome: 'merged',
        parentTaskId,
        parentStatus: 'ACTIVE',
        childTaskId: effectiveTaskId,
        childCommitId: targetCommit ?? '',
        parentRevision,
        splitRequestId: inFlight?.requestId ?? lock.requestId,
        messageSent,
        idempotentReplay: false,
      };
    }
    return {
      outcome: 'terminated',
      parentTaskId,
      parentStatus: 'ACTIVE',
      childTaskId: effectiveTaskId,
      childStatus: effectiveStatus,
      parentRevision,
      splitRequestId: inFlight?.requestId ?? lock.requestId,
      messageSent,
      idempotentReplay: false,
    };
  }

  function replayResumed(
    payload: Record<string, unknown>,
    parentTaskId: string,
    parentRevision: string,
  ): ResumeParentResult {
    const summary = (payload['summary'] as Record<string, unknown> | undefined) ?? {};
    const childTaskId =
      typeof summary['childTaskId'] === 'string' ? summary['childTaskId'] : String(payload['childTaskId'] ?? '');
    const splitRequestId = latestSplitOperation(db, parentTaskId)?.requestId ?? null;
    const messageSent = summary['messageSent'] === true;
    if (summary['outcome'] === 'merged') {
      return {
        outcome: 'merged',
        parentTaskId,
        parentStatus: 'ACTIVE',
        childTaskId,
        childCommitId: typeof summary['advancedTo'] === 'string' ? summary['advancedTo'] : '',
        parentRevision,
        splitRequestId,
        messageSent,
        idempotentReplay: true,
      };
    }
    return {
      outcome: 'terminated',
      parentTaskId,
      parentStatus: 'ACTIVE',
      childTaskId,
      childStatus: typeof summary['childStatus'] === 'string' ? summary['childStatus'] : '',
      parentRevision,
      splitRequestId,
      messageSent,
      idempotentReplay: true,
    };
  }

  return { taskSplit, completeChildTask, resumeParent };
}

function replayCleanup(db: DatabaseSync, taskId: string): RunCleanupResult {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
              SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending
         FROM cleanup_items WHERE task_id = ?`,
    )
    .get(taskId);
  return {
    taskId,
    total: Number(row?.total ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    pending: Number(row?.pending ?? 0),
    items: [],
  };
}

// ---------------------------------------------------------------------------
// api.ts 接线（split 动作；resumeParent/completeChildTask 为编排层内部入口）
// ---------------------------------------------------------------------------

const splitPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  childSpec: z.unknown(),
});

export interface ChildrenHandlersDeps {
  readonly config: GovConfig;
  readonly orca: OrcaSettlementPort;
  readonly jj: JjMergePort & JjChildAdvancePort;
  readonly env: EnvLifecyclePort;
  readonly trustProvision?: TrustProvision | undefined;
  readonly stepTimeoutMs?: number | undefined;
}

export function createSplitHandler(deps: ChildrenHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = splitPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(split): ${formatZodIssues(parsed.error)}`);
    }
    return createChildrenService({
      db: ctx.db,
      config: deps.config,
      orca: deps.orca,
      jj: deps.jj,
      env: deps.env,
      ...(deps.trustProvision !== undefined ? { trustProvision: deps.trustProvision } : {}),
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
    }).taskSplit({
      taskId: parsed.data.taskId,
      childSpec: parsed.data.childSpec,
      session: ctx.token.capabilityId,
    });
  };
}
