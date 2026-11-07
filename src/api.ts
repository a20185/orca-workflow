/**
 * 动作分发注册表与 T1.3 三个真实现（doctor / status / token-issue）。
 * T3.x 业务动词后续经 registerHandler 接入；契约内（§9.1）未注册动作由
 * server 层返回 E_ACTION_UNIMPLEMENTED。
 *
 * 本模块与 server.ts / auth.ts / operations.ts 在整条调用链上禁止
 * import node:child_process：payload 的任何字段只作为数据查库或校验，
 * 绝不拼接为 shell 命令或文件路径执行。
 */
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { assertRuntime, loadConfig, type GovConfig } from './config.ts';
import { MIGRATIONS } from './db/migrations.ts';
import { openDatabase } from './db/database.ts';
import { formatZodIssues, GovError } from './domain/errors.ts';
import { GOV_ACTIONS_BY_ROLE, GOV_ROLES } from './domain/roles.ts';
import { issueToken, type TokenInfo } from './auth.ts';
import { createDeclareHandler } from './services/tasks.ts';
import {
  createAcceptHandler,
  createClaimHandler,
  type ClaimHandlersDeps,
} from './services/claims.ts';

export interface ActionContext {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly config: GovConfig;
  readonly configPath: string;
  readonly token: TokenInfo;
  readonly payload: unknown;
}

export type ActionHandler = (ctx: ActionContext) => Promise<unknown>;

export interface HandlerRegistry {
  registerHandler(action: string, handler: ActionHandler): void;
  lookup(action: string): ActionHandler | undefined;
}

export function createHandlerRegistry(): HandlerRegistry {
  const handlers = new Map<string, ActionHandler>();
  return {
    registerHandler(action, handler) {
      handlers.set(action, handler);
    },
    lookup(action) {
      return handlers.get(action);
    },
  };
}

/** §9.1 全部动作名；token-issue 是引导型签发动作，随 doctor 一并视为合法名。 */
const KNOWN_ACTION_NAMES: readonly string[] = [
  ...new Set(Object.values(GOV_ACTIONS_BY_ROLE).flat()),
  'token-issue',
];

export function isValidActionName(action: string): boolean {
  return KNOWN_ACTION_NAMES.includes(action);
}

