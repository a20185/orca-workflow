/**
 * T3.1 历史认领查询单测：UNCERTAIN 认领保留并阻断；人工 resolve 到 RELEASED
 * 后仍可查且放行第二认领；准备期失败释放的认领经 events 留 RELEASED 记录。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createClaimService, CLAIM_EVENT_TYPES } from '../../../src/services/claims.ts';
import { applyClaimTransition } from '../../../src/state/claim-machine.ts';
import { createFakeHost, declareSampleTask, expectGovError, type FakeHost } from './testing.ts';

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

test('UNCERTAIN 认领保留可查；人工 resolve 为 RELEASED 后仍可查且第二认领放行', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.orca.script.push({ kind: 'exec-timeout' });
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_UNCERTAIN');

    let claims = service.listClaims(taskId);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.status, 'UNCERTAIN');
    assert.equal(claims[0]?.claimerSession, null);
    await expectGovError(service.claim('cap-coord-2', { taskId }), 'E_CLAIM_EXISTS');

    // 人工经 operation resume 查明后置 RELEASED（合法出边 UNCERTAIN→RELEASED）。
    applyClaimTransition(h.db, claims[0]?.claimId ?? '', 'RELEASED');
    claims = service.listClaims(taskId);
    assert.equal(claims.length, 1, '历史认领必须保留');
    assert.equal(claims[0]?.status, 'RELEASED');

    // 放行第二认领：新认领从头走通。
    const second = await service.claim('cap-coord-2', { taskId });
    assert.equal(second.status, 'DISPATCHED');
    assert.equal(service.listClaims(taskId).length, 2);
    assert.equal(service.listClaims(taskId).map((c) => c.status).includes('RELEASED'), true);
  } finally {
    h.dispose();
  }
});

test('准备期失败释放的认领：行删除但 events 留 claim_released 记录（含阶段与回滚残误）', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    h.env.failNextCreate = new Error('环境起不来');
    const service = makeService(h);
    await expectGovError(service.claim(SESSION, { taskId }), 'E_CLAIM_PREP_FAILED');
    assert.equal(service.listClaims(taskId).length, 0);

    const events = h.db
      .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
      .all(taskId, CLAIM_EVENT_TYPES.released);
    assert.equal(events.length, 1);
    const payload = JSON.parse(String(events[0]?.payload_json)) as {
      claimId: string;
      stage: string;
      rollbackErrors: string[];
    };
    assert.match(payload.claimId, /^gcl_/);
    assert.equal(payload.stage, 'prepare');
    assert.deepEqual(payload.rollbackErrors, []);
  } finally {
    h.dispose();
  }
});
