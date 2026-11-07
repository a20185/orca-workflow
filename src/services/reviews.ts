/**
 * 独立评审服务（T3.2，设计 §8.2/§8.3/§10）：onMergeReady（暂停开发环境 + 建
 * 评审 Session）、review-accept、review-submit（结审 tree 检查 + 逐条证据核验 +
 * 通过/退回判定 + 退回恢复）、review-request（同版本补证据重送）。
 *
 * 关键不变量：
 * - 身份三拒：候选评审者命中声明者 / 本任务任何历史认领者（含当前认领者）即换人；
 * - 每次评审都是新 Session（新 reviewId + 新工作区 + 新评审者令牌）；
 * - 结审 tree 检查：评审工作副本提交必须仍等于受审提交，评审者改被审版本即作废重建；
 * - 版本、tree、证据、范围或预算任一不符都不能判 approved；
 * - 评审资源销毁只发 cleanup_intent 事件，执行归 T3.3。
 *
 * 适配记录（相对简报字面）：
 * - reviews.verdict 受 CHECK 约束且无 pending 值——评审行在建 Session 时以
 *   'aborted'（唯一非结论值，部分唯一索引亦按非结论处理）落库作为「未出结论」
 *   占位，review-submit 时更新为最终结论。同一提交开新一轮评审（review-request
 *   补证据重送）时，先行结论行同样被置回 'aborted'（uq_reviews_conclusive 只允
 *   许一行结论）；历史结论与作废事实均以 reject/approve/review_superseded 事件
 *   载荷为真源。该行是否已被作废以 review_aborted / review_superseded 事件为真源。
 * - 退回 reasonClass 以 reject 事件载荷为真源（reviews 表无该列，T1.2 迁移已冻结）。
 * - review-submit 的落库顺序：结论/findings/evidence 先入事务，随后任务迁移——
 *   applyTaskTransition 自带事务边界不可嵌套；单写入者纪律下两步之间无交错窗口。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import type { TaskSpec } from '../domain/task-spec.ts';
import { applyClaimTransition } from '../state/claim-machine.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import { withTransaction } from '../db/database.ts';
import { issueToken } from '../auth.ts';
import {
  evidenceItemSchema,
  verifyManualDecision,
  type EvidenceItem,
} from './evidence.ts';
import type { EnvLifecyclePort, JjVersionPort, OrcaMessagingPort } from './ports.ts';
import { isUncertainOutcome } from './ports.ts';
import { loadDeclaredSpec } from './tasks.ts';
import {
  errorMessage,
  latestActiveSubmission,
  loadDevWorkspace,
  recordCleanupIntent,
  recordTaskEvent,
  sha256Hex,
  withStepTimeout,
  type SubmissionRow,
} from './submissions.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

const REVIEW_ID_PREFIX = 'grv_';
const WORKSPACE_ID_PREFIX = 'gws_';
const FINDING_ID_PREFIX = 'gfd_';
const EVIDENCE_ID_PREFIX = 'gev_';

/**
 * 评审者候选尝试上限：三类禁任身份各命中一次后仍须有第四人可选的最小上限；
 * 连续全部命中即视为无可用评审者转人工。
 */
export const REVIEWER_CANDIDATE_LIMIT = 4;

export const BLOCKED_REASONS = {
  envSuspendFailed: 'env_suspend_failed',
  noReviewer: 'no_reviewer',
  reviewBudgetExhausted: 'review_budget_exhausted',
  workspaceDiverged: 'workspace_diverged',
  envResumeFailed: 'env_resume_failed',
} as const;

/** 评审审计事件（自由 type；review_accept/reject/approve/review_aborted 由状态机记录）。 */
export const REVIEW_EVENT_TYPES = {
  created: 'review_created',
  reviewerRejected: 'reviewer_rejected',
  superseded: 'review_superseded',
  devEnvSuspended: 'dev_env_suspended',
  devEnvSuspendFailed: 'dev_env_suspend_failed',
  devEnvResumed: 'dev_env_resumed',
  returnRecoveryBlocked: 'return_recovery_blocked',
  returnCommentsFailed: 'return_comments_failed',
} as const;

function slugify(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '-');
}

function randomId(prefix: string): string {
  return prefix + randomBytes(12).toString('base64url');
}

interface ReviewRow {
  readonly reviewId: string;
  readonly submissionId: string;
  readonly verdict: string;
  readonly reviewerSession: string | null;
  readonly workspaceId: string | null;
  readonly dispatchId: string | null;
}

function latestReviewFor(db: DatabaseSync, submissionId: string): ReviewRow | undefined {
  const row = db
    .prepare(
      'SELECT review_id, submission_id, verdict, reviewer_session, workspace_id, dispatch_id FROM reviews WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1',
    )
    .get(submissionId);
  if (row === undefined) {
    return undefined;
  }
  return {
    reviewId: String(row.review_id),
    submissionId: String(row.submission_id),
    verdict: String(row.verdict),
    reviewerSession: row.reviewer_session === null ? null : String(row.reviewer_session),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
  };
}

function loadReview(db: DatabaseSync, reviewId: string): ReviewRow {
  const row = db
    .prepare('SELECT review_id, submission_id, verdict, reviewer_session, workspace_id, dispatch_id FROM reviews WHERE review_id = ?')
    .get(reviewId);
  if (row === undefined) {
    throw new GovError('E_NOT_FOUND', `评审不存在: ${reviewId}`);
  }
  return {
    reviewId: String(row.review_id),
    submissionId: String(row.submission_id),
    verdict: String(row.verdict),
    reviewerSession: row.reviewer_session === null ? null : String(row.reviewer_session),
    workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
    dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
  };
}

/**
 * 该评审是否已被作废（review_aborted / review_superseded 任务事件为真源——
 * 作废后该评审行不可再接受或出结论，可重建新评审）。
 */
