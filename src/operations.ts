/**
 * 请求幂等账本：requestId 唯一键 + 请求哈希（sha256 of 规范化 JSON）。
 * 同 ID 同哈希 → 重放已存回执（不重执行）；同 ID 异哈希 → E_REQUEST_HASH_MISMATCH
 * （先查后插快路径，T1.2 触发器/唯一索引作并发兜底）。
 *
 * 本模块与 server.ts / api.ts / auth.ts 在整条调用链上禁止
 * import node:child_process；账本读写只发生在 SQLite 事务内，不派生外部进程。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { GovError } from './domain/errors.ts';

/** 请求体字节上限；超出由 server 层以 E_PAYLOAD_TOO_LARGE 拒绝。 */
export const MAX_REQUEST_BYTES = 1024 * 1024;

const OPERATION_PREFIX = 'gop_';
const TOKEN_PLAINTEXT_PATTERN = /^govt_[A-Za-z0-9_-]+$/;
const MASKED_TOKEN = '<token-masked>';

/** 落库回执的形状：重放时按原 httpStatus 原样回给客户端。 */
export interface StoredReceipt {
  readonly httpStatus: number;
  readonly body: unknown;
}

export interface BeginOperationInput {
  readonly requestId: string;
  readonly requestHash: string;
  /** 动作名（简报：kind=action 名）。 */
  readonly kind: string;
}

export type BeginOperationResult =
  | { readonly type: 'start'; readonly operationId: string }
  | { readonly type: 'replay'; readonly receipt: StoredReceipt | null; readonly status: string }
  | { readonly type: 'in_flight' };

/** 键序无关的稳定序列化（与 task-spec.normalizeTaskSpec 同一算法，真源各自持有）。 */
function sortKeysDeep(value: unknown): unknown {
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

/** 请求哈希 = sha256(规范化 JSON(requestId+action+payload))；键序不影响结果。 */
export function canonicalRequestHash(
  requestId: string,
  action: string,
  payload: unknown,
): string {
  const canonical = JSON.stringify(sortKeysDeep({ requestId, action, payload }));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * 开始一次调用：已有同 ID 行则按哈希分派重放/拒绝；否则写入 IN_FLIGHT 行
 * （此时尚未执行任何 handler）。并发兜底：插入撞唯一索引时重查按既有行分派。
 */
export function beginOperation(
  db: DatabaseSync,
  input: BeginOperationInput,
): BeginOperationResult {
  const existing = db
    .prepare(
      'SELECT operation_id, request_hash, status, receipt_json FROM operations WHERE request_id = ?',
    )
    .get(input.requestId);

  if (existing !== undefined) {
    if (String(existing.request_hash) !== input.requestHash) {
      throw new GovError(
        'E_REQUEST_HASH_MISMATCH',
        `requestId 已存在且请求哈希不一致: ${input.requestId}`,
      );
    }
    if (existing.status === 'IN_FLIGHT' || existing.status === 'PREPARED') {
      return { type: 'in_flight' };
    }
    const receipt =
      existing.receipt_json === null
        ? null
        : (JSON.parse(String(existing.receipt_json)) as StoredReceipt);
    return { type: 'replay', receipt, status: String(existing.status) };
  }

  const operationId = OPERATION_PREFIX + randomBytes(12).toString('base64url');
  const now = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO operations
         (operation_id, request_id, request_hash, kind, status, current_step, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'IN_FLIGHT', 'dispatch', ?, ?)`,
    ).run(operationId, input.requestId, input.requestHash, input.kind, now, now);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes('request_hash')) {
      // T1.2 触发器文案：同 id 异哈希在插入前被拦。
      throw new GovError(
        'E_REQUEST_HASH_MISMATCH',
        `requestId 已存在且请求哈希不一致: ${input.requestId}`,
      );
    }
    if (message.includes('UNIQUE')) {
      // 同 id 同哈希并发插入：按既有行分派（单连接宿主下理论上不触发）。
      return beginOperation(db, input);
    }
    throw err;
  }
  return { type: 'start', operationId };
}

/**
 * 结束一次调用：终态 CONFIRMED / FAILED / UNCERTAIN，回执经 deepMaskGovTokens
 * 机械遮蔽后落库——任何 govt_ 明文令牌不可能进入 operations 表。
 */
export function finalizeOperation(
  db: DatabaseSync,
  operationId: string,
  status: 'CONFIRMED' | 'FAILED' | 'UNCERTAIN',
  receipt: StoredReceipt,
  errorCode?: string | undefined,
): void {
  db.prepare(
    `UPDATE operations
        SET status = ?, current_step = 'settled', receipt_json = ?, error_code = ?, updated_at = ?
      WHERE operation_id = ?`,
  ).run(
    status,
    JSON.stringify(deepMaskGovTokens(receipt)),
    errorCode ?? null,
    new Date().toISOString(),
    operationId,
  );
}

/** 深遍历把 govt_ 明文令牌替换为占位符；结构其余部分原样保留。 */
export function deepMaskGovTokens(value: unknown): unknown {
  if (typeof value === 'string') {
    return TOKEN_PLAINTEXT_PATTERN.test(value) ? MASKED_TOKEN : value;
  }
  if (Array.isArray(value)) {
    return value.map(deepMaskGovTokens);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const masked: Record<string, unknown> = {};
    for (const key of Object.keys(source)) {
      masked[key] = deepMaskGovTokens(source[key]);
    }
    return masked;
  }
  return value;
}
