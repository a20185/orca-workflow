/**
 * T3.1 claim 单测：并发唯一、各准备阶段中断的干净回滚、外部结果不确定阻断、
 * 信任门首死与重试上限、全链 DISPATCHED 与 executor 令牌。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { createClaimService, CLAIM_EVENT_TYPES } from '../../../src/services/claims.ts';
import { GOV_ACTIONS_BY_ROLE } from '../../../src/domain/roles.ts';
import {
  createFakeHost,
  declareSampleTask,
  expectGovError,
  sampleSpec,
  type FakeHost,
} from './testing.ts';

const SESSION = 'cap-coord-1';

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

test('claim 成功全链：DISPATCHED、current_claim_id、workspaces 行、executor 令牌、四步回执', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    const claim = await makeService(h).claim(SESSION, { taskId });

    assert.equal(claim.status, 'DISPATCHED');
    assert.equal(claim.taskId, taskId);
    assert.ok(claim.dispatchId.length > 0);
    assert.ok(claim.terminalHandle !== null);

    const claimRow = h.db.prepare('SELECT * FROM claims WHERE claim_id = ?').get(claim.claimId);
    assert.equal(claimRow?.status, 'DISPATCHED');
    assert.equal(claimRow?.dispatch_id, claim.dispatchId);
    assert.equal(claimRow?.claimer_session, SESSION);
    assert.ok(String(claimRow?.token_hash ?? '').match(/^[0-9a-f]{64}$/));

    const task = h.db.prepare('SELECT current_claim_id, status FROM tasks WHERE task_id = ?').get(taskId);
    assert.equal(task?.current_claim_id, claim.claimId);
    assert.equal(task?.status, 'DECLARED');

    const ws = h.db.prepare('SELECT * FROM workspaces WHERE workspace_id = ?').get(claim.workspace.workspaceId);
    assert.equal(ws?.env_status, 'running');
    assert.ok(String(ws?.env_instance_id ?? '').startsWith('env-'));
    assert.equal(String(ws?.host_path), claim.workspace.hostPath);

    // executor 令牌：动作集、taskId+claimId 绑定、ttl 来自任务书预算。
    const cap = h.db.prepare('SELECT * FROM capabilities WHERE capability_id = ?').get(claim.executorCapabilityId);
    assert.equal(cap?.role, 'executor');
    assert.equal(cap?.task_id, taskId);
    assert.equal(cap?.claim_id, claim.claimId);
    assert.deepEqual(JSON.parse(String(cap?.actions_json)), [...GOV_ACTIONS_BY_ROLE.executor]);
    assert.ok(claim.executorTokenExpiresAt !== null);
    const expectedExpiry = Date.now() + 3_600_000;
    assert.ok(
      Math.abs(Date.parse(claim.executorTokenExpiresAt) - expectedExpiry) < 5_000,
      '令牌到期时间应约等于 now + maxWallSeconds',
    );

    // 每步 operations 回执（确定性幂等键）全部 CONFIRMED。
    const steps = h.db
      .prepare("SELECT request_id, status, current_step FROM operations WHERE kind = 'claim' ORDER BY request_id")
      .all();
    const stepIds = steps.map((s) => String(s.request_id));
    for (const stage of ['workspace', 'env', 'trust', 'worker-start']) {
      assert.ok(stepIds.includes(`claim:${claim.claimId}:${stage}`), `缺 ${stage} 步回执: ${stepIds.join(',')}`);
    }
    assert.ok(steps.every((s) => s.status === 'CONFIRMED'));

    // workerStart 入参：task=orcaTaskId、worktree=path:<realpath>、agent=任务书 executor。
    const started = h.orca.workerStartCalls[0];
    assert.equal(started?.task, 'ot-1');
    assert.equal(started?.worktree, `path:${claim.workspace.hostPath}`);
    assert.equal(started?.agent, 'opencode');
    assert.equal(started?.retryOf, undefined);
    // 信任预置发生在 worker 启动前（严格顺序）。
    assert.deepEqual(h.trust.provisionCalls, [claim.workspace.hostPath]);
  } finally {
    h.dispose();
  }
});

test('并发第二认领：A 停在 workspace 步时 B 被唯一约束拒绝，全链只产生一个执行环境', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.jj.firstAddGate = { promise: gate, release };

    const service = makeService(h);
    const pending = service.claim(SESSION, { taskId });
    // 等到 A 真正进入 workspace 步（挂起在假 jj 上）。
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.jj.workspaceAddCalls.length, 1, '认领 A 应已进入 workspace 步');

    await expectGovError(service.claim('cap-coord-2', { taskId }), 'E_CLAIM_EXISTS');

    release!();
    const claimA = await pending;
    assert.equal(claimA.status, 'DISPATCHED');
    // 只有一个有效执行环境：env 只建了一次，库里只有一行认领。
    assert.equal(h.env.createCalls.length, 1);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM claims').get()?.c, 1);
  } finally {
    h.dispose();
  }
});

test('workspace 步确定失败：E_CLAIM_PREP_FAILED(workspace)、认领行删除、可立即重认领', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.jj.failNextAdd = new GovError('E_JJ_CALL_FAILED', 'workspace add 失败');
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', 'workspace');

    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM claims').get()?.c, 0);
    assert.equal(h.env.createCalls.length, 0);
    assert.equal(h.trust.provisionCalls.length, 0);
    assert.equal(h.orca.workerStartCalls.length, 0);
    const failedStep = h.db
      .prepare("SELECT status, current_step FROM operations WHERE request_id LIKE 'claim:%:workspace'")
      .get();
    assert.equal(failedStep?.status, 'FAILED');

    // 无残留写入者：第二认领从头干净走通。
    const second = await service.claim(SESSION, { taskId });
    assert.equal(second.status, 'DISPATCHED');
  } finally {
    h.dispose();
  }
});

test('env 步确定失败：回滚 workspace（forget 被调）、认领删除、E_CLAIM_PREP_FAILED(env)', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.env.failNextCreate = new GovError('E_ENV_CREATE_FAILED', '容器起不来');
    await expectGovError(makeService(h).claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', 'env');

    assert.equal(h.jj.workspaceForgetCalls.length, 1, 'workspace 应被 forget 回滚');
    assert.equal(h.trust.provisionCalls.length, 0, 'trust 不应发生');
    assert.equal(h.orca.workerStartCalls.length, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM claims').get()?.c, 0);
    // workspace 行保留为 rolled_back 审计痕迹。
    const ws = h.db.prepare('SELECT cleanup_status FROM workspaces').get();
    assert.equal(ws?.cleanup_status, 'rolled_back');
  } finally {
    h.dispose();
  }
});

test('trust 步确定失败：回滚 env 与 workspace（destroy+forget 被调）、认领删除', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.trust.failNextProvision = new Error('宿主配置不可写');
    await expectGovError(makeService(h).claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', 'trust');

    assert.equal(h.env.destroyCalls.length, 1, '环境应被 destroy 回滚');
    assert.equal(h.jj.workspaceForgetCalls.length, 1);
    assert.equal(h.orca.workerStartCalls.length, 0, 'worker 启动前信任预置必须完成');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM claims').get()?.c, 0);
  } finally {
    h.dispose();
  }
});

test('workerStart 挂起超时：E_CLAIM_UNCERTAIN、认领与步骤回执 UNCERTAIN、资源不清理且第二认领被拒', async () => {
  const h = createFakeHost({ stepTimeoutMs: 40 });
  try {
    const { taskId } = await declareSampleTask(h);
    h.orca.script.push({ kind: 'hang' });
    const service = makeService(h);
    const err = await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_UNCERTAIN');
    assert.ok(err.message.includes('超时') || err.message.includes('不确定'));

    const claimRow = h.db.prepare('SELECT status FROM claims').get();
    assert.equal(claimRow?.status, 'UNCERTAIN');
    // 步骤回执按确定性幂等键查询（finalize 会把 current_step 置 settled）。
    const step = h.db
      .prepare("SELECT status FROM operations WHERE request_id LIKE 'claim:%:worker-start'")
      .get();
    assert.equal(step?.status, 'UNCERTAIN');
    // 外部结果不确定：绝不清理（容器可能仍在建/在用）。
    assert.equal(h.env.destroyCalls.length, 0);
    assert.equal(h.jj.workspaceForgetCalls.length, 0);
    // 阻止第二认领。
    await expectGovError(service.claim('cap-coord-2', { taskId }), 'E_CLAIM_EXISTS');
  } finally {
    h.dispose();
  }
});

test('workerStart exec 超时（exitCode=TIMEOUT）：同样判不确定阻断', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.orca.script.push({ kind: 'exec-timeout' });
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_UNCERTAIN');
    assert.equal(h.db.prepare('SELECT status FROM claims').get()?.status, 'UNCERTAIN');
    await expectGovError(service.claim('cap-coord-2', { taskId }), 'E_CLAIM_EXISTS');
  } finally {
    h.dispose();
  }
});

test('信任门首死：blockedReason=trust_gate、workerStart 恰一次不盲重试、认领释放', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.orca.script.push({ kind: 'receipt-failed', failedStage: 'agent_readiness', dispatchId: 'disp-trust-1' });
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', '信任门');

    assert.equal(h.orca.workerStartCalls.length, 1, '信任门首死不得自动重试');
    assert.equal(h.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason, 'trust_gate');
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM claims').get()?.c, 0, '失败认领应释放');
    // 资源清理：信任门是确定失败，回滚已建资源。
    assert.equal(h.env.destroyCalls.length, 1);
    assert.equal(h.jj.workspaceForgetCalls.length, 1);
  } finally {
    h.dispose();
  }
});

test('trust_gate 后不带 retryOf 重认领被拒；带 retryOf 重派成功且 blockedReason 清除', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.orca.script.push({ kind: 'receipt-failed', failedStage: 'agent_readiness', dispatchId: 'disp-trust-1' });
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', '信任门');

    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_STATE_INVALID', 'retryOf');

    const reissued = await service.claim(SESSION, { taskId, retryOf: 'disp-trust-1' });
    assert.equal(reissued.status, 'DISPATCHED');
    assert.equal(h.orca.workerStartCalls[1]?.retryOf, 'disp-trust-1');
    assert.equal(h.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason, null);
  } finally {
    h.dispose();
  }
});

test('重试上限：同任务第 3 次 worker 启动失败即 E_CLAIM_RETRY_EXHAUSTED，第 4 次入口拒绝', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    const service = makeService(h);
    for (let i = 0; i < 2; i++) {
      h.orca.script.push({ kind: 'receipt-failed', failedStage: 'worktree_create' });
      await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED', 'worker');
    }
    h.orca.script.push({ kind: 'receipt-failed', failedStage: 'worktree_create' });
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_RETRY_EXHAUSTED');

    assert.equal(h.orca.workerStartCalls.length, 3, '尝试计数以事件为真源，恰 3 次');
    assert.equal(
      h.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason,
      'retry_exhausted',
    );
    // 上限耗尽后：入口直接拒绝，不再产生第 4 次外部调用。
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_RETRY_EXHAUSTED');
    assert.equal(h.orca.workerStartCalls.length, 3);
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS c FROM events WHERE type = ?').get(CLAIM_EVENT_TYPES.workerStartAttempt)?.c,
      3,
    );
  } finally {
    h.dispose();
  }
});

test('任务非 DECLARED：E_CLAIM_STATE_INVALID', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.db.prepare("UPDATE tasks SET status = 'ACTIVE' WHERE task_id = ?").run(taskId);
    await expectGovError(makeService(h).claim(SESSION, { taskId }), 'E_CLAIM_STATE_INVALID', 'DECLARED');
    assert.equal(h.orca.workerStartCalls.length, 0);
  } finally {
    h.dispose();
  }
});

test('claim 后未 accept：setWritable 从未被调用（写权限切换只属于 accept 路径）', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    await makeService(h).claim(SESSION, { taskId });
    assert.equal(h.env.setWritableCalls.length, 0);
    assert.equal(h.env.setReadonlyCalls.length, 0);
  } finally {
    h.dispose();
  }
});

test('声明事件缺失（库内真源损坏）：拒绝认领且不产生任何外部动作', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.db.prepare('DELETE FROM events WHERE type = ?').run('declared');
    await expectGovError(makeService(h).claim(SESSION, { taskId }), 'E_REQUEST_INVALID', '声明事件');
    assert.equal(h.jj.workspaceAddCalls.length, 0);
    assert.equal(h.orca.workerStartCalls.length, 0);
  } finally {
    h.dispose();
  }
});

test('claim 载荷走 handler：非法 payload 报 E_REQUEST_INVALID（信封解析）', async () => {
  const h = createFakeHost();
  try {
    const { createClaimHandler } = await import('../../../src/services/claims.ts');
    const handler = createClaimHandler(h.deps);
    await expectGovError(
      handler({
        db: h.db,
        dbPath: ':memory:',
        config: h.config,
        configPath: 'unused',
        token: {
          capabilityId: 'cap-coord',
          role: 'coordinator',
          taskId: null,
          claimId: null,
          reviewId: null,
          actions: ['claim'],
          expiresAt: null,
        },
        payload: { taskId: '' },
      }),
      'E_REQUEST_INVALID',
    );
  } finally {
    h.dispose();
  }
});
