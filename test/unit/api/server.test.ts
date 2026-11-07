import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { issueToken } from '../../../src/auth.ts';
import { insertClaim, insertTask } from '../state/testing.ts';
import { bootHost, call, createHostPaths, expectError, expectOk, startTestHost, type TestHost } from './testing.ts';

let shared: TestHost | undefined;
let sharedStatusToken: string | undefined;

after(async () => {
  await shared?.dispose();
});

async function host(): Promise<TestHost> {
  if (shared === undefined) {
    shared = await startTestHost();
    assert.ok(shared.operatorToken.length > 0, '首启应打印引导 operator 令牌');
  }
  return shared;
}

/** status 不在 operator 动作清单内（§9.1）；用 token-issue 走真实链路签一枚 coordinator 令牌。 */
async function statusToken(h: TestHost): Promise<string> {
  if (sharedStatusToken === undefined) {
    const result = expectOk(
      await call(h, {
        token: h.operatorToken,
        action: 'token-issue',
        payload: { role: 'coordinator' },
      }),
    );
    assert.match(String(result['token']), /^govt_/);
    sharedStatusToken = String(result['token']);
  }
  return sharedStatusToken;
}

/** 每个测试用自己的任务 id，避免测试间顺序依赖。 */
function seedTask(h: TestHost, taskId: string): void {
  insertTask(h.db, taskId, 'DECLARED');
}

test('无 Authorization / 非 Bearer 形态 → 401 E_UNAUTHENTICATED', async () => {
  const h = await host();
  expectError(await call(h, { action: 'doctor' }), 'E_UNAUTHENTICATED', 401);
  expectError(await call(h, { action: 'doctor', authorization: 'Basic zzz' }), 'E_UNAUTHENTICATED', 401);
});

test('伪造 token → 401 E_UNAUTHENTICATED', async () => {
  const h = await host();
  expectError(await call(h, { token: 'govt_forged-not-real', action: 'doctor' }), 'E_UNAUTHENTICATED', 401);
});

test('Content-Type 非 JSON → E_REQUEST_INVALID', async () => {
  const h = await host();
  expectError(
    await call(h, { token: h.operatorToken, contentType: 'text/plain', action: 'doctor' }),
    'E_REQUEST_INVALID',
    400,
  );
});

test('非法 JSON 请求体与信封字段非法 → E_REQUEST_INVALID', async () => {
  const h = await host();
  expectError(await call(h, { token: h.operatorToken, rawBody: '{ not json' }), 'E_REQUEST_INVALID', 400);
  // 未知信封字段（strict 拒）。
  expectError(
    await call(h, {
      token: h.operatorToken,
      rawBody: JSON.stringify({ requestId: 'r1', action: 'doctor', payload: {}, extra: 1 }),
    }),
    'E_REQUEST_INVALID',
    400,
  );
  // 空 requestId / 空 action / payload 非对象。
  expectError(
    await call(h, {
      token: h.operatorToken,
      rawBody: JSON.stringify({ requestId: '', action: 'doctor', payload: {} }),
    }),
    'E_REQUEST_INVALID',
    400,
  );
  expectError(
    await call(h, {
      token: h.operatorToken,
      rawBody: JSON.stringify({ requestId: 'r2', action: 'doctor', payload: 'not-object' }),
    }),
    'E_REQUEST_INVALID',
    400,
  );
});

test('非 /api/call 路由与非 POST 方法被拒', async () => {
  const h = await host();
  expectError(await call(h, { token: h.operatorToken, path: '/api/other' }), 'E_REQUEST_INVALID', 404);
  expectError(await call(h, { token: h.operatorToken, method: 'GET' }), 'E_REQUEST_INVALID', 405);
});

test('未知 action / 契约内未注册 action / 未授权 action 三类错误码可区分', async () => {
  const h = await host();
  // 完全未知名：信封层拒绝。
  expectError(await call(h, { token: h.operatorToken, action: 'frobnicate' }), 'E_REQUEST_INVALID', 400);
  // §9.1 合法名且在 operator 清单内、但 T1.3 未注册 handler。
  expectError(await call(h, { token: h.operatorToken, action: 'serve' }), 'E_ACTION_UNIMPLEMENTED', 501);
  // §9.1 合法名但不在 operator 令牌清单：鉴权层先拒。
  expectError(await call(h, { token: h.operatorToken, action: 'declare' }), 'E_FORBIDDEN_ACTION', 403);
});

