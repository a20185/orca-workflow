/**
 * T3.1 accept 单测：只有执行者 accept 后才允许开发——任务/认领迁移、令牌身份
 * 一致、setWritable 只走 accept 路径、切换失败回退并转人工（UNCERTAIN）。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import {
  createFakeHost,
  declareSampleTask,
  expectGovError,
  type FakeHost,
} from './testing.ts';

const SESSION = 'cap-exec-1';

interface Dispatched {
  readonly taskId: string;
  readonly claimId: string;
}

/** 铺一个已 DISPATCHED 的认领（declare → claim 全真服务路径）。 */
async function dispatch(h: FakeHost, service: ReturnType<typeof makeService>): Promise<Dispatched> {
  const { taskId } = await declareSampleTask(h);
  const claim = await service.claim('cap-coord-1', { taskId });
  return { taskId, claimId: claim.claimId };
}

function makeService(h: FakeHost) {
  return createClaimService({
    db: h.db,
    config: h.config,
    orca: h.orca,
    jj: h.jj,
    env: h.env,
    trustProvision: h.trust.provision,
    stepTimeoutMs: h.deps.stepTimeoutMs,
  });
}

test('accept 成功：任务与认领均 ACTIVE、setWritable 调一次、返回 ownedPaths 提示', async () => {
  const h = createFakeHost();
  try {
    const service = makeService(h);
    const { taskId, claimId } = await dispatch(h, service);
    const accepted = await service.accept({ taskId, claimId, tokenClaimId: claimId, session: SESSION });

    assert.equal(accepted.status, 'ACTIVE');
    assert.equal(accepted.taskStatus, 'ACTIVE');
    assert.deepEqual([...accepted.workspace.ownedPaths], ['src/a']);
    assert.ok(accepted.workspace.taskDirRel.length > 0);
    assert.ok(accepted.workspace.hostPath.length > 0);

    assert.equal(h.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status, 'ACTIVE');
    assert.equal(h.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status, 'ACTIVE');
    assert.deepEqual(h.env.setWritableCalls.length, 1);
    // 任务侧 accept 事件带执行者身份与认领归属。
    const event = h.db
      .prepare("SELECT actor, payload_json FROM events WHERE task_id = ? AND type = 'accept'")
      .get(taskId);
    assert.equal(event?.actor, SESSION);
    assert.equal((JSON.parse(String(event?.payload_json)) as { claimId: string }).claimId, claimId);
  } finally {
    h.dispose();
  }
});

test('accept 令牌未绑定该认领：E_CLAIM_STATE_INVALID 且 setWritable 未被调用', async () => {
  const h = createFakeHost();
  try {
    const service = makeService(h);
    const { taskId, claimId } = await dispatch(h, service);
    await expectGovError(
      service.accept({ taskId, claimId, tokenClaimId: 'gcl_someone_else', session: SESSION }),
      'E_CLAIM_STATE_INVALID',
    );
    await expectGovError(
      service.accept({ taskId, claimId, tokenClaimId: null, session: SESSION }),
      'E_CLAIM_STATE_INVALID',
    );
    assert.equal(h.env.setWritableCalls.length, 0);
    assert.equal(h.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status, 'DISPATCHED');
  } finally {
    h.dispose();
  }
});

test('accept 认领非 DISPATCHED（尚在准备中）：E_CLAIM_STATE_INVALID', async () => {
  const h = createFakeHost();
  try {
    const service = makeService(h);
    const { taskId } = await declareSampleTask(h);
    // 直接落一行 PREPARING 认领模拟准备中（不经过 claim 服务）。
    h.db
      .prepare("INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, 'PREPARING', ?, ?)")
      .run('gcl_preparing', taskId, new Date().toISOString(), new Date().toISOString());
    await expectGovError(
      service.accept({ taskId, claimId: 'gcl_preparing', tokenClaimId: 'gcl_preparing', session: SESSION }),
      'E_CLAIM_STATE_INVALID',
      'DISPATCHED',
    );
    assert.equal(h.env.setWritableCalls.length, 0);
  } finally {
    h.dispose();
  }
});

test('accept 时任务已非 DECLARED（重复 accept）：E_CLAIM_STATE_INVALID', async () => {
  const h = createFakeHost();
  try {
    const service = makeService(h);
    const { taskId, claimId } = await dispatch(h, service);
    await service.accept({ taskId, claimId, tokenClaimId: claimId, session: SESSION });
    await expectGovError(
      service.accept({ taskId, claimId, tokenClaimId: claimId, session: SESSION }),
      'E_CLAIM_STATE_INVALID',
    );
    assert.equal(h.env.setWritableCalls.length, 1, '第二次 accept 不再触外部切换');
  } finally {
    h.dispose();
  }
});

test('setWritable 失败：回退 setReadonly 被调、认领 UNCERTAIN、blockedReason=writable_switch_failed', async () => {
  const h = createFakeHost();
  try {
    const service = makeService(h);
    const { taskId, claimId } = await dispatch(h, service);
    h.env.failSetWritable = new GovError('E_ENV_SWITCH_FAILED', '容器内试写仍被拒');

    const err = await expectGovError(
      service.accept({ taskId, claimId, tokenClaimId: claimId, session: SESSION }),
      'E_ENV_SWITCH_FAILED',
    );
    assert.ok(err.message.includes('UNCERTAIN'));

    // 回退调用被断言：先切只读，再把认领置 UNCERTAIN 转人工。
    assert.deepEqual(h.env.setReadonlyCalls.length, 1);
    assert.equal(h.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status, 'UNCERTAIN');
    assert.equal(
      h.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason,
      'writable_switch_failed',
    );
    assert.equal(h.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status, 'DECLARED');
    // 转人工后：该认领阻断第二认领，直到人工经 operation resume 处置。
    await expectGovError(service.claim('cap-coord-2', { taskId }), 'E_CLAIM_EXISTS');
  } finally {
    h.dispose();
  }
});