function isReviewDead(db: DatabaseSync, taskId: string, reviewId: string): boolean {
  for (const type of ['review_aborted', REVIEW_EVENT_TYPES.superseded]) {
    const rows = db
      .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
      .all(taskId, type);
    const dead = rows.some((row) => {
      try {
        const payload = JSON.parse(String(row.payload_json)) as {
          reviewId?: unknown;
          oldReviewId?: unknown;
        };
        return payload.reviewId === reviewId || payload.oldReviewId === reviewId;
      } catch {
        return false;
      }
    });
    if (dead) {
      return true;
    }
  }
  return false;
}

/** 任务评审行数（含 aborted）——轮数预算的真源。 */
function countReviews(db: DatabaseSync, taskId: string): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM reviews r
         JOIN submissions s ON r.submission_id = s.submission_id
         JOIN claims cl ON s.claim_id = cl.claim_id
        WHERE cl.task_id = ?`,
    )
    .get(taskId);
  return Number(row?.c ?? 0);
}

/** 提交事件携带的开发证据清单（artifact 哈希比对的持久真源）。 */
function submissionManifest(db: DatabaseSync, taskId: string, submissionId: string): readonly EvidenceItem[] {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
    .all(taskId, 'submit');
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as { submissionId?: unknown; evidenceManifest?: unknown };
      if (payload.submissionId === submissionId && Array.isArray(payload.evidenceManifest)) {
        return payload.evidenceManifest as EvidenceItem[];
      }
    } catch {
      // 跳过损坏行，继续向旧事件回溯。
    }
  }
  return [];
}

/**
 * 身份三拒判定：候选评审者身份命中声明者 / 历史认领者 / 当前认领者时返回命
 * 中规则名，否则 null。历史与当前认领者同源（claims.claimer_session），以是否
 * 为当前认领区分标签。
 */
function reviewerRejectionRule(
  db: DatabaseSync,
  taskId: string,
  identity: string,
): 'declarer' | 'historical_claimer' | 'current_claimer' | null {
  const task = db.prepare('SELECT declared_session, current_claim_id FROM tasks WHERE task_id = ?').get(taskId);
  if (task === undefined) {
    return 'declarer';
  }
  if (identity === String(task.declared_session)) {
    return 'declarer';
  }
  const claims = db
    .prepare('SELECT claim_id, claimer_session FROM claims WHERE task_id = ? AND claimer_session IS NOT NULL')
    .all(taskId);
  for (const claim of claims) {
    if (identity === String(claim.claimer_session)) {
      return task.current_claim_id !== null && String(claim.claim_id) === String(task.current_claim_id)
        ? 'current_claimer'
        : 'historical_claimer';
    }
  }
  return null;
}

function setBlockedReason(db: DatabaseSync, taskId: string, reason: string): void {
  db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
    reason,
    new Date().toISOString(),
    taskId,
  );
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface ReviewServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: OrcaMessagingPort;
  readonly jj: JjVersionPort;
  readonly env: EnvLifecyclePort;
  readonly stepTimeoutMs?: number | undefined;
}

export interface ReviewSessionResult {
  readonly taskId: string;
  readonly reviewId: string;
  readonly submissionId: string;
  readonly reviewerSession: string;
  /** reviewer 明文令牌仅创建时返回一次；幂等重放路径为 null。 */
  readonly reviewerToken: string | null;
  readonly reviewerCapabilityId: string | null;
  readonly workspaceId: string;
  readonly envInstanceId: string;
  readonly dispatchId: string;
  readonly taskStatus: string;
  readonly idempotentReplay: boolean;
}

export interface ReviewAcceptResult {
  readonly taskId: string;
  readonly reviewId: string;
  readonly taskStatus: 'IN_REVIEW';
}

export interface ReviewSubmitResult {
  readonly taskId: string;
  readonly reviewId: string;
  readonly submissionId: string;
  readonly verdict: 'approved' | 'changes_requested';
  readonly taskStatus: string;
  readonly findingsRecorded: number;
  readonly evidenceRecorded: number;
  /** 退回意见送达结果（approved 时为 null）。 */
  readonly returnDelivery: 'sent' | 'skipped_no_dispatch' | 'send_failed' | null;
}

export interface ReviewSubmitPayload {
  readonly verdict: 'approved' | 'changes_requested';
  readonly reasonClass?: 'code' | 'evidence' | 'process' | undefined;
  readonly findings: readonly FindingItem[];
  readonly evidence: readonly EvidenceItem[];
  readonly reportRef: string;
}

export interface FindingItem {
  readonly severity: 'critical' | 'high' | 'medium' | 'low';
  readonly note: string;
  readonly disposition: 'OPEN' | 'PARKED' | 'RESOLVED';
  readonly parkedReason?: string | undefined;
}

export interface ReviewService {
  onMergeReady(input: { taskId: string; session: string }): Promise<ReviewSessionResult>;
  reviewRequest(input: {
    taskId: string;
    claimId: string;
    tokenClaimId: string | null;
    session: string;
  }): Promise<ReviewSessionResult>;
  reviewAccept(input: {
    taskId: string;
    reviewId: string;
    tokenReviewId: string | null;
    session: string;
  }): Promise<ReviewAcceptResult>;
  reviewSubmit(input: {
    taskId: string;
    reviewId: string;
    tokenReviewId: string | null;
    session: string;
    payload: ReviewSubmitPayload;
  }): Promise<ReviewSubmitResult>;
}

export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;

  /** 暂停开发环境（进评审前提）。失败（确定或不确定）一律认领 UNCERTAIN 转人工，不建评审。 */
  async function suspendDevEnv(taskId: string, session: string): Promise<void> {
    const dev = loadDevWorkspace(db, taskId);
    if (dev.envInstanceId === null) {
      return;
    }
    try {
      await withStepTimeout(deps.env.suspend(dev.envInstanceId), stepTimeoutMs, 'review_suspend_dev_env');
    } catch (err) {
      const message = errorMessage(err);
      // 认领 ACTIVE→UNCERTAIN：暂停失败后写权限状态存疑，绝不能继续建评审。
      applyClaimTransition(db, dev.claimId, 'UNCERTAIN');
      setBlockedReason(db, taskId, BLOCKED_REASONS.envSuspendFailed);
      recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.devEnvSuspendFailed, session, {
        claimId: dev.claimId,
        envInstanceId: dev.envInstanceId,
        message,
      });
      if (isUncertainOutcome(err)) {
        throw new GovError('E_CLAIM_UNCERTAIN', `暂停开发环境结果不确定: ${message}`);
      }
      throw err instanceof GovError
        ? err
        : new GovError('E_ENV_LIFECYCLE_FAILED', `暂停开发环境失败(认领已置 UNCERTAIN 转人工): ${message}`);
    }
    db.prepare('UPDATE workspaces SET env_status = ? WHERE workspace_id = ?').run('suspended', dev.workspaceId);
    recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.devEnvSuspended, session, {
      claimId: dev.claimId,
      envInstanceId: dev.envInstanceId,
    });
  }

  /**
   * 建 Independent 评审 Session：预算门 → 暂停开发环境 → 评审工作区（base=受审
   * 提交）→ 评审环境（无 0000 门，完整性靠结审 tree 检查）→ 评审者派工（身份
   * 三拒换人）→ 评审行 + reviewer 令牌。任一确定失败尽力回收已建资源。
   */
  async function createReviewSession(
    taskId: string,
    submission: SubmissionRow,
    session: string,
  ): Promise<ReviewSessionResult> {
    const spec = loadDeclaredSpec(db, taskId, deps.config);
    const task = db.prepare('SELECT status, orca_task_id FROM tasks WHERE task_id = ?').get(taskId);
    const orcaTaskId = task?.orca_task_id;
    if (orcaTaskId === undefined || orcaTaskId === null) {
      throw new GovError('E_REQUEST_INVALID', `任务尚未完成 Orca 登记: ${taskId}`);
    }

    // 暂停开发环境：评审期间执行者不得再写受审工作副本。
    await suspendDevEnv(taskId, session);

    // 轮数预算（含 aborted）：新评审是第 count+1 轮，超出即转人工。
    const count = countReviews(db, taskId);
    if (count >= spec.budget.maxReviewRounds) {
      setBlockedReason(db, taskId, BLOCKED_REASONS.reviewBudgetExhausted);
      recordTaskEvent(db, taskId, 'review_budget_exhausted', session, {
        reviews: count,
        maxReviewRounds: spec.budget.maxReviewRounds,
      });
      throw new GovError(
        'E_BUDGET_EXCEEDED',
        `评审轮数已达上限 ${spec.budget.maxReviewRounds}(含中止)，转人工: ${taskId}`,
      );
    }

    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    if (repo === undefined) {
      throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在配置中: ${spec.repoId}`);
    }
    const seq = count + 1;
    const reviewId = randomId(REVIEW_ID_PREFIX);
    const jjName = `gr-${slugify(taskId)}-${seq}`;
    const wsRoot = join(repo.hostPath, '.gov-workspaces');
    const wsPath = join(wsRoot, jjName);
    const workspaceId = randomId(WORKSPACE_ID_PREFIX);
    let hostPath: string | undefined;

    /** 确定失败的资源回收（尽力而为）：评审环境 → 评审工作区。 */
    async function rollbackWorkspace(envInstanceId: string | null): Promise<string[]> {
      const errors: string[] = [];
      let envSettled = false;
      if (envInstanceId !== null) {
        try {
          await withStepTimeout(deps.env.destroy(envInstanceId), stepTimeoutMs, 'review_rollback_env');
          envSettled = true;
        } catch (cleanupErr) {
          errors.push(`env.destroy(${envInstanceId}): ${errorMessage(cleanupErr)}`);
        }
      }
      try {
        await withStepTimeout(deps.jj.workspaceForget(jjName), stepTimeoutMs, 'review_rollback_ws');
      } catch (cleanupErr) {
        errors.push(`jj.workspaceForget(${jjName}): ${errorMessage(cleanupErr)}`);
      }
      if (hostPath !== undefined && hostPath.startsWith(wsRoot)) {
        rmSync(hostPath, { recursive: true, force: true });
      }
      db.prepare('UPDATE workspaces SET env_status = ?, cleanup_status = ? WHERE workspace_id = ?').run(
        envSettled ? null : 'uncertain',
        'rolled_back',
        workspaceId,
      );
      return errors;
    }

    try {
      // 评审工作区：base 钉在受审提交上。
      mkdirSync(wsRoot, { recursive: true });
      const added = await withStepTimeout(
        deps.jj.workspaceAdd({ name: jjName, path: wsPath, rev: submission.commitId }),
        stepTimeoutMs,
        'review_workspace_add',
      );
      hostPath = realpathSync(added.path);
      db.prepare(
        'INSERT INTO workspaces (workspace_id, jj_workspace_name, host_path, base_commit_id) VALUES (?, ?, ?, ?)',
      ).run(workspaceId, jjName, hostPath, submission.commitId);

      // 评审环境：标准双层挂载；无 0000 门——完整性由结审 tree 检查保证。
      const taskDirRel = `${slugify(reviewId)}-r`;
      mkdirSync(join(hostPath, taskDirRel), { recursive: true });
      const created = await withStepTimeout(
        deps.env.create({ workspaceHostPath: hostPath, taskDirRel }),
        stepTimeoutMs,
        'review_env_create',
      );
      const envInstanceId = created.envInstanceId;
      await withStepTimeout(deps.env.setWritable(envInstanceId), stepTimeoutMs, 'review_env_set_writable');
      db.prepare('UPDATE workspaces SET env_instance_id = ?, env_status = ? WHERE workspace_id = ?').run(
        envInstanceId,
        'running',
        workspaceId,
      );

      // 评审者派工与身份三拒：候选身份取自派工回执（sessionId，缺失时退回
      // dispatchId）；命中禁任身份即停掉该派工换下一候选。
      let chosen: { dispatchId: string; identity: string } | undefined;
      for (let attempt = 1; attempt <= REVIEWER_CANDIDATE_LIMIT; attempt++) {
        const started = await withStepTimeout(
          deps.orca.workerStart({
            task: String(orcaTaskId),
            worktree: `path:${hostPath}`,
            agent: spec.agentPolicy.reviewer,
          }),
          stepTimeoutMs,
          'review_worker_start',
        );
        const raw = started.raw as { sessionId?: unknown; dispatchId: string };
        const identity = typeof raw.sessionId === 'string' && raw.sessionId.length > 0 ? raw.sessionId : raw.dispatchId;
        const rule = reviewerRejectionRule(db, taskId, identity);
        if (rule === null) {
          chosen = { dispatchId: raw.dispatchId, identity };
          break;
        }
        // 换人前先停掉被拒候选的派工（尽力而为，失败随拒绝事件一并留档）。
        let workerStopFailed: string | undefined;
        try {
          await withStepTimeout(deps.orca.workerStop(raw.dispatchId), stepTimeoutMs, 'review_worker_stop');
        } catch (stopErr) {
          workerStopFailed = errorMessage(stopErr);
        }
        recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.reviewerRejected, session, {
          reviewId,
          identity,
          rule,
          dispatchId: raw.dispatchId,
          attempt,
          ...(workerStopFailed !== undefined ? { workerStopFailed } : {}),
        });
      }
      if (chosen === undefined) {
        const rollbackErrors = await rollbackWorkspace(envInstanceId);
        setBlockedReason(db, taskId, BLOCKED_REASONS.noReviewer);
        recordCleanupIntent(db, taskId, session, {
          reason: 'no_reviewer',
          review: { reviewId, workspaceId, envInstanceId, dispatchId: null },
        });
        throw new GovError(
          'E_NO_REVIEWER',
          `连续 ${REVIEWER_CANDIDATE_LIMIT} 个评审者候选均命中身份禁任(声明者/历史认领者/当前认领者)，转人工: ${taskId}${
            rollbackErrors.length > 0 ? `; 回收残误: ${rollbackErrors.join('; ')}` : ''
          }`,
        );
      }

      // 评审行（verdict 以 aborted 占位——见文件头适配记录）+ reviewer 令牌。
      // 同一提交已有结论行时先作废该行（uq_reviews_conclusive_per_submission 只
      // 允许一行结论；历史结论以 reject/approve 事件为真源，作废事实以
      // review_superseded 事件为真源）。review-request 补证据重送即走此路径。
      withTransaction(db, (tx) => {
        const conclusive = tx
          .prepare("SELECT review_id, verdict FROM reviews WHERE submission_id = ? AND verdict <> 'aborted'")
          .get(submission.submissionId);
        if (conclusive !== undefined) {
          const supersededPayload = JSON.stringify({
            oldReviewId: String(conclusive.review_id),
            oldVerdict: String(conclusive.verdict),
            newReviewId: reviewId,
            reason: 'same_submission_new_round',
          });
          tx.prepare("UPDATE reviews SET verdict = 'aborted' WHERE review_id = ?").run(String(conclusive.review_id));
          tx.prepare(
            'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            taskId,
            REVIEW_EVENT_TYPES.superseded,
            session,
            supersededPayload,
            sha256Hex(supersededPayload),
            new Date().toISOString(),
          );
        }
        tx.prepare(
          `INSERT INTO reviews (review_id, submission_id, dispatch_id, reviewer_session, workspace_id, verdict, created_at)
           VALUES (?, ?, ?, ?, ?, 'aborted', ?)`,
        ).run(reviewId, submission.submissionId, chosen.dispatchId, chosen.identity, workspaceId, new Date().toISOString());
      });
      const issued = issueToken(db, {
        role: 'reviewer',
        taskId,
        reviewId,
        ttlSeconds: spec.budget.maxWallSeconds,
      });
      recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.created, session, {
        reviewId,
        submissionId: submission.submissionId,
        reviewerSession: chosen.identity,
        dispatchId: chosen.dispatchId,
        workspaceId,
        envInstanceId,
        round: seq,
      });

      return {
        taskId,
        reviewId,
        submissionId: submission.submissionId,
        reviewerSession: chosen.identity,
        reviewerToken: issued.token,
        reviewerCapabilityId: issued.capabilityId,
        workspaceId,
        envInstanceId,
        dispatchId: chosen.dispatchId,
        taskStatus: String(db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status),
        idempotentReplay: false,
      };
    } catch (err) {
      if (isUncertainOutcome(err)) {
        // 结果不确定：资源不回收（外部可能仍在建），交人工处置。
        throw err;
      }
      // no_reviewer 已自行回收；其余确定失败在此统一回收后原样上抛。
      if (!(err instanceof GovError && err.code === 'E_NO_REVIEWER')) {
        const envRow = db
          .prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?')
          .get(workspaceId);
        const rollbackErrors = await rollbackWorkspace(
          envRow?.env_instance_id === undefined || envRow.env_instance_id === null ? null : String(envRow.env_instance_id),
        );
        if (rollbackErrors.length > 0) {
          recordTaskEvent(db, taskId, 'review_create_rollback_errors', session, { reviewId, rollbackErrors });
        }
      }
      throw err;
    }
  }

  async function onMergeReady(input: { taskId: string; session: string }): Promise<ReviewSessionResult> {
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const submission = latestActiveSubmission(db, input.taskId);
    if (submission === undefined) {
      throw new GovError('E_REQUEST_INVALID', `任务无可审提交(onMergeReady): ${input.taskId}`);
    }
    const existing = latestReviewFor(db, submission.submissionId);
    if (
      existing !== undefined &&
      existing.verdict === 'aborted' &&
      !isReviewDead(db, input.taskId, existing.reviewId)
    ) {
      // 重复轮询的幂等分支：同一提交的活跃评审已建，返回既有事实（不二次暂停/建资源）。
      const wsRow =
        existing.workspaceId === null
          ? undefined
          : db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(existing.workspaceId);
      return {
        taskId: input.taskId,
        reviewId: existing.reviewId,
        submissionId: submission.submissionId,
        reviewerSession: existing.reviewerSession ?? '',
        reviewerToken: null,
        reviewerCapabilityId: null,
        workspaceId: existing.workspaceId ?? '',
        envInstanceId: wsRow?.env_instance_id === null || wsRow?.env_instance_id === undefined ? '' : String(wsRow.env_instance_id),
        dispatchId: existing.dispatchId ?? '',
        taskStatus: String(task.status),
        idempotentReplay: true,
      };
    }
    if (String(task.status) !== 'REVIEW_REQUESTED') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务状态 ${String(task.status)} 不可建评审(须 REVIEW_REQUESTED): ${input.taskId}`,
      );
    }
    return createReviewSession(input.taskId, submission, input.session);
  }

  async function reviewRequest(input: {
    taskId: string;
    claimId: string;
    tokenClaimId: string | null;
    session: string;
  }): Promise<ReviewSessionResult> {
    if (input.tokenClaimId === null || input.tokenClaimId !== input.claimId) {
      throw new GovError(
        'E_REVIEW_REQUEST_INVALID',
        `令牌未绑定该认领(令牌绑定 ${input.tokenClaimId ?? '无'}, 请求 ${input.claimId})`,
      );
    }
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    if (String(task.status) !== 'CHANGES_REQUESTED') {
      throw new GovError(
        'E_REVIEW_REQUEST_INVALID',
        `任务状态 ${String(task.status)} 不可补证据重送(须 CHANGES_REQUESTED): ${input.taskId}`,
      );
    }
    // 最近一次退回的 reasonClass 以 reject 事件为真源；仅证据/流程类允许同版本重送。
    const rejectRows = db
      .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
      .all(input.taskId, 'reject');
    const lastReject = rejectRows.map((row) => {
      try {
        return JSON.parse(String(row.payload_json)) as {
          reviewId?: unknown;
          submissionId?: unknown;
          reasonClass?: unknown;
        };
      } catch {
        return null;
      }
    })[0];
    if (lastReject === null || lastReject === undefined) {
      throw new GovError('E_REVIEW_REQUEST_INVALID', `任务无退回记录，不可 review request: ${input.taskId}`);
    }
    if (lastReject.reasonClass !== 'evidence' && lastReject.reasonClass !== 'process') {
      throw new GovError(
        'E_REVIEW_REQUEST_INVALID',
        `退回类型 ${String(lastReject.reasonClass)} 不允许同版本补证据重送(仅 evidence/process): ${input.taskId}`,
      );
    }
    const submission = latestActiveSubmission(db, input.taskId);
    if (submission === undefined || submission.submissionId !== lastReject.submissionId) {
      throw new GovError(
        'E_REVIEW_REQUEST_INVALID',
        `退回对应提交已不是当前有效提交(需重新 submit 或 rebase): ${input.taskId}`,
      );
    }
    // 版本仍为该 submission：开发工作副本自提交后未再改动。
    const dev = loadDevWorkspace(db, input.taskId);
    if (dev.claimId !== input.claimId) {
      throw new GovError('E_REVIEW_REQUEST_INVALID', `认领不是任务当前认领: ${input.claimId}`);
    }
    const snap = await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'review_request_snapshot');
    if (snap.commitId !== submission.commitId) {
      throw new GovError(
        'E_REVIEW_REQUEST_INVALID',
        `工作副本版本已离开受审提交(${snap.commitId} ≠ ${submission.commitId})，需重新提交: ${input.taskId}`,
      );
    }

    const sessionResult = await createReviewSession(input.taskId, submission, input.session);
    const transition = applyTaskTransition(db, input.taskId, 'review_request', {
      actor: input.session,
      payload: { reviewId: sessionResult.reviewId, submissionId: submission.submissionId },
    });
    return { ...sessionResult, taskStatus: transition.to };
  }

  async function reviewAccept(input: {
    taskId: string;
    reviewId: string;
    tokenReviewId: string | null;
    session: string;
  }): Promise<ReviewAcceptResult> {
    if (input.tokenReviewId === null || input.tokenReviewId !== input.reviewId) {
      throw new GovError(
        'E_REVIEW_FORBIDDEN',
        `令牌未绑定该评审(令牌绑定 ${input.tokenReviewId ?? '无'}, 请求 ${input.reviewId})`,
      );
    }
    const review = loadReview(db, input.reviewId);
    const submission = db
      .prepare('SELECT s.commit_id FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE s.submission_id = ? AND c.task_id = ?')
      .get(review.submissionId, input.taskId);
    if (submission === undefined) {
      throw new GovError('E_REQUEST_INVALID', `评审不属于该任务: ${input.reviewId}`);
    }
    if (review.verdict !== 'aborted') {
      throw new GovError('E_REQUEST_INVALID', `评审已出结论(${review.verdict})，不可再接受: ${input.reviewId}`);
    }
    if (isReviewDead(db, input.taskId, review.reviewId)) {
      throw new GovError('E_REQUEST_INVALID', `评审已被作废(需重建)，不可接受: ${input.reviewId}`);
    }
    const transition = applyTaskTransition(db, input.taskId, 'review_accept', {
      actor: input.session,
      payload: { reviewId: review.reviewId },
    });
    return { taskId: input.taskId, reviewId: review.reviewId, taskStatus: transition.to as 'IN_REVIEW' };
  }

  /**
   * 逐条证据核验：每条验收标准都有对应证据行且满足类型要求——command 型
   * exitCode==0；artifact 型哈希与提交侧开发证据清单一致；manual 型必须引用
   * 归属本任务该 criterion 的宿主 manual-approve 回执（伪造/跨任务/跨 criterion
   * 均 E_MANUAL_RECEIPT_INVALID），其余不符 E_REQUEST_INVALID。
   */
  function validateEvidence(
    taskId: string,
    spec: TaskSpec,
    submission: SubmissionRow,
    items: readonly EvidenceItem[],
  ): void {
    const byCriterion = new Map(items.map((item) => [item.criterionId, item]));
    for (const item of items) {
      if (!spec.acceptanceCriteria.some((c) => c.criterionId === item.criterionId)) {
        throw new GovError('E_REQUEST_INVALID', `证据引用未知 criterionId: ${item.criterionId}`);
      }
    }
    const manifestByCriterion = new Map(
      submissionManifest(db, taskId, submission.submissionId).map((item) => [item.criterionId, item]),
    );
    for (const criterion of spec.acceptanceCriteria) {
      const item = byCriterion.get(criterion.criterionId);
      if (item === undefined) {
        throw new GovError('E_REQUEST_INVALID', `验收标准 ${criterion.criterionId} 缺少评审证据`);
      }
      if (criterion.type === 'command') {
        if (item.exitCode !== 0) {
          throw new GovError(
            'E_REQUEST_INVALID',
            `命令型标准 ${criterion.criterionId} exitCode 非 0: ${String(item.exitCode ?? '缺失')}`,
          );
        }
      } else if (criterion.type === 'artifact') {
        if (item.artifactHash === undefined) {
          throw new GovError('E_REQUEST_INVALID', `artifact 标准 ${criterion.criterionId} 缺少 artifactHash`);
        }
        const declared = manifestByCriterion.get(criterion.criterionId)?.artifactHash;
        if (declared === undefined) {
          throw new GovError(
            'E_REQUEST_INVALID',
            `提交侧开发证据清单未声明 ${criterion.criterionId} 的 artifactHash，无法比对`,
          );
        }
        if (item.artifactHash !== declared) {
          throw new GovError(
            'E_REQUEST_INVALID',
            `artifact 标准 ${criterion.criterionId} 哈希不一致(评审 ${item.artifactHash}, 提交侧 ${declared})`,
          );
        }
      } else {
        if (item.manualDecisionId === undefined) {
          throw new GovError('E_REQUEST_INVALID', `manual 标准 ${criterion.criterionId} 缺少 manualDecisionId`);
        }
        verifyManualDecision(db, taskId, criterion.criterionId, item.manualDecisionId);
      }
    }
  }

  function validateFindings(findings: readonly FindingItem[], verdict: 'approved' | 'changes_requested'): void {
    for (const finding of findings) {
      if (finding.disposition === 'PARKED' && (finding.parkedReason === undefined || finding.parkedReason.length === 0)) {
        throw new GovError(
          'E_REQUEST_INVALID',
          `PARKED 问题缺停泊理由(severity=${finding.severity}): ${finding.note}`,
        );
      }
    }
    if (verdict !== 'approved') {
      return;
    }
    // 通过判定：OPEN 的中高严重度（critical/high/medium）阻止签核；low 必须全部
    // PARKED（含理由）或 RESOLVED——即任何 OPEN 问题都不能签核通过。
    for (const finding of findings) {
      if (finding.disposition !== 'OPEN') {
        continue;
      }
      if (finding.severity === 'low') {
        throw new GovError(
          'E_REQUEST_INVALID',
          `low 问题未停泊/未解决，阻止签核: ${finding.note}`,
        );
      }
      throw new GovError(
        'E_REQUEST_INVALID',
        `OPEN ${finding.severity} 问题阻止签核: ${finding.note}`,
      );
    }
  }

  /** 退回恢复：工作副本仍钉在受审提交 → 恢复开发环境并定向送达退回意见。 */
  async function recoverFromRejection(
    taskId: string,
    submission: SubmissionRow,
    session: string,
    reasonClass: string,
    findings: readonly FindingItem[],
  ): Promise<'sent' | 'skipped_no_dispatch' | 'send_failed'> {
    const dev = loadDevWorkspace(db, taskId);
    const snap = await withStepTimeout(deps.jj.snapshot(dev.hostPath), stepTimeoutMs, 'reject_recovery_snapshot');
    if (snap.commitId !== submission.commitId) {
      setBlockedReason(db, taskId, BLOCKED_REASONS.workspaceDiverged);
      recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.returnRecoveryBlocked, session, {
        reason: BLOCKED_REASONS.workspaceDiverged,
        expected: submission.commitId,
        actual: snap.commitId,
      });
      throw new GovError(
        'E_WORKSPACE_DIVERGED',
        `开发工作副本已偏离受审提交(${snap.commitId} ≠ ${submission.commitId})，退回恢复转人工: ${taskId}`,
      );
    }
    if (dev.envInstanceId !== null) {
      try {
        await withStepTimeout(deps.env.resume(dev.envInstanceId), stepTimeoutMs, 'reject_recovery_resume');
      } catch (err) {
        const message = errorMessage(err);
        setBlockedReason(db, taskId, BLOCKED_REASONS.envResumeFailed);
        recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.returnRecoveryBlocked, session, {
          reason: BLOCKED_REASONS.envResumeFailed,
          message,
        });
        throw isUncertainOutcome(err)
          ? new GovError('E_CLAIM_UNCERTAIN', `恢复开发环境结果不确定: ${message}`)
          : err instanceof GovError
            ? err
            : new GovError('E_ENV_LIFECYCLE_FAILED', `恢复开发环境失败(转人工): ${message}`);
      }
      db.prepare('UPDATE workspaces SET env_status = ? WHERE workspace_id = ?').run('running', dev.workspaceId);
      recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.devEnvResumed, session, { envInstanceId: dev.envInstanceId });
    }
    if (dev.dispatchId === null) {
      return 'skipped_no_dispatch';
    }
    const lines = findings.map(
      (f) => `[${f.severity}/${f.disposition}] ${f.note}${f.parkedReason !== undefined ? `（停泊理由: ${f.parkedReason}）` : ''}`,
    );
    try {
      await withStepTimeout(
        deps.orca.sendToDispatch({
          dispatch: dev.dispatchId,
          type: 'status',
          subject: `review 退回(${reasonClass}): ${taskId}`,
          body: lines.length > 0 ? lines.join('\n') : '(无逐项问题)',
        }),
        stepTimeoutMs,
        'reject_recovery_send',
      );
      return 'sent';
    } catch (err) {
      // 意见送达失败不改变任务状态（已在 CHANGES_REQUESTED，执行者可经 status 轮询）。
      recordTaskEvent(db, taskId, REVIEW_EVENT_TYPES.returnCommentsFailed, session, {
        dispatchId: dev.dispatchId,
        message: errorMessage(err),
      });
      return 'send_failed';
    }
  }

  async function reviewSubmit(input: {
    taskId: string;
    reviewId: string;
    tokenReviewId: string | null;
    session: string;
    payload: ReviewSubmitPayload;
  }): Promise<ReviewSubmitResult> {
    if (input.tokenReviewId === null || input.tokenReviewId !== input.reviewId) {
      throw new GovError(
        'E_REVIEW_FORBIDDEN',
        `令牌未绑定该评审(令牌绑定 ${input.tokenReviewId ?? '无'}, 请求 ${input.reviewId})`,
      );
    }
    const payload = input.payload;
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const review = loadReview(db, input.reviewId);
    const submissionRow = db
      .prepare(
        'SELECT s.submission_id, s.commit_id, s.tree_id, s.created_at FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE s.submission_id = ? AND c.task_id = ?',
      )
      .get(review.submissionId, input.taskId);
    if (submissionRow === undefined) {
      throw new GovError('E_REQUEST_INVALID', `评审不属于该任务: ${input.reviewId}`);
    }
    const submission: SubmissionRow = {
      submissionId: String(submissionRow.submission_id),
      claimId: '',
      commitId: String(submissionRow.commit_id),
      treeId: submissionRow.tree_id === null ? null : String(submissionRow.tree_id),
      createdAt: String(submissionRow.created_at),
    };
    if (review.verdict !== 'aborted') {
      throw new GovError('E_REQUEST_INVALID', `评审已出结论(${review.verdict}): ${input.reviewId}`);
    }
    if (String(task.status) !== 'IN_REVIEW') {
      throw new GovError(
        'E_REQUEST_INVALID',
        `任务状态 ${String(task.status)} 不可提交评审结论(须 IN_REVIEW): ${input.taskId}`,
      );
    }
    if (payload.verdict === 'changes_requested' && payload.reasonClass === undefined) {
      throw new GovError('E_REQUEST_INVALID', '退回必须携带 reasonClass(code|evidence|process)');
    }
    validateFindings(payload.findings, payload.verdict);

    // 结审 tree 检查：评审工作副本必须仍钉在受审提交——评审者改动被审版本即
    // 评审无效，作废回 REVIEW_REQUESTED 重建（结论不落库）。
    if (review.workspaceId === null) {
      throw new GovError('E_REQUEST_INVALID', `评审未绑定工作区: ${input.reviewId}`);
    }
    const reviewWs = db
      .prepare('SELECT host_path FROM workspaces WHERE workspace_id = ?')
      .get(review.workspaceId);
    if (reviewWs === undefined) {
      throw new GovError('E_REQUEST_INVALID', `评审工作区行缺失: ${review.workspaceId}`);
    }
    const snap = await withStepTimeout(
      deps.jj.snapshot(String(reviewWs.host_path)),
      stepTimeoutMs,
      'review_submit_snapshot',
    );
    if (snap.commitId !== submission.commitId) {
      applyTaskTransition(db, input.taskId, 'review_aborted', {
        actor: input.session,
        payload: { reviewId: review.reviewId, reason: 'review_tree_changed', expected: submission.commitId, actual: snap.commitId },
      });
      recordCleanupIntent(db, input.taskId, input.session, {
        reason: 'review_tree_changed',
        review: {
          reviewId: review.reviewId,
          workspaceId: review.workspaceId,
          envInstanceId: null,
          dispatchId: review.dispatchId,
        },
      });
      throw new GovError(
        'E_REVIEW_TREE_CHANGED',
        `评审工作副本已偏离受审提交(${snap.commitId} ≠ ${submission.commitId})，评审作废重建: ${input.reviewId}`,
      );
    }

    // 逐条证据核验（manual 伪造/跨引用在此拒绝）。
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    validateEvidence(input.taskId, spec, submission, payload.evidence);

    // 结论落库：评审行、findings、evidence 三者一事务（迁移紧随其后，见文件头顺序注记）。
    withTransaction(db, (tx) => {
      tx.prepare(
        'UPDATE reviews SET verdict = ?, report_ref = ?, reviewed_commit_id = ?, reviewed_tree_id = ? WHERE review_id = ?',
      ).run(payload.verdict, payload.reportRef, snap.commitId, snap.treeId, review.reviewId);
      const insertFinding = tx.prepare(
        'INSERT INTO findings (finding_id, review_id, submission_id, severity, status, note, parked_reason, resolved_in_submission_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const finding of payload.findings) {
        insertFinding.run(
          randomId(FINDING_ID_PREFIX),
          review.reviewId,
          submission.submissionId,
          finding.severity,
          finding.disposition,
          finding.note,
          finding.disposition === 'PARKED' ? (finding.parkedReason ?? null) : null,
          finding.disposition === 'RESOLVED' ? submission.submissionId : null,
        );
      }
      const insertEvidence = tx.prepare(
        'INSERT INTO evidence (evidence_id, criterion_id, review_id, commit_id, content_hash, exit_code, produced_by, manual_decision_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const item of payload.evidence) {
        insertEvidence.run(
          randomId(EVIDENCE_ID_PREFIX),
          item.criterionId,
          review.reviewId,
          submission.commitId,
          item.artifactHash ?? null,
          item.exitCode ?? null,
          'reviewer',
          item.manualDecisionId ?? null,
        );
      }
    });

    let taskStatus: string;
    if (payload.verdict === 'approved') {
      const transition = applyTaskTransition(db, input.taskId, 'approve', {
        actor: input.session,
        payload: { reviewId: review.reviewId, reportRef: payload.reportRef },
      });
      taskStatus = transition.to;
      db.prepare('UPDATE tasks SET reviewed_commit_id = ?, updated_at = ? WHERE task_id = ?').run(
        submission.commitId,
        new Date().toISOString(),
        input.taskId,
      );
    } else {
      const transition = applyTaskTransition(db, input.taskId, 'reject', {
        actor: input.session,
        payload: {
          reviewId: review.reviewId,
          submissionId: submission.submissionId,
          reasonClass: payload.reasonClass ?? null,
          reportRef: payload.reportRef,
          findings: payload.findings,
        },
      });
      taskStatus = transition.to;
    }

    // 评审资源销毁意图（T3.3 执行）。
    const reviewEnv = db
      .prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?')
      .get(review.workspaceId);
    recordCleanupIntent(db, input.taskId, input.session, {
      reason: payload.verdict === 'approved' ? 'review_approved' : 'review_rejected',
      review: {
        reviewId: review.reviewId,
        workspaceId: review.workspaceId,
        envInstanceId:
          reviewEnv?.env_instance_id === null || reviewEnv?.env_instance_id === undefined ? null : String(reviewEnv.env_instance_id),
        dispatchId: review.dispatchId,
      },
    });

    let delivery: 'sent' | 'skipped_no_dispatch' | 'send_failed' | null = null;
    if (payload.verdict === 'changes_requested') {
      delivery = await recoverFromRejection(
        input.taskId,
        submission,
        input.session,
        payload.reasonClass ?? 'evidence',
        payload.findings,
      );
    }

    return {
      taskId: input.taskId,
      reviewId: review.reviewId,
      submissionId: submission.submissionId,
      verdict: payload.verdict,
      taskStatus,
      findingsRecorded: payload.findings.length,
      evidenceRecorded: payload.evidence.length,
      returnDelivery: delivery,
    };
  }

  return { onMergeReady, reviewRequest, reviewAccept, reviewSubmit };
}

// ---------------------------------------------------------------------------
// api.ts 接线
// ---------------------------------------------------------------------------

export const findingItemSchema = z.strictObject({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  note: z.string().min(1),
  disposition: z.enum(['OPEN', 'PARKED', 'RESOLVED']),
  parkedReason: z.string().min(1).optional(),
});

const reviewSubmitPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  reviewId: z.string().min(1).optional(),
  verdict: z.enum(['approved', 'changes_requested']),
  reasonClass: z.enum(['code', 'evidence', 'process']).optional(),
  findings: z.array(findingItemSchema),
  evidence: z.array(evidenceItemSchema),
  reportRef: z.string().min(1),
});

const reviewAcceptPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  reviewId: z.string().min(1).optional(),
});

export interface ReviewHandlersDeps {
  readonly config: GovConfig;
  readonly orca: OrcaMessagingPort;
  readonly jj: JjVersionPort;
  readonly env: EnvLifecyclePort;
  readonly stepTimeoutMs?: number | undefined;
}

function buildService(deps: ReviewHandlersDeps, ctx: ActionContext): ReviewService {
  return createReviewService({
    db: ctx.db,
    config: deps.config,
    orca: deps.orca,
    jj: deps.jj,
    env: deps.env,
    ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
  });
}

export function createReviewAcceptHandler(deps: ReviewHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = reviewAcceptPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(review-accept): ${formatZodIssues(parsed.error)}`);
    }
    const reviewId = parsed.data.reviewId ?? ctx.token.reviewId ?? '';
    return buildService(deps, ctx).reviewAccept({
      taskId: parsed.data.taskId,
      reviewId,
      tokenReviewId: ctx.token.reviewId,
      session: ctx.token.capabilityId,
    });
  };
}

