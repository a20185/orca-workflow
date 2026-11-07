import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  beginOperation,
  canonicalRequestHash,
  deepMaskGovTokens,
  finalizeOperation,
  type BeginOperationResult,
} from '../../../src/operations.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { openMigratedMemoryDb } from '../state/testing.ts';

/** assert.equal 不收窄联合类型，用显式分支收窄到 start 变体。 */
function expectStart(result: BeginOperationResult): { operationId: string } {
  if (result.type !== 'start') {
    assert.fail(`预期 start 变体，实际 ${result.type}`);
  }
  return result;
}

test('canonicalRequestHash：payload 键序无关，内容与 requestId/action 参与', () => {
  const a = canonicalRequestHash('req-1', 'status', { taskId: 'gt-a', extra: { b: 1, a: 2 } });
  const b = canonicalRequestHash('req-1', 'status', { extra: { a: 2, b: 1 }, taskId: 'gt-a' });
  assert.equal(a, b);

  assert.notEqual(a, canonicalRequestHash('req-2', 'status', { taskId: 'gt-a', extra: { b: 1, a: 2 } }));
  assert.notEqual(a, canonicalRequestHash('req-1', 'token-issue', { taskId: 'gt-a', extra: { b: 1, a: 2 } }));
  assert.notEqual(a, canonicalRequestHash('req-1', 'status', { taskId: 'gt-b', extra: { b: 1, a: 2 } }));
});

test('beginOperation：首次 start → finalize CONFIRMED → 同哈希重放回执', () => {
  const db = openMigratedMemoryDb();
  const hash = canonicalRequestHash('req-ok', 'status', { taskId: 'gt-a' });

  const begin = expectStart(beginOperation(db, { requestId: 'req-ok', requestHash: hash, kind: 'status' }));

  finalizeOperation(db, begin.operationId, 'CONFIRMED', {
    httpStatus: 200,
    body: { ok: true, result: { task: { taskId: 'gt-a' } } },
  });

  const replay = beginOperation(db, { requestId: 'req-ok', requestHash: hash, kind: 'status' });
  assert.equal(replay.type, 'replay');
  assert.equal(replay.status, 'CONFIRMED');
  assert.deepEqual(replay.receipt, {
    httpStatus: 200,
    body: { ok: true, result: { task: { taskId: 'gt-a' } } },
  });

  // 全程只有一行。
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM operations WHERE request_id = 'req-ok'").get()?.c, 1);
});

test('beginOperation：同 requestId 异哈希 → E_REQUEST_HASH_MISMATCH（先查后插）', () => {
  const db = openMigratedMemoryDb();
  const first = expectStart(
    beginOperation(db, {
      requestId: 'req-mismatch',
      requestHash: canonicalRequestHash('req-mismatch', 'status', { taskId: 'gt-a' }),
      kind: 'status',
    }),
  );
  finalizeOperation(db, first.operationId, 'CONFIRMED', { httpStatus: 200, body: { ok: true, result: 1 } });

  try {
    beginOperation(db, {
      requestId: 'req-mismatch',
      requestHash: canonicalRequestHash('req-mismatch', 'status', { taskId: 'gt-b' }),
      kind: 'status',
    });
    assert.fail('应抛 E_REQUEST_HASH_MISMATCH');
  } catch (err) {
    assert.ok(err instanceof GovError);
    assert.equal(err.code, 'E_REQUEST_HASH_MISMATCH');
  }
});

test('beginOperation：IN_FLIGHT 未结算 → in_flight；FAILED 回执可重放', () => {
  const db = openMigratedMemoryDb();
  const inFlightHash = canonicalRequestHash('req-flight', 'status', { taskId: 'gt-a' });
  const begin = expectStart(
    beginOperation(db, { requestId: 'req-flight', requestHash: inFlightHash, kind: 'status' }),
  );
  assert.equal(
    beginOperation(db, { requestId: 'req-flight', requestHash: inFlightHash, kind: 'status' }).type,
    'in_flight',
  );

  const failedHash = canonicalRequestHash('req-failed', 'status', { taskId: 'gt-missing' });
  const failed = expectStart(
    beginOperation(db, { requestId: 'req-failed', requestHash: failedHash, kind: 'status' }),
  );
  finalizeOperation(
    db,
    failed.operationId,
    'FAILED',
    { httpStatus: 404, body: { ok: false, error: { code: 'E_NOT_FOUND', message: '任务不存在' } } },
    'E_NOT_FOUND',
  );
  const replayed = beginOperation(db, { requestId: 'req-failed', requestHash: failedHash, kind: 'status' });
  assert.equal(replayed.type, 'replay');
  assert.equal(replayed.status, 'FAILED');
  assert.equal((replayed.receipt as { httpStatus: number }).httpStatus, 404);
});

test('finalizeOperation：kind 与 error_code 落库，回执自动遮蔽 govt_ 明文', () => {
  const db = openMigratedMemoryDb();
  const hash = canonicalRequestHash('req-mask', 'token-issue', { role: 'executor' });
  const begin = expectStart(beginOperation(db, { requestId: 'req-mask', requestHash: hash, kind: 'token-issue' }));
  finalizeOperation(db, begin.operationId, 'CONFIRMED', {
    httpStatus: 200,
    body: { ok: true, result: { token: 'govt_plainsecret123', role: 'executor', nested: ['govt_another1'] } },
  });

  const row = db
    .prepare('SELECT kind, status, error_code, receipt_json FROM operations WHERE operation_id = ?')
    .get(begin.operationId);
  assert.equal(String(row?.kind), 'token-issue');
  assert.equal(String(row?.status), 'CONFIRMED');
  assert.equal(row?.error_code, null);
  const receipt = String(row?.receipt_json);
  assert.ok(!receipt.includes('govt_plainsecret123'), '回执不得含明文令牌');
  assert.ok(!receipt.includes('govt_another1'));
  assert.ok(receipt.includes('<token-masked>'));
});

test('deepMaskGovTokens：非令牌字符串与结构原样保留', () => {
  assert.deepEqual(deepMaskGovTokens({ a: 'gt-a', b: 'govt_x', c: [{ d: 'govt_y' }, 1, null] }), {
    a: 'gt-a',
    b: '<token-masked>',
    c: [{ d: '<token-masked>' }, 1, null],
  });
  assert.equal(deepMaskGovTokens('govt_'), 'govt_');
  assert.equal(deepMaskGovTokens(42), 42);
});

test('operations 行为不依赖外部进程：request_hash/request_id 终态不可变（触发器）', () => {
  const db = openMigratedMemoryDb();
  const hash = canonicalRequestHash('req-imm', 'status', { taskId: 'gt-a' });
  const begin = expectStart(beginOperation(db, { requestId: 'req-imm', requestHash: hash, kind: 'status' }));
  assert.throws(() =>
    db.prepare('UPDATE operations SET request_hash = ? WHERE operation_id = ?').run('deadbeef', begin.operationId),
  );
});