test('doctor：node/config/db 三项绿', async () => {
  const h = await host();
  const result = expectOk(await call(h, { token: h.operatorToken, action: 'doctor', payload: {} }));
  const node = result['node'] as { ok: boolean; version?: string };
  const config = result['config'] as { ok: boolean; repoCount?: number };
  const db = result['db'] as { ok: boolean; migrationIds?: number[] };
  assert.equal(node.ok, true);
  assert.equal(config.ok, true);
  assert.equal(config.repoCount, 1);
  assert.equal(db.ok, true);
  assert.deepEqual(db.migrationIds, [1]);
});

test('status：不存在任务 → E_NOT_FOUND', async () => {
  const h = await host();
  expectError(
    await call(h, { token: await statusToken(h), action: 'status', payload: { taskId: 'gt-missing' } }),
    'E_NOT_FOUND',
    404,
  );
});

test('status：返回任务行、blockedReason 与当前认领摘要', async () => {
  const h = await host();
  const token = await statusToken(h);
  seedTask(h, 'gt-st-1');
  h.db.prepare('UPDATE tasks SET blocked_reason = ? WHERE task_id = ?').run('等待评审资源', 'gt-st-1');
  insertClaim(h.db, 'gc-st-1', 'gt-st-1', 'ACTIVE');
  h.db.prepare('UPDATE claims SET dispatch_id = ? WHERE claim_id = ?').run('dispatch-9', 'gc-st-1');
  h.db.prepare('UPDATE tasks SET current_claim_id = ? WHERE task_id = ?').run('gc-st-1', 'gt-st-1');

  const result = expectOk(await call(h, { token, action: 'status', payload: { taskId: 'gt-st-1' } }));
  const task = result['task'] as Record<string, unknown>;
  assert.equal(task['taskId'], 'gt-st-1');
  assert.equal(task['status'], 'DECLARED');
  assert.equal(task['blockedReason'], '等待评审资源');
  assert.deepEqual(task['target'], { kind: 'top-level', bookmark: 'main' });
  const claim = result['currentClaim'] as Record<string, unknown>;
  assert.equal(claim['claimId'], 'gc-st-1');
  assert.equal(claim['status'], 'ACTIVE');
  assert.equal(claim['dispatchId'], 'dispatch-9');

  // 无认领的任务 currentClaim 为 null、blockedReason 为 null。
  seedTask(h, 'gt-st-2');
  const bare = expectOk(await call(h, { token, action: 'status', payload: { taskId: 'gt-st-2' } }));
  assert.equal(bare['currentClaim'], null);
  assert.equal((bare['task'] as Record<string, unknown>)['blockedReason'], null);
});

test('跨任务令牌：executor 绑 gt-xa 查 gt-xb → E_FORBIDDEN_ACTION', async () => {
  const h = await host();
  seedTask(h, 'gt-xa');
  seedTask(h, 'gt-xb');
  const issued = issueToken(h.db, { role: 'executor', taskId: 'gt-xa' });
  expectError(
    await call(h, { token: issued.token, action: 'status', payload: { taskId: 'gt-xb' } }),
    'E_FORBIDDEN_ACTION',
    403,
  );
  // 同任务正常。
  expectOk(await call(h, { token: issued.token, action: 'status', payload: { taskId: 'gt-xa' } }));
});

test('过期令牌 → E_TOKEN_EXPIRED', async () => {
  const h = await host();
  seedTask(h, 'gt-exp');
  const issued = issueToken(h.db, { role: 'executor', taskId: 'gt-exp', ttlSeconds: 3600 });
  h.db.prepare('UPDATE capabilities SET expires_at = ? WHERE capability_id = ?').run(
    '2020-01-01T00:00:00.000Z',
    issued.capabilityId,
  );
  expectError(
    await call(h, { token: issued.token, action: 'status', payload: { taskId: 'gt-exp' } }),
    'E_TOKEN_EXPIRED',
    403,
  );
});

