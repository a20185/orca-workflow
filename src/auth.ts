/**
 * 角色令牌（设计 §4/§9）：明文 token 只在 issueToken 的返回值里出现一次，
 * 库中只落 sha256。身份判定只认令牌，不认请求里自报的任何身份字段
 * （如 payload.session_id）——「客户端不能自行指定身份」。
 *
 * 本模块与 server.ts / api.ts / operations.ts 在整条调用链上禁止
 * import node:child_process：鉴权与签发路径不派生任何外部进程，这也是
 * 「数据库事务中不调用外部进程」约束在宿主面的落法。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GovError } from './domain/errors.ts';
import { GOV_ACTIONS_BY_ROLE, GOV_ROLES, type GovRole } from './domain/roles.ts';

const TOKEN_PREFIX = 'govt_';
const CAPABILITY_PREFIX = 'gcap_';

/** 可选字段显式含 undefined：exactOptionalPropertyTypes 下调用方可直接透传。 */
export interface IssueTokenInput {
  readonly role: GovRole;
  readonly taskId?: string | undefined;
  readonly claimId?: string | undefined;
  readonly reviewId?: string | undefined;
  readonly actions?: readonly string[] | undefined;
  readonly ttlSeconds?: number | undefined;
}

export interface IssuedToken {
  /** 明文令牌，仅此次返回；重启后不可再取回（库中只有 sha256）。 */
  readonly token: string;
  readonly capabilityId: string;
  readonly actions: readonly string[];
  readonly expiresAt: string | null;
}

/** authenticate 成功后随调用链下发的令牌事实；不含任何哈希或明文。 */
export interface TokenInfo {
  readonly capabilityId: string;
  readonly role: GovRole;
  readonly taskId: string | null;
  readonly claimId: string | null;
  readonly reviewId: string | null;
  readonly actions: readonly string[];
  readonly expiresAt: string | null;
}

export interface AuthenticateInput {
  readonly action: string;
  /** 请求侧声明的任务归属（取自 payload.taskId），仅用于与令牌绑定比对。 */
  readonly taskId?: string | undefined;
}

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function parseActionsJson(raw: string | null): readonly string[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.every((item) => typeof item === 'string')) {
      throw new Error('不是字符串数组');
    }
    return parsed as readonly string[];
  } catch {
    throw new GovError('E_UNAUTHENTICATED', '令牌动作清单损坏');
  }
}

/**
 * 签发令牌并写 capabilities 行。executor/reviewer 的动作全部发生在具体任务
 * 上，必须绑定 taskId；coordinator/operator 可不绑（简报 §令牌模型）。
 * 显式传入 actions 用于引导型令牌（如附带 token-issue 的首启 operator）。
 */
export function issueToken(db: DatabaseSync, input: IssueTokenInput): IssuedToken {
  if (!(GOV_ROLES as readonly string[]).includes(input.role)) {
    throw new GovError('E_REQUEST_INVALID', `未知角色: ${String(input.role)}`);
  }
  const mustBindTask = input.role === 'executor' || input.role === 'reviewer';
  if (mustBindTask && input.taskId === undefined) {
    throw new GovError('E_REQUEST_INVALID', `${input.role} 令牌必须绑定 taskId`);
  }

  const actions = input.actions ?? GOV_ACTIONS_BY_ROLE[input.role];
  const token = TOKEN_PREFIX + randomBytes(32).toString('base64url');
  const capabilityId = CAPABILITY_PREFIX + randomBytes(12).toString('base64url');
  const expiresAt =
    input.ttlSeconds === undefined
      ? null
      : new Date(Date.now() + input.ttlSeconds * 1000).toISOString();

  db.prepare(
    `INSERT INTO capabilities
       (capability_id, token_hash, role, task_id, claim_id, review_id, actions_json, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    capabilityId,
    sha256Hex(token),
    input.role,
    input.taskId ?? null,
    input.claimId ?? null,
    input.reviewId ?? null,
    JSON.stringify(actions),
    expiresAt,
  );

  return { token, capabilityId, actions, expiresAt };
}

/**
 * 用明文令牌换取调用身份。失败路径按序：哈希不存在与已吊销均归
 * E_UNAUTHENTICATED；过期 E_TOKEN_EXPIRED；动作不在令牌清单
 * E_FORBIDDEN_ACTION；令牌绑定任务与请求任务不符 E_FORBIDDEN_ACTION。
 * 请求中的自报身份字段在本函数入参之外，天然不可能参与判定。
 */
export function authenticate(db: DatabaseSync, token: string, input: AuthenticateInput): TokenInfo {
  const row = db
    .prepare(
      `SELECT capability_id, role, task_id, claim_id, review_id, actions_json, expires_at, revoked_at
         FROM capabilities WHERE token_hash = ?`,
    )
    .get(sha256Hex(token));
  if (row === undefined) {
    throw new GovError('E_UNAUTHENTICATED', '令牌无效');
  }
  if (row.revoked_at !== null) {
    throw new GovError('E_UNAUTHENTICATED', '令牌已吊销');
  }
  const expiresAt = row.expires_at === null ? null : String(row.expires_at);
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
    throw new GovError('E_TOKEN_EXPIRED', `令牌已过期: ${expiresAt}`);
  }
  const actions = parseActionsJson(row.actions_json === null ? null : String(row.actions_json));
  if (!actions.includes(input.action)) {
    throw new GovError('E_FORBIDDEN_ACTION', `动作不在令牌授权内: ${input.action}`);
  }
  const boundTaskId = row.task_id === null ? null : String(row.task_id);
  if (boundTaskId !== null && input.taskId !== boundTaskId) {
    throw new GovError(
      'E_FORBIDDEN_ACTION',
      `令牌绑定任务 ${boundTaskId}，与请求任务不符: ${input.taskId ?? '(未声明)'}`,
    );
  }

  return {
    capabilityId: String(row.capability_id),
    role: row.role as GovRole,
    taskId: boundTaskId,
    claimId: row.claim_id === null ? null : String(row.claim_id),
    reviewId: row.review_id === null ? null : String(row.review_id),
    actions,
    expiresAt,
  };
}

/** 吊销令牌（幂等）：命中未吊销行返回 true，令牌不存在或已吊销返回 false。 */
export function revokeToken(db: DatabaseSync, token: string): boolean {
  const result = db
    .prepare('UPDATE capabilities SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
    .run(new Date().toISOString(), sha256Hex(token));
  return Number(result.changes) > 0;
}