function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, action: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new GovError('E_REQUEST_INVALID', `payload 校验失败(${action}): ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const doctorPayloadSchema = z.strictObject({});

interface DoctorItem {
  readonly ok: boolean;
  readonly error?: string;
  readonly [detail: string]: unknown;
}

function checkNode(): DoctorItem {
  try {
    assertRuntime(process.version);
    return { ok: true, version: process.version };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

async function checkConfig(configPath: string): Promise<DoctorItem> {
  try {
    const config = await loadConfig(configPath);
    return { ok: true, repoCount: config.repos.length };
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

/** 用独立连接真开一次库文件并核对迁移已到最新——宿主连接活着不代表文件健康。 */
function checkDb(dbPath: string): DoctorItem {
  try {
    const probe = openDatabase(dbPath);
    try {
      const applied = probe
        .prepare('SELECT id FROM migrations ORDER BY id ASC')
        .all()
        .map((row) => Number(row.id));
      const latest = MIGRATIONS.map((m) => m.id);
      const upToDate =
        applied.length === latest.length && applied.every((id, i) => id === latest[i]);
      if (!upToDate) {
        return { ok: false, error: `迁移未到最新: 库中 [${applied.join(',')}]，程序 [${latest.join(',')}]` };
      }
      return { ok: true, migrationIds: applied };
    } finally {
      probe.close();
    }
  } catch (err) {
    return { ok: false, error: errorMessage(err) };
  }
}

function doctorHandler(): ActionHandler {
  return async (ctx) => {
    parsePayload(doctorPayloadSchema, ctx.payload, 'doctor');
    return {
      node: checkNode(),
      config: await checkConfig(ctx.configPath),
      db: checkDb(ctx.dbPath),
    };
  };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

const statusPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  // 客户端自报身份字段：接受并随 operations 回执留档，但绝不参与鉴权判定。
  session_id: z.string().min(1).optional(),
});

interface TaskView {
  readonly taskId: string;
  readonly status: string;
  readonly blockedReason: string | null;
  readonly parentTaskId: string | null;
  readonly currentClaimId: string | null;
  readonly target: unknown;
  readonly reviewedCommitId: string | null;
  readonly mergedCommitId: string | null;
  readonly declaredSession: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

const statusHandler: ActionHandler = async (ctx) => {
  const input = parsePayload(statusPayloadSchema, ctx.payload, 'status');
  const taskRow = ctx.db
    .prepare(
      `SELECT task_id, status, blocked_reason, parent_task_id, current_claim_id, target_json,
              reviewed_commit_id, merged_commit_id, declared_session, created_at, updated_at
         FROM tasks WHERE task_id = ?`,
    )
    .get(input.taskId);
  if (taskRow === undefined) {
    throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
  }

  let target: unknown = null;
  try {
    target = JSON.parse(String(taskRow.target_json));
  } catch {
    target = String(taskRow.target_json);
  }
  const task: TaskView = {
    taskId: String(taskRow.task_id),
    status: String(taskRow.status),
    blockedReason: taskRow.blocked_reason === null ? null : String(taskRow.blocked_reason),
    parentTaskId: taskRow.parent_task_id === null ? null : String(taskRow.parent_task_id),
    currentClaimId: taskRow.current_claim_id === null ? null : String(taskRow.current_claim_id),
    target,
    reviewedCommitId: taskRow.reviewed_commit_id === null ? null : String(taskRow.reviewed_commit_id),
    mergedCommitId: taskRow.merged_commit_id === null ? null : String(taskRow.merged_commit_id),
    declaredSession: String(taskRow.declared_session),
    createdAt: String(taskRow.created_at),
    updatedAt: String(taskRow.updated_at),
  };

  let currentClaim: Record<string, unknown> | null = null;
  if (task.currentClaimId !== null) {
    const claimRow = ctx.db
      .prepare(
        `SELECT claim_id, task_id, status, dispatch_id, claimer_session, terminal_handle,
                workspace_id, created_at, updated_at
           FROM claims WHERE claim_id = ?`,
      )
      .get(task.currentClaimId);
    if (claimRow !== undefined) {
      currentClaim = {
        claimId: String(claimRow.claim_id),
        taskId: String(claimRow.task_id),
        status: String(claimRow.status),
        dispatchId: claimRow.dispatch_id === null ? null : String(claimRow.dispatch_id),
        claimerSession: claimRow.claimer_session === null ? null : String(claimRow.claimer_session),
        terminalHandle:
          claimRow.terminal_handle === null ? null : String(claimRow.terminal_handle),
        workspaceId: claimRow.workspace_id === null ? null : String(claimRow.workspace_id),
        createdAt: String(claimRow.created_at),
        updatedAt: String(claimRow.updated_at),
      };
    }
  }

  return { task, currentClaim };
};

// ---------------------------------------------------------------------------
// token-issue
// ---------------------------------------------------------------------------

const tokenIssuePayloadSchema = z.strictObject({
  role: z.enum(GOV_ROLES),
  taskId: z.string().min(1).optional(),
  ttlSeconds: z.number().int().min(1).optional(),
});

const tokenIssueHandler: ActionHandler = async (ctx) => {
  // 双保险：正常路径下无 token-issue 动作的令牌已在 authenticate 被拒。
  if (ctx.token.role !== 'operator') {
    throw new GovError('E_FORBIDDEN_ACTION', 'token-issue 仅 operator 令牌可调用');
  }
  const input = parsePayload(tokenIssuePayloadSchema, ctx.payload, 'token-issue');
  const issued = issueToken(ctx.db, {
    role: input.role,
    taskId: input.taskId,
    ttlSeconds: input.ttlSeconds,
  });
  return {
    token: issued.token,
    capabilityId: issued.capabilityId,
    role: input.role,
    taskId: input.taskId ?? null,
    actions: issued.actions,
    expiresAt: issued.expiresAt,
  };
};

// ---------------------------------------------------------------------------

export interface CoreHandlerDeps {
  readonly config: GovConfig;
  readonly configPath: string;
  /** T3.1 声明/认领/接受的端口依赖；注入后三个 handler 才注册（真实适配器注入归 T6.x）。 */
  readonly claimDeps?: ClaimHandlersDeps | undefined;
}

/** 注册 T1.3 的三个真实现；其余动作保持未注册（E_ACTION_UNIMPLEMENTED）。 */
export function registerCoreHandlers(registry: HandlerRegistry, deps: CoreHandlerDeps): void {
  registry.registerHandler('doctor', doctorHandler());
  registry.registerHandler('status', statusHandler);
  registry.registerHandler('token-issue', tokenIssueHandler);
  if (deps.claimDeps !== undefined) {
    registry.registerHandler('declare', createDeclareHandler(deps.claimDeps));
    registry.registerHandler('claim', createClaimHandler(deps.claimDeps));
    registry.registerHandler('accept', createAcceptHandler(deps.claimDeps));
  }
}
