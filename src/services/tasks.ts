/**
 * 任务声明服务（T3.1 declare，设计 §8.1）：任务书全量校验 → 事务写
 * tasks + acceptance_criteria + declared 事件 → 非事务 orca.taskCreate 并回填
 * orcaTaskId。
 *
 * 声明失败不回滚任务行：置 blockedReason 留待重试（同 taskId 同任务书的重复
 * 声明幂等返回既有登记结果）。Orca 登记放在事务外——「数据库事务中不调用
 * 外部进程」是全仓铁律。
 *
 * declared 事件携带完整任务书（canonical）：tasks 表没有 spec 载荷列（T1.2
 * 迁移已冻结），claim/accept 需要的 baseCommitId、agentPolicy、budget、
 * ownedPaths 以该事件为持久真源，读取时重过 schema 并核对 specHash。
 */
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/database.ts';
import type { GovConfig } from '../config.ts';
import { GovError } from '../domain/errors.ts';
import { normalizeTaskSpec, parseTaskSpec, type TaskSpec } from '../domain/task-spec.ts';
import type { OrcaPort } from './ports.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

export interface DeclareDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: OrcaPort;
}

export interface DeclareResult {
  readonly taskId: string;
  readonly specHash: string;
  readonly orcaTaskId: string;
}

/** 声明在 Orca 登记失败时的 tasks.blocked_reason 标记（重试成功后清除）。 */
export const DECLARE_BLOCKED_REASON = 'orca_task_create_failed';

/** declared 事件的 type 值（claims 服务按此读取任务书持久真源）。 */
export const DECLARED_EVENT_TYPE = 'declared';

/**
 * 读取任务的声明任务书：取最近一条 declared 事件，重过 schema 与配置交叉
 * 校验，并核对 specHash 与 tasks 行一致（库内载荷被篡改/漂移即拒绝）。
 */
export function loadDeclaredSpec(db: DatabaseSync, taskId: string, config: GovConfig): TaskSpec {
  const row = db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC LIMIT 1')
    .get(taskId, DECLARED_EVENT_TYPE);
  if (row === undefined) {
    throw new GovError('E_REQUEST_INVALID', `任务缺声明事件(无法恢复任务书): ${taskId}`);
  }
  let payload: unknown;
  try {
    payload = JSON.parse(String(row.payload_json));
  } catch {
    throw new GovError('E_REQUEST_INVALID', `声明事件载荷不是合法 JSON: ${taskId}`);
  }
  const specInput = (payload as { spec?: unknown } | null)?.spec;
  const spec = parseTaskSpec(specInput, config);
  const { specHash } = normalizeTaskSpec(spec);
  const task = db.prepare('SELECT spec_hash FROM tasks WHERE task_id = ?').get(taskId);
  if (task === undefined || String(task.spec_hash) !== specHash) {
    throw new GovError('E_REQUEST_INVALID', `声明事件任务书与 tasks 行 specHash 不一致: ${taskId}`);
  }
  return spec;
}

function buildSpecSummary(spec: TaskSpec, specHash: string): string {
  // 首版 declare 不带 deps/parent（split 场景 T4.2 扩展）：摘要即可分派。
  return JSON.stringify({
    taskId: spec.taskId,
    specHash,
    acceptanceCriteria: spec.acceptanceCriteria.map((c) => ({ criterionId: c.criterionId, type: c.type })),
  });
}

export async function declareTask(
  deps: DeclareDeps,
  input: {
    readonly spec: unknown;
    /** 声明者令牌身份（capabilityId），落 declared_session 与事件 actor。 */
    readonly session: string;
  },
): Promise<DeclareResult> {
  const spec = parseTaskSpec(input.spec, deps.config);
  const { canonical, specHash } = normalizeTaskSpec(spec);
  const db = deps.db;

  const existing = db
    .prepare('SELECT spec_hash, status, orca_task_id FROM tasks WHERE task_id = ?')
    .get(spec.taskId);
  if (existing !== undefined) {
    if (String(existing.spec_hash) !== specHash) {
      throw new GovError('E_REQUEST_INVALID', `taskId 已存在且任务书内容不一致: ${spec.taskId}`);
    }
    if (existing.orca_task_id !== null) {
      return { taskId: spec.taskId, specHash, orcaTaskId: String(existing.orca_task_id) };
    }
    if (String(existing.status) !== 'DECLARED') {
      throw new GovError('E_CLAIM_STATE_INVALID', `任务已离开 DECLARED，不能重试声明: ${spec.taskId}`);
    }
    // 首次登记失败后的重试：任务行与事件已在，直接走 Orca 登记步骤。
  } else {
    const now = new Date().toISOString();
    withTransaction(db, (tx) => {
      tx.prepare(
        `INSERT INTO tasks (task_id, spec_hash, status, target_json, declared_session, created_at, updated_at)
         VALUES (?, ?, 'DECLARED', ?, ?, ?, ?)`,
      ).run(spec.taskId, specHash, JSON.stringify(spec.target), input.session, now, now);
      const insertCriterion = tx.prepare(
        'INSERT INTO acceptance_criteria (task_id, criterion_id, type, config_json, requires_manual) VALUES (?, ?, ?, ?, ?)',
      );
      for (const criterion of spec.acceptanceCriteria) {
        insertCriterion.run(
          spec.taskId,
          criterion.criterionId,
          criterion.type,
          JSON.stringify(criterion.config),
          criterion.type === 'manual' ? 1 : 0,
        );
      }
      tx.prepare(
        'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(
        spec.taskId,
        DECLARED_EVENT_TYPE,
        input.session,
        JSON.stringify({ specHash, spec: JSON.parse(canonical) }),
        specHash,
        now,
      );
    });
  }

  try {
    const receipt = await deps.orca.taskCreate({
      spec: buildSpecSummary(spec, specHash),
      taskTitle: spec.taskId,
    });
    const orcaTaskId = receipt.raw.task.id;
    db.prepare('UPDATE tasks SET orca_task_id = ?, blocked_reason = NULL, updated_at = ? WHERE task_id = ?').run(
      orcaTaskId,
      new Date().toISOString(),
      spec.taskId,
    );
    return { taskId: spec.taskId, specHash, orcaTaskId };
  } catch (err) {
    // 任务行保留（DECLARED + blockedReason）：调用方可换新 requestId 重试声明。
    db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
      DECLARE_BLOCKED_REASON,
      new Date().toISOString(),
      spec.taskId,
    );
    throw err;
  }
}

/** api.ts 接线用：declare 的 handler 工厂（鉴权/幂等由 T1.3 信封处理）。 */
export function createDeclareHandler(deps: {
  readonly config: GovConfig;
  readonly orca: OrcaPort;
}): ActionHandler {
  return async (ctx: ActionContext) =>
    declareTask(
      { db: ctx.db, config: deps.config, orca: deps.orca },
      { spec: ctx.payload, session: ctx.token.capabilityId },
    );
}
