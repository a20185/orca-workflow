import type { DatabaseSync } from 'node:sqlite';
import { GovError } from '../domain/errors.ts';

/** 设计 §7.2 认领状态全集。 */
export const CLAIM_STATUSES = [
  'PREPARING',
  'DISPATCHED',
  'ACTIVE',
  'FENCED',
  'RELEASED',
  'UNCERTAIN',
] as const;

export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

/**
 * 合法认领迁移链（设计 §7.2）：
 * PREPARING→DISPATCHED→ACTIVE→(FENCED|RELEASED)；
 * PREPARING/DISPATCHED/ACTIVE→UNCERTAIN（外部结果不确定）；
 * UNCERTAIN→查明后 FENCED|RELEASED|ACTIVE。FENCED/RELEASED 为终态，无出边。
 * 事件→资源动作（回收工作区、作废令牌等）属上层；本层只校验并翻转 status。
 */
export const CLAIM_TRANSITIONS = {
  PREPARING: ['DISPATCHED', 'UNCERTAIN'],
  DISPATCHED: ['ACTIVE', 'UNCERTAIN'],
  ACTIVE: ['FENCED', 'RELEASED', 'UNCERTAIN'],
  FENCED: [],
  RELEASED: [],
  UNCERTAIN: ['FENCED', 'RELEASED', 'ACTIVE'],
} as const satisfies Record<ClaimStatus, readonly ClaimStatus[]>;

export interface ClaimTransitionResult {
  readonly from: ClaimStatus;
  readonly to: ClaimStatus;
}

/**
 * 校验并执行一次认领状态迁移：目标态必须是当前态的合法后继，否则抛
 * E_TRANSITION_INVALID。单条 UPDATE 自身原子，无需显式事务包裹。
 */
export function applyClaimTransition(
  db: DatabaseSync,
  claimId: string,
  next: ClaimStatus,
): ClaimTransitionResult {
  if (!(CLAIM_STATUSES as readonly string[]).includes(next)) {
    throw new GovError('E_TRANSITION_INVALID', `未知认领状态: ${next}`);
  }

  const row = db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId);
  if (row === undefined) {
    throw new GovError('E_TRANSITION_INVALID', `认领不存在: ${claimId}`);
  }
  const from = row.status as ClaimStatus;
  if (!(CLAIM_TRANSITIONS[from] as readonly ClaimStatus[]).includes(next)) {
    throw new GovError('E_TRANSITION_INVALID', `非法认领迁移: ${from} -> ${next} (认领 ${claimId})`);
  }

  db.prepare('UPDATE claims SET status = ?, updated_at = ? WHERE claim_id = ?').run(
    next,
    new Date().toISOString(),
    claimId,
  );
  return { from, to: next };
}
