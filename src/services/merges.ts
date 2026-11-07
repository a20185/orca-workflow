/**
 * 快进合并与正常完成链（T3.3，设计 §8.4）。
 *
 * confirmMerge 五步（简报口径，顺序定死）：
 * 1. 按目标串行：进程内互斥（repoId+bookmark 键），同目标一次只合并一个任务；
 * 2. 复核：bookmark 现值 == 评审基线（最近 rebase 基线，无则任务书 base）；
 *    不符 → 任务 APPROVED→CHANGES_REQUESTED（target_moved）+ E_JJ_TARGET_MOVED，
 *    旧签核失效；
 * 3. moveBookmarkFF + 结果读回（bookmarkCurrent == 提交 + op log 回执）：任何
 *    不一致 → operations UNCERTAIN + E_MERGE_UNCERTAIN，不清理任何资源、不回滚，
 *    人工处置；目标在移动瞬间又被外部前移（适配器双保险）按 target_moved 处理；
 * 4. 任务 →MERGED；合并后恢复：snapshot(devWs) == 提交否则 WORKSPACE_DIVERGED
 *    （blockedReason 转人工，已确认合并不回滚）；一致 → env.resume + claim 置
 *    done-eligible（worker_done 门控归 T5.1，此处只置位）；
 * 5. worker 已消失路径：orca.workerStop(dispatch)（幂等）结算执行派工；结果不
 *    确定时 workerAbandon 仅在 workerShow 取得正面退出证据后调用；结算失败不
 *    阻断合并（dispatch 项在清理台账兜底）。
 *
 * completeTask 正常完成链：confirmMerge → archive → consume 意图 → schedule 全量
 * → runCleanup → complete。清理单项失败时任务保持 MERGED + cleanup_pending，
 * 修复后重跑 completeTask 幂等续走（confirmMerge/archive/cleanup 均可重入）。
 *
 * 本模块与 services/ 全目录禁止 import node:child_process；外部动作经注入端口。
 */
import { randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { GovConfig } from '../config.ts';
import { GovError } from '../domain/errors.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import { withTransaction } from '../db/database.ts';
import { beginOperation, canonicalRequestHash, finalizeOperation } from '../operations.ts';
import type { EnvLifecyclePort, JjMergePort, OrcaSettlementPort } from './ports.ts';
import { isUncertainOutcome } from './ports.ts';
import {
  errorMessage,
  lastKnownTargetCommit,
  latestActiveSubmission,
  loadDevWorkspace,
  recordTaskEvent,
  withStepTimeout,
} from './submissions.ts';
import { loadDeclaredSpec } from './tasks.ts';
import {
  archiveTask,
  consumeCleanupIntents,
  runCleanup,
  scheduleCleanup,
  type ArchiveResult,
  type CleanupServiceDeps,
  type RunCleanupResult,
} from './cleanup.ts';

const MERGE_ID_PREFIX = 'gmg_';

export const MERGE_EVENT_TYPES = {
  readback: 'merge_readback',
  uncertain: 'merge_uncertain',
  notFastForward: 'merge_not_fast_forward',
  dispatchSettled: 'merge_dispatch_settled',
  dispatchSettleUncertain: 'merge_dispatch_settle_uncertain',
  dispatchSettleFailed: 'merge_dispatch_settle_failed',
  recoveryBlocked: 'merge_recovery_blocked',
  devEnvResumed: 'merge_dev_env_resumed',
  doneEligible: 'claim_done_eligible',
} as const;

/** blockedReason 值与 reviews 服务同串（同一语义不复读两套词）。 */
export const MERGE_BLOCKED_REASONS = {
  uncertain: 'merge_uncertain',
  notFastForward: 'merge_not_fast_forward',
  workspaceDiverged: 'workspace_diverged',
  envResumeFailed: 'env_resume_failed',
} as const;

export interface MergeServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly jj: JjMergePort;
  readonly env: EnvLifecyclePort;
  readonly orca: OrcaSettlementPort;
  readonly stepTimeoutMs?: number | undefined;
}

export interface DispatchSettlementReceipt {
  readonly dispatchId: string;
  readonly state: string;
  readonly alreadySettled: boolean | null;
  readonly processAction: string | null;
}

export interface MergeResult {
  readonly taskId: string;
  readonly mergeId: string;
  readonly submissionId: string;
  readonly bookmark: string;
  readonly from: string;
  readonly to: string;
  readonly taskStatus: 'MERGED';
  readonly dispatchSettlement: DispatchSettlementReceipt | null;
  readonly recovery: { readonly snapshotCommitId: string; readonly envResumed: boolean; readonly doneEligible: true };
  readonly idempotentReplay: boolean;
}