test('payload 带 session_id 不改变身份判定（身份只来自令牌）', async () => {
  const h = await host();
  seedTask(h, 'gt-sess');
  const executor = issueToken(h.db, { role: 'executor', taskId: 'gt-sess' });

  // 自报 coordinator 身份：仍以 executor 令牌身份成功查自己绑定的任务。
  const result = expectOk(
    await call(h, {
      token: executor.token,
      action: 'status',
      payload: { taskId: 'gt-sess', session_id: 'coordinator-session-1' },
    }),
  );
  assert.equal((result['task'] as Record<string, unknown>)['taskId'], 'gt-sess');

  // 反向：dev 令牌（零动作）自报 operator 身份也拿不到任何动作（鉴权先于 payload 校验）。
  const dev = issueToken(h.db, { role: 'dev' });
  expectError(
    await call(h, {
      token: dev.token,
      action: 'doctor',
      payload: { session_id: 'operator-session-1' },
    }),
    'E_FORBIDDEN_ACTION',
    403,
  );
});

test('重复 requestId 同哈希：重放同响应且 operations 只有一行（含 FAILED 重放）', async () => {
  const h = await host();
  const token = await statusToken(h);
  seedTask(h, 'gt-idem');
  const requestId = `req-idem-${randomUUID()}`;

  const first = await call(h, {
    token,
    requestId,
    action: 'status',
    payload: { taskId: 'gt-idem' },
  });
  const second = await call(h, {
    token,
    requestId,
    action: 'status',
    payload: { taskId: 'gt-idem' },
  });
  assert.equal(second.status, first.status);
  assert.deepEqual(second.body, first.body, '同哈希重放必须返回同一响应');
  assert.equal(
    h.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE request_id = ?').get(requestId)?.c,
    1,
    '重放不得新增 operations 行',
  );

  // FAILED 调用同样冻结：重复请求返回同一错误回执。
  const failId = `req-fail-${randomUUID()}`;
  const failedOnce = await call(h, {
    token,
    requestId: failId,
    action: 'status',
    payload: { taskId: 'gt-not-exist' },
  });
  const failedTwice = await call(h, {
    token,
    requestId: failId,
    action: 'status',
    payload: { taskId: 'gt-not-exist' },
  });
  assert.deepEqual(failedTwice.body, failedOnce.body);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE request_id = ?').get(failId)?.c, 1);
});

test('同 requestId 异哈希 → E_REQUEST_HASH_MISMATCH 且不覆盖原行', async () => {
  const h = await host();
  const token = await statusToken(h);
  seedTask(h, 'gt-hash-a');
  seedTask(h, 'gt-hash-b');
  const requestId = `req-hash-${randomUUID()}`;
  const first = await call(h, {
    token,
    requestId,
    action: 'status',
    payload: { taskId: 'gt-hash-a' },
  });
  expectOk(first);
  expectError(
    await call(h, {
      token,
      requestId,
      action: 'status',
      payload: { taskId: 'gt-hash-b' },
    }),
    'E_REQUEST_HASH_MISMATCH',
    400,
  );
  // 原响应仍可重放，行数仍为 1。
  const replay = await call(h, {
    token,
    requestId,
    action: 'status',
    payload: { taskId: 'gt-hash-a' },
  });
  assert.deepEqual(replay.body, first.body);
  assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE request_id = ?').get(requestId)?.c, 1);
});

test('请求体超过 1 MiB → E_PAYLOAD_TOO_LARGE', async () => {
  const h = await host();
  const bigPayload = { taskId: 'gt-hash-a', pad: 'x'.repeat(1100 * 1024) };
  expectError(
    await call(h, {
      token: h.operatorToken,
      rawBody: JSON.stringify({ requestId: `req-big-${randomUUID()}`, action: 'status', payload: bigPayload }),
    }),
    'E_PAYLOAD_TOO_LARGE',
    413,
  );
});