export function createReviewSubmitHandler(deps: ReviewHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = reviewSubmitPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(review-submit): ${formatZodIssues(parsed.error)}`);
    }
    const reviewId = parsed.data.reviewId ?? ctx.token.reviewId ?? '';
    return buildService(deps, ctx).reviewSubmit({
      taskId: parsed.data.taskId,
      reviewId,
      tokenReviewId: ctx.token.reviewId,
      session: ctx.token.capabilityId,
      payload: {
        verdict: parsed.data.verdict,
        ...(parsed.data.reasonClass !== undefined ? { reasonClass: parsed.data.reasonClass } : {}),
        findings: parsed.data.findings,
        evidence: parsed.data.evidence,
        reportRef: parsed.data.reportRef,
      },
    });
  };
}

const reviewRequestPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  claimId: z.string().min(1).optional(),
});

export function createReviewRequestHandler(deps: ReviewHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = reviewRequestPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(review-request): ${formatZodIssues(parsed.error)}`);
    }
    const claimId = parsed.data.claimId ?? ctx.token.claimId ?? '';
    return buildService(deps, ctx).reviewRequest({
      taskId: parsed.data.taskId,
      claimId,
      tokenClaimId: ctx.token.claimId,
      session: ctx.token.capabilityId,
    });
  };
}