export interface CompleteResult {
  readonly taskId: string;
  readonly taskStatus: 'COMPLETED';
  readonly merge: MergeResult;
  readonly archive: ArchiveResult;
  readonly cleanup: RunCleanupResult;
}

// ---------------------------------------------------------------------------
// 按目标串行互斥（进程内）：同 repoId+bookmark 的合并一次一个。
// ---------------------------------------------------------------------------

const targetLocks = new Map<string, Promise<void>>();

async function withTargetLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = targetLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  targetLocks.set(key, gate);
  try {
    await prev;
    return await fn();
  } finally {
    release();
    if (targetLocks.get(key) === gate) {
      targetLocks.delete(key);
    }
  }
}

function setBlockedReason(db: DatabaseSync, taskId: string, reason: string): void {
  db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
    reason,
    new Date().toISOString(),
    taskId,
  );
}

function loadMergeRow(db: DatabaseSync, submissionId: string): { mergeId: string; from: string; to: string; bookmark: string } | undefined {
  const row = db
    .prepare('SELECT merge_id, target_bookmark, expected_target_commit, result_commit FROM merges WHERE submission_id = ?')
    .get(submissionId);
  if (row === undefined) {
    return undefined;
  }
  return {
    mergeId: String(row.merge_id),
    bookmark: row.target_bookmark === null ? '' : String(row.target_bookmark),
    from: row.expected_target_commit === null ? '' : String(row.expected_target_commit),
    to: row.result_commit === null ? '' : String(row.result_commit),
  };
}

function countPriorMergeOperations(db: DatabaseSync, submissionId: string): number {
  const prefix = `merge:${submissionId}:`;
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM operations WHERE substr(request_id, 1, ?) = ?')
    .get(prefix.length, prefix);
  return Number(row?.c ?? 0);
}

function doneEligibleRecorded(db: DatabaseSync, taskId: string, claimId: string): boolean {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
    .all(taskId, MERGE_EVENT_TYPES.doneEligible);
  return rows.some((row) => {
    try {
      return (JSON.parse(String(row.payload_json)) as { claimId?: unknown }).claimId === claimId;
    } catch {
      return false;
    }
  });
}

