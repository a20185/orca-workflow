/**
 * 证据服务（T3.2，设计 §10）：宿主侧人工验收回执（manual-approve）与评审侧
 * 逐条证据的公共形状。
 *
 * 适配记录（相对简报字面）：evidence 表有 CHECK (submission_id XOR review_id)
 * 约束且两列均可空外键——人工回执在提交/评审存在之前就要能独立开具，落该表
 * 必然违反 XOR。因此人工回执以 events 行（type=manual_approve）为持久真源，
 * 载荷携带 manualDecisionId/criterionId/note，actor 即操作者令牌身份、
 * created_at 即时间；评审提交时逐条核验从这里读。evidence 表行在 review-submit
 * 时以 review_id 落库（见 reviews.ts）。容器侧无 operator 令牌（T1.3 车道），
 * 伪造回执在鉴权面不可达；跨任务/跨 criterion 引用在核验时拒绝。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

/** 人工验收回执事件 type 值（review-submit 校验按此读取）。 */
export const MANUAL_APPROVE_EVENT_TYPE = 'manual_approve';

export const MANUAL_DECISION_PREFIX = 'gmd_';

/** 逐条证据（评审提交载荷与提交侧开发证据清单共用同一形状）。 */
export const evidenceItemSchema = z.strictObject({
  criterionId: z.string().min(1),
  exitCode: z.number().int().optional(),
  artifactHash: z.string().min(1).optional(),
  manualDecisionId: z.string().min(1).optional(),
});

export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

export interface ManualApproveDeps {
  readonly db: DatabaseSync;
}

export interface ManualApproveInput {
  readonly taskId: string;
  readonly criterionId: string;
  /** 操作者令牌身份（capabilityId），落事件 actor。 */
  readonly session: string;
  readonly note?: string | undefined;
}

export interface ManualApproveResult {
  readonly manualDecisionId: string;
  readonly taskId: string;
  readonly criterionId: string;
  readonly operator: string;
  readonly approvedAt: string;
}

export interface ManualDecisionRecord {
  readonly manualDecisionId: string;
  readonly taskId: string;
  readonly criterionId: string;
  readonly operator: string;
  readonly approvedAt: string;
}

function recordEvent(
  db: DatabaseSync,
  taskId: string,
  type: string,
  actor: string,
  payload: unknown,
): void {
  const json = JSON.stringify(payload);
  db.prepare(
    'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(
    taskId,
    type,
    actor,
    json,
    // 与 applyTaskTransition 同口径：载荷哈希随事件落库，篡改可检测。
    createHash('sha256').update(json, 'utf8').digest('hex'),
    new Date().toISOString(),
  );
}

export function manualApprove(deps: ManualApproveDeps, input: ManualApproveInput): ManualApproveResult {
  const task = deps.db.prepare('SELECT task_id FROM tasks WHERE task_id = ?').get(input.taskId);
  if (task === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
  }
  const criterion = deps.db
    .prepare('SELECT criterion_id FROM acceptance_criteria WHERE task_id = ? AND criterion_id = ?')
    .get(input.taskId, input.criterionId);
  if (criterion === undefined) {
    throw new GovError(
      'E_REQUEST_INVALID',
      `criterionId 不属于该任务: ${input.criterionId} (任务 ${input.taskId})`,
    );
  }

  const manualDecisionId = MANUAL_DECISION_PREFIX + randomBytes(12).toString('base64url');
  const approvedAt = new Date().toISOString();
  recordEvent(deps.db, input.taskId, MANUAL_APPROVE_EVENT_TYPE, input.session, {
    manualDecisionId,
    criterionId: input.criterionId,
    note: input.note ?? null,
  });
  return {
    manualDecisionId,
    taskId: input.taskId,
    criterionId: input.criterionId,
    operator: input.session,
    approvedAt,
  };
}

/**
 * 核验一条人工回执：manualDecisionId 必须真实存在、归属本任务且归属该
 * criterion。任一不符（含编造 id、跨任务/跨 criterion 引用）抛
 * E_MANUAL_RECEIPT_INVALID——review-submit 据此拒绝伪造人工证据。
 */
export function verifyManualDecision(
  db: DatabaseSync,
  taskId: string,
  criterionId: string,
  manualDecisionId: string,
): ManualDecisionRecord {
  const rows = db
    .prepare(
      'SELECT task_id, actor, payload_json, created_at FROM events WHERE type = ? AND task_id = ? ORDER BY seq DESC',
    )
    .all(MANUAL_APPROVE_EVENT_TYPE, taskId);
  for (const row of rows) {
    let payload: unknown;
    try {
      payload = JSON.parse(String(row.payload_json));
    } catch {
      continue;
    }
    const record = payload as { manualDecisionId?: unknown; criterionId?: unknown };
    if (record.manualDecisionId !== manualDecisionId) {
      continue;
    }
    if (record.criterionId !== criterionId) {
      throw new GovError(
        'E_MANUAL_RECEIPT_INVALID',
        `人工回执归属其他 criterion: ${manualDecisionId} (回执 ${String(record.criterionId)}, 请求 ${criterionId})`,
      );
    }
    return {
      manualDecisionId,
      taskId,
      criterionId,
      operator: row.actor === null ? '' : String(row.actor),
      approvedAt: String(row.created_at),
    };
  }
  throw new GovError(
    'E_MANUAL_RECEIPT_INVALID',
    `人工回执不存在或不属于该任务: ${manualDecisionId} (任务 ${taskId})`,
  );
}

// ---------------------------------------------------------------------------
// api.ts 接线（operator 动作；鉴权/幂等由 T1.3 信封处理）
// ---------------------------------------------------------------------------

const manualApprovePayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  criterionId: z.string().min(1),
  note: z.string().min(1).optional(),
});

export function createManualApproveHandler(): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = manualApprovePayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(manual-approve): ${formatZodIssues(parsed.error)}`);
    }
    return manualApprove(
      { db: ctx.db },
      {
        taskId: parsed.data.taskId,
        criterionId: parsed.data.criterionId,
        session: ctx.token.capabilityId,
        ...(parsed.data.note !== undefined ? { note: parsed.data.note } : {}),
      },
    );
  };
}
