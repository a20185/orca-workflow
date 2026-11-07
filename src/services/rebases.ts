/**
 * rebase 服务（T3.2，设计 §6.3）：目标漂移后把受审版本重放到当前 bookmark。
 *
 * 语义：旧 submission/评审/证据自本事件起作废（task_rebase 事件携带
 * supersededSubmissionIds，所有「最新有效提交」查询据此过滤）；REVIEW_REQUESTED
 * 场景走 target_moved 迁移回 ACTIVE，CHANGES_REQUESTED 场景原地待新提交，
 * ACTIVE（首次提交前漂移）同样原地。返回冲突清单；解决冲突后必须重新 submit
 * （submit 的冲突检查兜底拒绝残留冲突）。
 */
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import type { JjVersionPort } from './ports.ts';
import { loadDeclaredSpec } from './tasks.ts';
import {
  latestActiveSubmission,
  loadDevWorkspace,
  recordCleanupIntent,
  recordTaskEvent,
  supersededSubmissionIds,
  withStepTimeout,
} from './submissions.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

export interface RebaseServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly jj: JjVersionPort;
  readonly stepTimeoutMs?: number | undefined;
}

export interface RebaseInput {
  readonly taskId: string;
  readonly session: string;
}

export interface RebaseResult {
  readonly taskId: string;
  readonly newCommitId: string;
  readonly newBase: string;
  readonly conflicts: readonly string[];
  readonly taskStatus: string;
  readonly supersededSubmissionIds: readonly string[];
}

export function createRebaseService(deps: RebaseServiceDeps): { rebase(input: RebaseInput): Promise<RebaseResult> } {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;

  async function rebase(input: RebaseInput): Promise<RebaseResult> {
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const status = String(task.status);
    if (status !== 'ACTIVE' && status !== 'CHANGES_REQUESTED' && status !== 'REVIEW_REQUESTED') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务状态 ${status} 不可 rebase(须 ACTIVE、CHANGES_REQUESTED 或 REVIEW_REQUESTED): ${input.taskId}`,
      );
    }
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    if (spec.target.kind !== 'top-level') {
      throw new GovError('E_REQUEST_INVALID', `parent-claim 目标无 bookmark，不适用 rebase: ${input.taskId}`);
    }
    const dev = loadDevWorkspace(db, input.taskId);

    // 受审版本：有未作废提交用提交版本，否则重放当前工作副本（首次提交前漂移）。
    const submission = latestActiveSubmission(db, input.taskId);
    const rev = submission?.commitId ?? (await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'rebase_snapshot')).commitId;
    const newBase = (await withStepTimeout(deps.jj.bookmarkCurrent(spec.target.bookmark), stepTimeoutMs, 'rebase_bookmark')).commitId;

    const rebased = await withStepTimeout(
      deps.jj.rebase({ rev, newBase }),
      stepTimeoutMs,
      'rebase',
    );

    // 旧证据失效：既有提交全部作废并记入 task_rebase 事件（真源），评审/证据行
    // 经「最新有效提交」查询自然不可再用；在飞评审发销毁意图（T3.3 执行）。
    const superseded = [...supersededSubmissionIds(db, input.taskId)];
    const currentSubmissionIds = db
      .prepare(
        `SELECT s.submission_id FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE c.task_id = ?`,
      )
      .all(input.taskId)
      .map((row) => String(row.submission_id));
    for (const id of currentSubmissionIds) {
      if (!superseded.includes(id)) {
        superseded.push(id);
      }
    }
    if (submission !== undefined) {
      const reviewRow = db
        .prepare('SELECT review_id, workspace_id, dispatch_id FROM reviews WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1')
        .get(submission.submissionId);
      if (reviewRow !== undefined) {
        const workspaceId = reviewRow.workspace_id;
        const ws = workspaceId === null ? undefined : db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(String(workspaceId));
        recordCleanupIntent(db, input.taskId, input.session, {
          reason: 'submission_superseded',
          review: {
            reviewId: String(reviewRow.review_id),
            workspaceId: workspaceId === null ? null : String(workspaceId),
            envInstanceId: ws?.env_instance_id === null || ws?.env_instance_id === undefined ? null : String(ws.env_instance_id),
            dispatchId: reviewRow.dispatch_id === null ? null : String(reviewRow.dispatch_id),
          },
        });
      }
    }

    let taskStatus = status;
    if (status === 'REVIEW_REQUESTED') {
      taskStatus = applyTaskTransition(db, input.taskId, 'target_moved', {
        actor: input.session,
        payload: { newBase, newCommitId: rebased.newCommitId, reason: 'executor_rebase' },
      }).to;
    }

    recordTaskEvent(db, input.taskId, 'task_rebase', input.session, {
      oldCommitId: rev,
      newBase,
      newCommitId: rebased.newCommitId,
      conflicts: rebased.conflicts,
      supersededSubmissionIds: superseded,
    });

    return {
      taskId: input.taskId,
      newCommitId: rebased.newCommitId,
      newBase,
      conflicts: rebased.conflicts,
      taskStatus,
      supersededSubmissionIds: superseded,
    };
  }

  return { rebase };
}

// ---------------------------------------------------------------------------
// api.ts 接线
// ---------------------------------------------------------------------------

const rebasePayloadSchema = z.strictObject({
  taskId: z.string().min(1),
});

export interface RebaseHandlersDeps {
  readonly config: GovConfig;
  readonly jj: JjVersionPort;
  readonly stepTimeoutMs?: number | undefined;
}

export function createRebaseHandler(deps: RebaseHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = rebasePayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(rebase): ${formatZodIssues(parsed.error)}`);
    }
    return createRebaseService({
      db: ctx.db,
      config: deps.config,
      jj: deps.jj,
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
    }).rebase({ taskId: parsed.data.taskId, session: ctx.token.capabilityId });
  };
}
