import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { GovError } from '../../../src/domain/errors.ts';
import {
  CLAIM_STATUSES,
  CLAIM_TRANSITIONS,
  applyClaimTransition,
  type ClaimStatus,
} from '../../../src/state/claim-machine.ts';
import { insertClaim, insertTask, openMigratedMemoryDb, T0 } from './testing.ts';

/** 设计 §7.2 合法认领迁移链的展平全集。 */
const EXPECTED_EDGES: ReadonlyArray<{ from: ClaimStatus; to: ClaimStatus }> = [
  { from: 'PREPARING', to: 'DISPATCHED' },
  { from: 'PREPARING', to: 'UNCERTAIN' },
  { from: 'DISPATCHED', to: 'ACTIVE' },
  { from: 'DISPATCHED', to: 'UNCERTAIN' },
  { from: 'ACTIVE', to: 'FENCED' },
  { from: 'ACTIVE', to: 'RELEASED' },
  { from: 'ACTIVE', to: 'UNCERTAIN' },
  { from: 'UNCERTAIN', to: 'FENCED' },
  { from: 'UNCERTAIN', to: 'RELEASED' },
  { from: 'UNCERTAIN', to: 'ACTIVE' },
];

function derivedEdges(): Array<{ from: ClaimStatus; to: ClaimStatus }> {
  return Object.entries(CLAIM_TRANSITIONS).flatMap(([from, targets]) =>
    (targets as readonly ClaimStatus[]).map((to) => ({ from: from as ClaimStatus, to })),
  );
}

function seedClaimAt(db: DatabaseSync, claimId: string, status: ClaimStatus): string {
  insertTask(db, `gt-${claimId}`);
  insertClaim(db, claimId, `gt-${claimId}`, status);
  return claimId;
}

function expectClaimInvalid(db: DatabaseSync, claimId: string, next: ClaimStatus): void {
  assert.throws(
    () => applyClaimTransition(db, claimId, next),
    (err: unknown) => {
      assert.ok(err instanceof GovError, `应抛 GovError，实际: ${String(err)}`);
      assert.equal(err.code, 'E_TRANSITION_INVALID');
      return true;
    },
    `预期认领 ${claimId}: → ${next} 被拒`,
  );
}

test('合法链展平恰为设计 §7.2 的 10 条边', () => {
  assert.deepEqual(derivedEdges(), EXPECTED_EDGES);
  assert.equal(CLAIM_STATUSES.length, 6);
});

test('全部合法边可走且 status 落库', () => {
  const db = openMigratedMemoryDb();
  let i = 0;
  for (const edge of EXPECTED_EDGES) {
    const claimId = `cl-walk-${i++}`;
    seedClaimAt(db, claimId, edge.from);
    const result = applyClaimTransition(db, claimId, edge.to);
    assert.deepEqual(result, { from: edge.from, to: edge.to });
    assert.equal(
      db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status,
      edge.to,
    );
  }
});

test('主链 PREPARING→DISPATCHED→ACTIVE→FENCED 全程可走', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-chain');
  insertClaim(db, 'cl-chain', 'gt-chain', 'PREPARING');
  assert.deepEqual(applyClaimTransition(db, 'cl-chain', 'DISPATCHED'), {
    from: 'PREPARING',
    to: 'DISPATCHED',
  });
  assert.deepEqual(applyClaimTransition(db, 'cl-chain', 'ACTIVE'), {
    from: 'DISPATCHED',
    to: 'ACTIVE',
  });
  assert.deepEqual(applyClaimTransition(db, 'cl-chain', 'FENCED'), {
    from: 'ACTIVE',
    to: 'FENCED',
  });
  // FENCED 是终态：任何后继都被拒。
  for (const next of CLAIM_STATUSES) {
    expectClaimInvalid(db, 'cl-chain', next);
  }
});

test('UNCERTAIN 往返：ACTIVE→UNCERTAIN→ACTIVE / →RELEASED / →FENCED', () => {
  const db = openMigratedMemoryDb();
  seedClaimAt(db, 'cl-unc-back', 'ACTIVE');
  applyClaimTransition(db, 'cl-unc-back', 'UNCERTAIN');
  applyClaimTransition(db, 'cl-unc-back', 'ACTIVE');

  seedClaimAt(db, 'cl-unc-rel', 'ACTIVE');
  applyClaimTransition(db, 'cl-unc-rel', 'UNCERTAIN');
  applyClaimTransition(db, 'cl-unc-rel', 'RELEASED');

  seedClaimAt(db, 'cl-unc-fen', 'DISPATCHED');
  applyClaimTransition(db, 'cl-unc-fen', 'UNCERTAIN');
  applyClaimTransition(db, 'cl-unc-fen', 'FENCED');
});

test('RELEASED 终态无出边；非法跳变抽样均抛 E_TRANSITION_INVALID', () => {
  const db = openMigratedMemoryDb();
  seedClaimAt(db, 'cl-released', 'RELEASED');
  for (const next of CLAIM_STATUSES) {
    expectClaimInvalid(db, 'cl-released', next);
  }

  const samples: ReadonlyArray<[ClaimStatus, ClaimStatus]> = [
    ['PREPARING', 'ACTIVE'],
    ['PREPARING', 'RELEASED'],
    ['PREPARING', 'FENCED'],
    ['DISPATCHED', 'FENCED'],
    ['DISPATCHED', 'RELEASED'],
    ['ACTIVE', 'DISPATCHED'],
    ['ACTIVE', 'PREPARING'],
    ['UNCERTAIN', 'PREPARING'],
    ['UNCERTAIN', 'DISPATCHED'],
    ['UNCERTAIN', 'UNCERTAIN'],
  ];
  let i = 0;
  for (const [from, to] of samples) {
    const claimId = `cl-illegal-${i++}`;
    seedClaimAt(db, claimId, from);
    expectClaimInvalid(db, claimId, to);
    // 非法迁移不落任何写入。
    assert.equal(
      db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status,
      from,
    );
  }
});

test('未知状态与不存在的认领抛 E_TRANSITION_INVALID', () => {
  const db = openMigratedMemoryDb();
  seedClaimAt(db, 'cl-exist', 'PREPARING');
  expectClaimInvalid(db, 'cl-exist', 'ZOMBIE' as ClaimStatus);
  expectClaimInvalid(db, 'cl-missing', 'ACTIVE');
});

test('认领释放后同任务可再次活跃（与部分唯一索引联动）', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-recycle');
  insertClaim(db, 'cl-first', 'gt-recycle', 'ACTIVE');
  applyClaimTransition(db, 'cl-first', 'RELEASED');
  // 旧认领终态后，新认领可以占据活跃位。
  insertClaim(db, 'cl-second', 'gt-recycle', 'ACTIVE');
  // 但两者不能同时活跃：把旧的翻回活跃态会撞部分唯一索引。
  assert.throws(
    () => db.prepare(`UPDATE claims SET status = 'ACTIVE', updated_at = ? WHERE claim_id = ?`).run(T0, 'cl-first'),
    (err: unknown) => err instanceof Error && err.message.includes('UNIQUE constraint failed: claims.task_id'),
  );
  // 机器走 UNCERTAIN 亦占活跃位：同任务第二个 UNCERTAIN 仍被拒。
  assert.throws(
    () =>
      db.prepare(`UPDATE claims SET status = 'UNCERTAIN', updated_at = ? WHERE claim_id = ?`).run(
        T0,
        'cl-first',
      ),
    (err: unknown) => err instanceof Error && err.message.includes('UNIQUE constraint failed: claims.task_id'),
  );
});
