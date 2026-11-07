/**
 * T3.1 declare 单测：任务书校验、事务写库（tasks + acceptance_criteria +
 * declared 事件）、Orca 登记回填、失败 blockedReason 与幂等重试。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { declareTask, DECLARED_EVENT_TYPE } from '../../../src/services/tasks.ts';
import { createFakeHost, expectGovError, sampleSpec, type FakeHost } from './testing.ts';

function host(): FakeHost {
  return createFakeHost();
}

test('declare 成功：tasks/acceptance_criteria/declared 事件落库，orcaTaskId 回填', async () => {
  const h = host();
  try {
    const result = await declareTask(
      { db: h.db, config: h.config, orca: h.orca },
      { spec: sampleSpec(), session: 'cap-decl-1' },
    );
    assert.equal(result.taskId, 'gt-unit-claim');
    assert.match(result.specHash, /^[0-9a-f]{64}$/);
    assert.equal(result.orcaTaskId, 'ot-1');

    const task = h.db.prepare('SELECT * FROM tasks WHERE task_id = ?').get('gt-unit-claim');
    assert.equal(task?.status, 'DECLARED');
    assert.equal(task?.orca_task_id, 'ot-1');
    assert.equal(task?.declared_session, 'cap-decl-1');
    assert.equal(task?.blocked_reason, null);
    assert.equal(task?.current_claim_id, null);

    const criteria = h.db
      .prepare('SELECT criterion_id, type, requires_manual FROM acceptance_criteria WHERE task_id = ? ORDER BY criterion_id')
      .all('gt-unit-claim');
    assert.deepEqual(
      criteria.map((c) => [String(c.criterion_id), String(c.type), Number(c.requires_manual)]),
      [
        ['cmd-1', 'command', 0],
        ['man-1', 'manual', 1],
      ],
    );

    const event = h.db
      .prepare('SELECT actor, payload_json FROM events WHERE task_id = ? AND type = ?')
      .get('gt-unit-claim', DECLARED_EVENT_TYPE);
    assert.equal(event?.actor, 'cap-decl-1');
    const payload = JSON.parse(String(event?.payload_json)) as { specHash: string; spec: { taskId: string } };
    assert.equal(payload.specHash, result.specHash);
    assert.equal(payload.spec.taskId, 'gt-unit-claim');

    // Orca 收到的 spec 摘要含 taskId + specHash + 验收标准列表。
    assert.equal(h.orca.taskCreateCalls.length, 1);
    const summary = JSON.parse(h.orca.taskCreateCalls[0]?.spec ?? '{}') as {
      taskId: string;
      specHash: string;
      acceptanceCriteria: Array<{ criterionId: string }>;
    };
    assert.equal(summary.taskId, 'gt-unit-claim');
    assert.equal(summary.specHash, result.specHash);
    assert.deepEqual(
      summary.acceptanceCriteria.map((c) => c.criterionId).sort(),
      ['cmd-1', 'man-1'],
    );
  } finally {
    h.dispose();
  }
});

test('declare 幂等：同 taskId 同任务书重复声明不再调 orca.taskCreate', async () => {
  const h = host();
  try {
    const first = await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: sampleSpec(), session: 'cap-a' });
    const second = await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: sampleSpec(), session: 'cap-b' });
    assert.equal(second.orcaTaskId, first.orcaTaskId);
    assert.equal(second.specHash, first.specHash);
    assert.equal(h.orca.taskCreateCalls.length, 1);
    // 键序无关的规范化：同任务书键序打乱仍幂等。
    const shuffled = Object.fromEntries(Object.entries(sampleSpec()).reverse());
    const third = await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: shuffled, session: 'cap-c' });
    assert.equal(third.specHash, first.specHash);
    assert.equal(h.orca.taskCreateCalls.length, 1);
  } finally {
    h.dispose();
  }
});

test('declare 任务书非法：E_SPEC_INVALID 且不写库不调 Orca', async () => {
  const h = host();
  try {
    const bad = { ...sampleSpec(), inScope: [] };
    await expectGovError(
      declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: bad, session: 'cap-x' }),
      'E_SPEC_INVALID',
    );
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()?.c, 0);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c, 0);
    assert.equal(h.orca.taskCreateCalls.length, 0);
  } finally {
    h.dispose();
  }
});

test('declare Orca 登记失败：任务行置 blockedReason 可重试；重试成功后回填并清除', async () => {
  const h = host();
  try {
    h.orca.failTaskCreate(new GovError('E_ORCA_CALL_FAILED', 'runtime 未就绪'));
    await expectGovError(
      declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: sampleSpec(), session: 'cap-a' }),
      'E_ORCA_CALL_FAILED',
    );
    const blocked = h.db.prepare('SELECT status, orca_task_id, blocked_reason FROM tasks WHERE task_id = ?').get('gt-unit-claim');
    assert.equal(blocked?.status, 'DECLARED');
    assert.equal(blocked?.orca_task_id, null);
    assert.equal(blocked?.blocked_reason, 'orca_task_create_failed');

    // 换新 requestId 重试：任务行与事件不重复，登记成功后清除 blockedReason。
    h.orca.failTaskCreate(null);
    const retried = await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: sampleSpec(), session: 'cap-a' });
    assert.equal(retried.orcaTaskId, 'ot-1');
    assert.equal(h.orca.taskCreateCalls.length, 2);
    assert.equal(h.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()?.c, 1);
    assert.equal(
      h.db.prepare('SELECT COUNT(*) AS c FROM events WHERE type = ?').get(DECLARED_EVENT_TYPE)?.c,
      1,
    );
    const cleared = h.db.prepare('SELECT orca_task_id, blocked_reason FROM tasks WHERE task_id = ?').get('gt-unit-claim');
    assert.equal(cleared?.orca_task_id, 'ot-1');
    assert.equal(cleared?.blocked_reason, null);
  } finally {
    h.dispose();
  }
});

test('declare 同 taskId 不同任务书：E_REQUEST_INVALID', async () => {
  const h = host();
  try {
    await declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: sampleSpec(), session: 'cap-a' });
    const diverged = { ...sampleSpec(), problem: '换了问题' };
    await expectGovError(
      declareTask({ db: h.db, config: h.config, orca: h.orca }, { spec: diverged, session: 'cap-b' }),
      'E_REQUEST_INVALID',
      '不一致',
    );
    assert.equal(h.orca.taskCreateCalls.length, 1);
  } finally {
    h.dispose();
  }
});