test('token-issue：operator 签发 executor 令牌并立即可用', async () => {
  const h = await host();
  seedTask(h, 'gt-issue');
  const result = expectOk(
    await call(h, {
      token: h.operatorToken,
      action: 'token-issue',
      payload: { role: 'executor', taskId: 'gt-issue', ttlSeconds: 1800 },
    }),
  );
  const token = result['token'];
  assert.match(String(token), /^govt_[A-Za-z0-9_-]+$/);
  assert.equal(result['role'], 'executor');
  assert.ok(result['expiresAt']);
  const row = h.db
    .prepare('SELECT role, task_id FROM capabilities WHERE capability_id = ?')
    .get(String(result['capabilityId']));
  assert.equal(String(row?.role), 'executor');
  assert.equal(String(row?.task_id), 'gt-issue');

  // 新令牌立即按其角色与任务绑定工作。
  expectOk(await call(h, { token: String(token), action: 'status', payload: { taskId: 'gt-issue' } }));
  expectError(await call(h, { token: String(token), action: 'doctor' }), 'E_FORBIDDEN_ACTION', 403);
});

test('token-issue：非 operator 令牌 → E_FORBIDDEN_ACTION', async () => {
  const h = await host();
  const coordinator = issueToken(h.db, { role: 'coordinator' });
  expectError(
    await call(h, { token: coordinator.token, action: 'token-issue', payload: { role: 'coordinator' } }),
    'E_FORBIDDEN_ACTION',
    403,
  );
});

test('token-issue 重放：回执遮蔽明文且不重复签发', async () => {
  const h = await host();
  const requestId = `req-issue-${randomUUID()}`;
  const before = Number(
    h.db.prepare("SELECT COUNT(*) AS c FROM capabilities WHERE role = 'coordinator'").get()?.c ?? 0,
  );

  const first = expectOk(
    await call(h, {
      token: h.operatorToken,
      requestId,
      action: 'token-issue',
      payload: { role: 'coordinator' },
    }),
  );
  assert.match(String(first['token']), /^govt_/);

  const replay = expectOk(
    await call(h, {
      token: h.operatorToken,
      requestId,
      action: 'token-issue',
      payload: { role: 'coordinator' },
    }),
  );
  assert.equal(replay['token'], '<token-masked>', '重放回执不得回放明文令牌');
  const after = Number(
    h.db.prepare("SELECT COUNT(*) AS c FROM capabilities WHERE role = 'coordinator'").get()?.c ?? 0,
  );
  assert.equal(after, before + 1, '重放不得重复签发');
});

test('服务 close 后重启：不重复打印引导令牌，令牌与幂等账本延续', async () => {
  const paths = createHostPaths();
  const first = await bootHost(paths);
  let second: TestHost | undefined;
  try {
    assert.ok(first.operatorToken.length > 0);
    // status 属 coordinator 动作，经 token-issue 真实链路签一枚。
    const coordinator = expectOk(
      await call(first, {
        token: first.operatorToken,
        action: 'token-issue',
        payload: { role: 'coordinator' },
      }),
    );
    const statusTokenValue = String(coordinator['token']);

    insertTask(first.db, 'gt-restart', 'DECLARED');
    const requestId = `req-restart-${randomUUID()}`;
    const original = expectOk(
      await call(first, {
        token: statusTokenValue,
        requestId,
        action: 'status',
        payload: { taskId: 'gt-restart' },
      }),
    );
    await first.close();

    second = await bootHost(paths);
    assert.equal(second.operatorToken, '', '已有可用 operator 令牌时不得再次打印');
    // 原令牌在重启后仍有效。
    const doctor = expectOk(await call(second, { token: first.operatorToken, action: 'doctor' }));
    assert.equal((doctor['db'] as { ok: boolean }).ok, true);
    // 幂等账本跨重启延续：同 requestId 同哈希重放原响应。
    const replay = expectOk(
      await call(second, {
        token: statusTokenValue,
        requestId,
        action: 'status',
        payload: { taskId: 'gt-restart' },
      }),
    );
    assert.deepEqual(replay, original);
  } finally {
    // 无论断言成败都必须关掉服务，否则监听句柄会让测试进程挂住。
    await first.close();
    await second?.dispose();
  }
});