export function createMergeService(deps: MergeServiceDeps) {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 60_000;

  /** worker 已消失路径：结算执行派工；结算失败不阻断合并（清理台账兜底）。 */
  async function settleDevDispatch(
    taskId: string,
    dispatchId: string,
    session: string,
  ): Promise<DispatchSettlementReceipt | null> {
    try {
      const stopped = await withStepTimeout(deps.orca.workerStop(dispatchId), stepTimeoutMs, 'merge_worker_stop');
      const receipt: DispatchSettlementReceipt = {
        dispatchId,
        state: stopped.raw.state,
        alreadySettled: stopped.raw.alreadySettled ?? null,
        processAction: stopped.raw.processAction ?? null,
      };
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.dispatchSettled, session, receipt);
      return receipt;
    } catch (err) {
      const message = errorMessage(err);
      if (isUncertainOutcome(err)) {
        // workerAbandon 仅在取得正面退出证据后：workerShow 显示 worker 已非运行。
        let showState: string | null = null;
        let abandoned = false;
        try {
          const shown = await withStepTimeout(deps.orca.workerShow(dispatchId), stepTimeoutMs, 'merge_worker_show');
          showState = shown.raw.worker.state;
          if (shown.raw.worker.state !== 'running') {
            const abandonedReceipt = await withStepTimeout(
              deps.orca.workerAbandon(dispatchId),
              stepTimeoutMs,
              'merge_worker_abandon',
            );
            abandoned = true;
            showState = abandonedReceipt.raw.state;
          }
        } catch (evidenceErr) {
          recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.dispatchSettleUncertain, session, {
            dispatchId,
            message,
            evidenceError: errorMessage(evidenceErr),
            abandoned,
          });
          return null;
        }
        recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.dispatchSettleUncertain, session, {
          dispatchId,
          message,
          showState,
          abandoned,
        });
        return null;
      }
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.dispatchSettleFailed, session, {
        dispatchId,
        message,
      });
      return null;
    }
  }

  /** 合并后恢复：派工结算 → 工作副本一致性 → 环境恢复 → done-eligible 置位。 */
  async function recoverAfterMerge(
    taskId: string,
    submissionCommitId: string,
    session: string,
  ): Promise<MergeResult['recovery'] & { dispatchSettlement: DispatchSettlementReceipt | null }> {
    const dev = loadDevWorkspace(db, taskId);
    const dispatchSettlement =
      dev.dispatchId !== null ? await settleDevDispatch(taskId, dev.dispatchId, session) : null;

    let snapshotCommitId: string;
    try {
      const snap = await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'merge_recovery_snapshot');
      snapshotCommitId = snap.commitId;
    } catch (err) {
      const message = errorMessage(err);
      setBlockedReason(db, taskId, MERGE_BLOCKED_REASONS.workspaceDiverged);
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.recoveryBlocked, session, {
        reason: MERGE_BLOCKED_REASONS.workspaceDiverged,
        stage: 'snapshot',
        expected: submissionCommitId,
        message,
      });
      throw new GovError(
        'E_WORKSPACE_DIVERGED',
        `合并后恢复读取工作副本失败(已确认合并不回滚，转人工): ${message}`,
      );
    }
    if (snapshotCommitId !== submissionCommitId) {
      setBlockedReason(db, taskId, MERGE_BLOCKED_REASONS.workspaceDiverged);
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.recoveryBlocked, session, {
        reason: MERGE_BLOCKED_REASONS.workspaceDiverged,
        expected: submissionCommitId,
        actual: snapshotCommitId,
      });
      throw new GovError(
        'E_WORKSPACE_DIVERGED',
        `合并后工作副本已偏离合并提交(${snapshotCommitId} ≠ ${submissionCommitId})，已确认合并不回滚，转人工: ${taskId}`,
      );
    }

    let envResumed = false;
    if (dev.envInstanceId !== null) {
      try {
        await withStepTimeout(deps.env.resume(dev.envInstanceId), stepTimeoutMs, 'merge_env_resume');
      } catch (err) {
        const message = errorMessage(err);
        setBlockedReason(db, taskId, MERGE_BLOCKED_REASONS.envResumeFailed);
        recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.recoveryBlocked, session, {
          reason: MERGE_BLOCKED_REASONS.envResumeFailed,
          message,
        });
        throw isUncertainOutcome(err)
          ? new GovError('E_CLAIM_UNCERTAIN', `恢复开发环境结果不确定(转人工): ${message}`)
          : err instanceof GovError
            ? err
            : new GovError('E_ENV_LIFECYCLE_FAILED', `恢复开发环境失败(转人工): ${message}`);
      }
      db.prepare('UPDATE workspaces SET env_status = ? WHERE workspace_id = ?').run('running', dev.workspaceId);
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.devEnvResumed, session, { envInstanceId: dev.envInstanceId });
      envResumed = true;
    }

    // done-eligible 置位：worker_done 门控归 T5.1，此处只落事件标记。
    if (!doneEligibleRecorded(db, taskId, dev.claimId)) {
      recordTaskEvent(db, taskId, MERGE_EVENT_TYPES.doneEligible, session, {
        claimId: dev.claimId,
        reason: 'merge_confirmed',
      });
    }
    return { snapshotCommitId, envResumed, doneEligible: true, dispatchSettlement };
  }

  async function confirmMerge(input: { taskId: string; session: string }): Promise<MergeResult> {
    const task = db
      .prepare('SELECT status, reviewed_commit_id FROM tasks WHERE task_id = ?')
      .get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const status = String(task.status);
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    if (spec.target.kind !== 'top-level') {
      throw new GovError('E_REQUEST_INVALID', `parent-claim 目标不经 bookmark 合并: ${input.taskId}`);
    }
    const bookmark = spec.target.bookmark;
    const submission = latestActiveSubmission(db, input.taskId);
    if (submission === undefined || submission.commitId !== String(task.reviewed_commit_id ?? '')) {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务无可合并的已签核提交(reviewed_commit_id 不匹配): ${input.taskId}`,
      );
    }

    if (status === 'MERGED') {
      // 幂等重入（completeTask 重跑路径）：合并行回放；恢复未完成则补跑。
      const existing = loadMergeRow(db, submission.submissionId);
      if (existing === undefined) {
        throw new GovError('E_REQUEST_INVALID', `任务已 MERGED 但缺合并行(库内不一致): ${input.taskId}`);
      }
      const dev = loadDevWorkspace(db, input.taskId);
      if (doneEligibleRecorded(db, input.taskId, dev.claimId)) {
        return {
          taskId: input.taskId,
          mergeId: existing.mergeId,
          submissionId: submission.submissionId,
          bookmark,
          from: existing.from,
          to: existing.to,
          taskStatus: 'MERGED',
          dispatchSettlement: null,
          recovery: { snapshotCommitId: existing.to, envResumed: true, doneEligible: true },
          idempotentReplay: true,
        };
      }
      const recovery = await recoverAfterMerge(input.taskId, submission.commitId, input.session);
      return {
        taskId: input.taskId,
        mergeId: existing.mergeId,
        submissionId: submission.submissionId,
        bookmark,
        from: existing.from,
        to: existing.to,
        taskStatus: 'MERGED',
        dispatchSettlement: recovery.dispatchSettlement,
        recovery: { snapshotCommitId: recovery.snapshotCommitId, envResumed: recovery.envResumed, doneEligible: true },
        idempotentReplay: true,
      };
    }
    if (status !== 'APPROVED') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务状态 ${status} 不可确认合并(须 APPROVED): ${input.taskId}`,
      );
    }

    // 评审基线：最近一次 rebase 的新基，无 rebase 记录时即任务书 base。
    const expected = lastKnownTargetCommit(db, input.taskId, spec.baseCommitId);

    return withTargetLock(`${spec.repoId}/${bookmark}`, async () => {
      // 第 2 步：复核——目标移动使旧签核失效。
      const current = await withStepTimeout(
        deps.jj.bookmarkCurrent(bookmark),
        stepTimeoutMs,
        'merge_recheck',
      );
      if (current.commitId !== expected) {
        applyTaskTransition(db, input.taskId, 'target_moved', {
          actor: input.session,
          payload: { phase: 'merge_recheck', expected, actual: current.commitId },
        });
        throw new GovError(
          'E_JJ_TARGET_MOVED',
          `合并复核：目标已被外部移动(现值 ${current.commitId}，评审基线 ${expected})，旧签核失效回 CHANGES_REQUESTED: ${input.taskId}`,
        );
      }

      // 第 3 步：快进移动 + 读回确认。
      const attempt = countPriorMergeOperations(db, submission.submissionId) + 1;
      const requestId = `merge:${submission.submissionId}:${attempt}`;
      const requestHash = canonicalRequestHash(requestId, 'merge-confirm', {
        bookmark,
        to: submission.commitId,
        expected,
      });
      const begin = beginOperation(db, { requestId, requestHash, kind: 'merge-confirm' });
      if (begin.type !== 'start') {
        throw new GovError('E_REQUEST_INVALID', `合并账本 ${requestId} 非新开(${begin.type})`);
      }
      const operationId = begin.operationId;

      let from: string;
      let opIds: string[];
      try {
        const moved = await withStepTimeout(
          deps.jj.moveBookmarkFF({
            bookmark,
            toCommit: submission.commitId,
            expectedCurrent: expected,
          }),
          stepTimeoutMs,
          'merge_move',
        );
        from = moved.from;
        const readback = await withStepTimeout(
          deps.jj.bookmarkCurrent(bookmark),
          stepTimeoutMs,
          'merge_readback',
        );
        if (readback.commitId !== submission.commitId) {
          throw new GovError(
            'E_MERGE_UNCERTAIN',
            `合并读回不一致(期望 ${submission.commitId}，实得 ${readback.commitId})`,
          );
        }
        opIds = (await withStepTimeout(deps.jj.opLogReceipt(3), stepTimeoutMs, 'merge_oplog')).opIds;
      } catch (err) {
        const message = errorMessage(err);
        if (err instanceof GovError && err.code === 'E_JJ_TARGET_MOVED') {
          finalizeOperation(
            db,
            operationId,
            'FAILED',
            { httpStatus: 400, body: { ok: false, error: { code: 'E_JJ_TARGET_MOVED', message } } },
            'E_JJ_TARGET_MOVED',
          );
          applyTaskTransition(db, input.taskId, 'target_moved', {
            actor: input.session,
            payload: { phase: 'merge_move', expected, to: submission.commitId },
          });
          throw new GovError(
            'E_JJ_TARGET_MOVED',
            `合并移动时目标已被外部前移(评审基线 ${expected})，旧签核失效回 CHANGES_REQUESTED: ${input.taskId}`,
          );
        }
        if (err instanceof GovError && err.code === 'E_JJ_NOT_FAST_FORWARD') {
          finalizeOperation(
            db,
            operationId,
            'FAILED',
            { httpStatus: 400, body: { ok: false, error: { code: 'E_JJ_NOT_FAST_FORWARD', message } } },
            'E_JJ_NOT_FAST_FORWARD',
          );
          setBlockedReason(db, input.taskId, MERGE_BLOCKED_REASONS.notFastForward);
          recordTaskEvent(db, input.taskId, MERGE_EVENT_TYPES.notFastForward, input.session, {
            bookmark,
            expected,
            to: submission.commitId,
            message,
          });
          throw err;
        }
        // 读回不一致 / 调用失败 / 超时：外部副作用可能已发生——UNCERTAIN，
        // 不清理任何资源、不回滚，人工处置。
        finalizeOperation(
          db,
          operationId,
          'UNCERTAIN',
          { httpStatus: 504, body: { ok: false, error: { code: 'E_MERGE_UNCERTAIN', message } } },
          'E_MERGE_UNCERTAIN',
        );
        setBlockedReason(db, input.taskId, MERGE_BLOCKED_REASONS.uncertain);
        recordTaskEvent(db, input.taskId, MERGE_EVENT_TYPES.uncertain, input.session, {
          bookmark,
          expected,
          to: submission.commitId,
          message,
        });
        throw new GovError(
          'E_MERGE_UNCERTAIN',
          `合并结果不确定(不回滚、不清理资源，转人工): ${message}`,
        );
      }

      finalizeOperation(db, operationId, 'CONFIRMED', {
        httpStatus: 200,
        body: { ok: true, result: { from, to: submission.commitId, opIds } },
      });
      recordTaskEvent(db, input.taskId, MERGE_EVENT_TYPES.readback, input.session, {
        bookmark,
        from,
        to: submission.commitId,
        opIds,
      });

      // 第 4 步：合并行 + 任务 →MERGED。
      const mergeId = MERGE_ID_PREFIX + randomBytes(12).toString('base64url');
      const confirmedAt = new Date().toISOString();
      try {
        db.prepare(
          `INSERT INTO merges (merge_id, submission_id, target_bookmark, expected_target_commit, result_commit, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(mergeId, submission.submissionId, bookmark, expected, submission.commitId, confirmedAt);
      } catch (err) {
        if (!errorMessage(err).includes('UNIQUE')) {
          throw err;
        }
        // 崩断恢复重入：合并行已存在（提交唯一键），复用既有行。
        const existing = loadMergeRow(db, submission.submissionId);
        if (existing === undefined) {
          throw err;
        }
      }
      db.prepare('UPDATE tasks SET merged_commit_id = ?, updated_at = ? WHERE task_id = ?').run(
        submission.commitId,
        confirmedAt,
        input.taskId,
      );
      applyTaskTransition(db, input.taskId, 'merge_confirmed', {
        actor: input.session,
        payload: { mergeId, submissionId: submission.submissionId, bookmark, from, to: submission.commitId, opIds },
      });

      // 第 4/5 步：合并后恢复（含 worker 已消失路径的派工结算）。
      const recovery = await recoverAfterMerge(input.taskId, submission.commitId, input.session);
      return {
        taskId: input.taskId,
        mergeId,
        submissionId: submission.submissionId,
        bookmark,
        from,
        to: submission.commitId,
        taskStatus: 'MERGED',
        dispatchSettlement: recovery.dispatchSettlement,
        recovery: {
          snapshotCommitId: recovery.snapshotCommitId,
          envResumed: recovery.envResumed,
          doneEligible: true,
        },
        idempotentReplay: false,
      };
    });
  }

  /** 正常完成链：confirmMerge → archive → 意图消费 → 全量登记 → 清理 → COMPLETED。 */
  async function completeTask(input: { taskId: string; session: string }): Promise<CompleteResult> {
    const merge = await confirmMerge(input);
    const cleanupDeps: CleanupServiceDeps = {
      db,
      config: deps.config,
      jj: deps.jj,
      env: deps.env,
      orca: deps.orca,
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
    };
    const archive = archiveTask(cleanupDeps, { taskId: input.taskId, actor: input.session });
    consumeCleanupIntents(cleanupDeps, { taskId: input.taskId, actor: input.session });
    scheduleCleanup(cleanupDeps, input.taskId, { kind: 'full' }, input.session);
    const cleanup = await runCleanup(cleanupDeps, { taskId: input.taskId, actor: input.session });
    if (cleanup.failed + cleanup.pending > 0) {
      // 任务保持 MERGED + cleanup_pending：单项可重试，修复后重跑 completeTask。
      throw new GovError(
        'E_CLEANUP_FAILED',
        `清理未完成(failed=${cleanup.failed}, pending=${cleanup.pending})，任务保持 MERGED + cleanup_pending: ${input.taskId}`,
      );
    }
    const transition = applyTaskTransition(db, input.taskId, 'complete', {
      actor: input.session,
      payload: { mergeId: merge.mergeId, cleanupItems: cleanup.total },
    });
    return { taskId: input.taskId, taskStatus: transition.to as 'COMPLETED', merge, archive, cleanup };
  }

  return { confirmMerge, completeTask };
}
