import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { authenticate, issueToken, revokeToken } from '../../../src/auth.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { openMigratedMemoryDb, insertTask } from '../state/testing.ts';

function expectGovError(fn: () => unknown, code: string, messagePart?: string): GovError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GovError, `应抛 GovError，实际: ${String(err)}`);
    assert.equal(err.code, code);
    if (messagePart !== undefined) {
      assert.ok(err.message.includes(messagePart), `message 应含「${messagePart}」: ${err.message}`);
    }
    return err;
  }
  assert.fail(`应抛 GovError(${code})，但调用成功`);
}

test('issueToken：明文仅返回一次，库中只存 sha256', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');
  const issued = issueToken(db, { role: 'executor', taskId: 'gt-a' });
  assert.match(issued.token, /^govt_[A-Za-z0-9_-]{43}$/);

  const expectedHash = createHash('sha256').update(issued.token, 'utf8').digest('hex');
  const row = db
    .prepare('SELECT token_hash, task_id, expires_at FROM capabilities WHERE capability_id = ?')
    .get(issued.capabilityId);
  assert.equal(String(row?.token_hash), expectedHash);
  assert.equal(String(row?.task_id), 'gt-a');
  assert.equal(row?.expires_at, null);

  const wholeTable = JSON.stringify(db.prepare('SELECT * FROM capabilities').all());
  assert.ok(!wholeTable.includes(issued.token), '明文令牌不得出现在库中任何位置');
});

test('issueToken：actions 缺省取角色映射，显式 actions 覆盖缺省', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');

  const coordinator = issueToken(db, { role: 'coordinator' });
  assert.deepEqual(coordinator.actions, ['declare', 'claim', 'status']);
  assert.ok(authenticate(db, coordinator.token, { action: 'status' }).role === 'coordinator');
  expectGovError(
    () => authenticate(db, coordinator.token, { action: 'doctor' }),
    'E_FORBIDDEN_ACTION',
  );

  const scoped = issueToken(db, { role: 'coordinator', actions: ['status'] });
  assert.deepEqual(scoped.actions, ['status']);
  assert.ok(authenticate(db, scoped.token, { action: 'status' }));
  expectGovError(() => authenticate(db, scoped.token, { action: 'claim' }), 'E_FORBIDDEN_ACTION');
});

test('issueToken：executor/reviewer 必须绑定 taskId；coordinator/operator 可不绑', () => {
  const db = openMigratedMemoryDb();
  expectGovError(() => issueToken(db, { role: 'executor' }), 'E_REQUEST_INVALID', '必须绑定 taskId');
  expectGovError(() => issueToken(db, { role: 'reviewer' }), 'E_REQUEST_INVALID', '必须绑定 taskId');
  issueToken(db, { role: 'coordinator' });
  issueToken(db, { role: 'operator' });
});

test('issueToken：ttlSeconds 落 expires_at；缺省永不过期', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');
  const before = Date.now();
  const issued = issueToken(db, { role: 'executor', taskId: 'gt-a', ttlSeconds: 3600 });
  const after = Date.now();
  assert.ok(issued.expiresAt !== null);
  const expiresAt = Date.parse(issued.expiresAt);
  assert.ok(expiresAt >= before + 3599_000 && expiresAt <= after + 3601_000);
  assert.ok(authenticate(db, issued.token, { action: 'status', taskId: 'gt-a' }));

  const forever = issueToken(db, { role: 'operator' });
  assert.equal(forever.expiresAt, null);
});

test('authenticate：伪造/未知令牌 → E_UNAUTHENTICATED', () => {
  const db = openMigratedMemoryDb();
  issueToken(db, { role: 'operator' });
  expectGovError(() => authenticate(db, 'govt_forged', { action: 'doctor' }), 'E_UNAUTHENTICATED');
});

test('authenticate：吊销 → E_UNAUTHENTICATED；revokeToken 幂等', () => {
  const db = openMigratedMemoryDb();
  const issued = issueToken(db, { role: 'operator' });
  assert.ok(authenticate(db, issued.token, { action: 'doctor' }));
  assert.equal(revokeToken(db, issued.token), true);
  expectGovError(() => authenticate(db, issued.token, { action: 'doctor' }), 'E_UNAUTHENTICATED', '已吊销');
  assert.equal(revokeToken(db, issued.token), false, '重复吊销应返回 false');
  assert.equal(revokeToken(db, 'govt_unknown'), false);
});

test('authenticate：过期 → E_TOKEN_EXPIRED', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');
  const issued = issueToken(db, { role: 'executor', taskId: 'gt-a', ttlSeconds: 3600 });
  db.prepare('UPDATE capabilities SET expires_at = ? WHERE capability_id = ?').run(
    '2020-01-01T00:00:00.000Z',
    issued.capabilityId,
  );
  expectGovError(
    () => authenticate(db, issued.token, { action: 'status', taskId: 'gt-a' }),
    'E_TOKEN_EXPIRED',
  );
});

test('authenticate：令牌绑定任务与请求任务的四种组合', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');
  insertTask(db, 'gt-b');

  const executor = issueToken(db, { role: 'executor', taskId: 'gt-a' });
  // 同任务通过；请求未声明任务、异任务均拒。
  assert.equal(authenticate(db, executor.token, { action: 'status', taskId: 'gt-a' }).taskId, 'gt-a');
  expectGovError(
    () => authenticate(db, executor.token, { action: 'status' }),
    'E_FORBIDDEN_ACTION',
    '与请求任务不符',
  );
  expectGovError(
    () => authenticate(db, executor.token, { action: 'status', taskId: 'gt-b' }),
    'E_FORBIDDEN_ACTION',
  );

  // 未绑任务的 coordinator 令牌不受请求任务字段影响。
  const coordinator = issueToken(db, { role: 'coordinator' });
  assert.ok(authenticate(db, coordinator.token, { action: 'status', taskId: 'gt-b' }));
  assert.ok(authenticate(db, coordinator.token, { action: 'status' }));
});

test('authenticate：返回的 TokenInfo 不含哈希或明文', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-a');
  const issued = issueToken(db, { role: 'executor', taskId: 'gt-a' });
  const info = authenticate(db, issued.token, { action: 'status', taskId: 'gt-a' });
  const serialized = JSON.stringify(info);
  assert.ok(!serialized.includes(issued.token));
  assert.ok(!serialized.includes(createHash('sha256').update(issued.token).digest('hex')));
  assert.equal(info.role, 'executor');
  assert.deepEqual(info.actions, ['accept', 'submit', 'fail', 'split', 'rebase', 'review-request', 'status']);
});

test('operator 引导型令牌（显式含 token-issue）可调用 token-issue', () => {
  const db: DatabaseSync = openMigratedMemoryDb();
  const bootstrapped = issueToken(db, {
    role: 'operator',
    actions: ['token-issue', 'cancel', 'manual-approve', 'operation-show', 'operation-resume', 'serve', 'doctor', 'status'],
  });
  assert.ok(authenticate(db, bootstrapped.token, { action: 'token-issue' }));
  // 缺省 operator 令牌不含 token-issue。
  const plain = issueToken(db, { role: 'operator' });
  expectGovError(() => authenticate(db, plain.token, { action: 'token-issue' }), 'E_FORBIDDEN_ACTION');
});
