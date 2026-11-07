import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { GovError } from '../../../src/domain/errors.ts';
import {
  TASK_EVENTS,
  TASK_STATUSES,
  TASK_TERMINAL_STATUSES,
  TASK_TRANSITION_EDGES,
  applyTaskTransition,
  type TaskEvent,
  type TaskStatus,
} from '../../../src/state/task-machine.ts';
import { insertTask, openMigratedMemoryDb } from './testing.ts';

/** 设计 §7 的 31 条合法边，按状态机真源同序展开（对象键序）。 */
const EXPECTED_EDGES: ReadonlyArray<{ from: TaskStatus; event: TaskEvent; to: TaskStatus }> = [
  { from: 'DECLARED', event: 'accept', to: 'ACTIVE' },
  { from: 'DECLARED', event: 'cancel', to: 'CANCELLED' },
  { from: 'DECLARED', event: 'supersede', to: 'SUPERSEDED' },
  { from: 'ACTIVE', event: 'submit', to: 'REVIEW_REQUESTED' },
  { from: 'ACTIVE', event: 'fail', to: 'FAILED' },
  { from: 'ACTIVE', event: 'split', to: 'WAITING_CHILD' },
  { from: 'ACTIVE', event: 'cancel', to: 'CANCELLED' },
  { from: 'ACTIVE', event: 'supersede', to: 'SUPERSEDED' },
  { from: 'WAITING_CHILD', event: 'child_merged', to: 'ACTIVE' },
  { from: 'WAITING_CHILD', event: 'child_terminated', to: 'ACTIVE' },
  { from: 'WAITING_CHILD', event: 'child_superseded', to: 'WAITING_CHILD' },
  { from: 'CHANGES_REQUESTED', event: 'submit', to: 'REVIEW_REQUESTED' },
  { from: 'CHANGES_REQUESTED', event: 'review_request', to: 'REVIEW_REQUESTED' },
  { from: 'CHANGES_REQUESTED', event: 'fail', to: 'FAILED' },
  { from: 'CHANGES_REQUESTED', event: 'split', to: 'WAITING_CHILD' },
  { from: 'CHANGES_REQUESTED', event: 'cancel', to: 'CANCELLED' },
  { from: 'CHANGES_REQUESTED', event: 'supersede', to: 'SUPERSEDED' },
  { from: 'REVIEW_REQUESTED', event: 'review_accept', to: 'IN_REVIEW' },
  { from: 'REVIEW_REQUESTED', event: 'target_moved', to: 'ACTIVE' },
  { from: 'REVIEW_REQUESTED', event: 'executor_replaced', to: 'ACTIVE' },
  { from: 'REVIEW_REQUESTED', event: 'fail', to: 'FAILED' },
  { from: 'REVIEW_REQUESTED', event: 'cancel', to: 'CANCELLED' },
  { from: 'REVIEW_REQUESTED', event: 'supersede', to: 'SUPERSEDED' },
  { from: 'IN_REVIEW', event: 'reject', to: 'CHANGES_REQUESTED' },
  { from: 'IN_REVIEW', event: 'review_aborted', to: 'REVIEW_REQUESTED' },
  { from: 'IN_REVIEW', event: 'cancel', to: 'CANCELLED' },
  { from: 'IN_REVIEW', event: 'supersede', to: 'SUPERSEDED' },
  { from: 'IN_REVIEW', event: 'approve', to: 'APPROVED' },
  { from: 'APPROVED', event: 'merge_confirmed', to: 'MERGED' },
  { from: 'APPROVED', event: 'target_moved', to: 'CHANGES_REQUESTED' },
  { from: 'MERGED', event: 'complete', to: 'COMPLETED' },
];

function expectTransitionInvalid(db: DatabaseSync, taskId: string, event: TaskEvent): void {
  assert.throws(
    () => applyTaskTransition(db, taskId, event),
    (err: unknown) => {
      assert.ok(err instanceof GovError, `应抛 GovError，实际: ${String(err)}`);
      assert.equal(err.code, 'E_TRANSITION_INVALID');
      return true;
    },
    `预期 ${taskId} 上事件 ${event} 被拒`,
  );
}

test('合法迁移表恰为设计 §7 的 31 条边', () => {
  assert.equal(TASK_TRANSITION_EDGES.length, 31);
  assert.deepEqual(TASK_TRANSITION_EDGES, EXPECTED_EDGES);
  // 每条边 from/to 都在状态全集内，且事件全集无遗漏拼错。
  assert.equal(new Set(EXPECTED_EDGES.map((e) => e.event)).size, TASK_EVENTS.length);
});

test('全部 31 条合法边可走：status 落库且 events 逐边记录', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-edge-walk');
  const setStatus = db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?');

  for (const edge of TASK_TRANSITION_EDGES) {
    setStatus.run(edge.from, 'gt-edge-walk');
    const result = applyTaskTransition(db, 'gt-edge-walk', edge.event, {
      actor: 'test',
      payload: { event: edge.event },
    });
    assert.deepEqual(
      { from: result.from, to: result.to },
      { from: edge.from, to: edge.to },
      `边 ${edge.from} --${edge.event}--> ${edge.to}`,
    );
    const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('gt-edge-walk');
    assert.equal(row?.status, edge.to);
    const evt = db
      .prepare('SELECT task_id, type, actor FROM events WHERE seq = ?')
      .get(result.eventSeq);
    // node:sqlite 返回 null-prototype 行，逐字段比较。
    assert.equal(evt?.task_id, 'gt-edge-walk');
    assert.equal(evt?.type, edge.event);
    assert.equal(evt?.actor, 'test');
  }
  // 逐边记录：31 条边 → 31 行事件，seq 单调。
  const seqs = db
    .prepare('SELECT seq FROM events ORDER BY seq ASC')
    .all()
    .map((row) => Number(row.seq));
  assert.equal(seqs.length, 31);
  assert.ok(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!));
});

test('终态无出边：四个终态 × 全部已知事件均抛 E_TRANSITION_INVALID', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-terminal');
  const setStatus = db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?');
  for (const terminal of TASK_TERMINAL_STATUSES) {
    for (const event of TASK_EVENTS) {
      setStatus.run(terminal, 'gt-terminal');
      expectTransitionInvalid(db, 'gt-terminal', event);
    }
  }
});

test('跨态跳变与非法组合抽样均抛 E_TRANSITION_INVALID', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-illegal');
  const setStatus = db.prepare('UPDATE tasks SET status = ? WHERE task_id = ?');
  const samples: ReadonlyArray<[TaskStatus, TaskEvent]> = [
    ['DECLARED', 'submit'],
    ['DECLARED', 'approve'],
    ['DECLARED', 'complete'],
    ['ACTIVE', 'accept'],
    ['ACTIVE', 'approve'],
    ['ACTIVE', 'merge_confirmed'],
    ['WAITING_CHILD', 'submit'],
    ['WAITING_CHILD', 'approve'],
    ['CHANGES_REQUESTED', 'review_accept'],
    ['CHANGES_REQUESTED', 'approve'],
    ['REVIEW_REQUESTED', 'reject'],
    ['REVIEW_REQUESTED', 'submit'],
    ['IN_REVIEW', 'submit'],
    ['IN_REVIEW', 'fail'],
    ['APPROVED', 'complete'],
    ['APPROVED', 'accept'],
    ['MERGED', 'approve'],
    ['MERGED', 'cancel'],
  ];
  for (const [from, event] of samples) {
    setStatus.run(from, 'gt-illegal');
    expectTransitionInvalid(db, 'gt-illegal', event);
  }
});

test('未知事件与不存在的任务抛 E_TRANSITION_INVALID', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-exist');
  expectTransitionInvalid(db, 'gt-exist', 'resurrect' as TaskEvent);
  expectTransitionInvalid(db, 'gt-missing', 'accept');
});

test('非法迁移零残留：状态与事件表都不落任何写入', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-noresidue');
  db.prepare(`INSERT INTO events (task_id, type, created_at) VALUES (?, ?, ?)`).run(
    'gt-noresidue',
    'declared',
    '2026-11-07T00:00:00.000Z',
  );
  const before = db
    .prepare('SELECT status, updated_at FROM tasks WHERE task_id = ?')
    .get('gt-noresidue');
  expectTransitionInvalid(db, 'gt-noresidue', 'approve');
  const after = db
    .prepare('SELECT status, updated_at FROM tasks WHERE task_id = ?')
    .get('gt-noresidue');
  assert.deepEqual(after, before);
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c, 1);
});

test('events 载荷带 sha256 哈希，与 JSON 序列化一致', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-payload');
  const result = applyTaskTransition(db, 'gt-payload', 'accept', {
    actor: 'executor:s1',
    payload: { claimId: 'cl-x', note: '认领' },
  });
  const evt = db.prepare('SELECT * FROM events WHERE seq = ?').get(result.eventSeq);
  const payloadJson = JSON.stringify({ claimId: 'cl-x', note: '认领' });
  assert.equal(evt?.payload_json, payloadJson);
  assert.equal(
    evt?.payload_hash,
    createHash('sha256').update(payloadJson, 'utf8').digest('hex'),
  );
  // 无载荷时 payload 两列为 NULL。
  const bare = applyTaskTransition(db, 'gt-payload', 'submit');
  const bareEvt = db.prepare('SELECT payload_json, payload_hash FROM events WHERE seq = ?').get(
    bare.eventSeq,
  );
  assert.equal(bareEvt?.payload_json, null);
  assert.equal(bareEvt?.payload_hash, null);
});

test('主链全走通：DECLARED→…→COMPLETED，终态后无事件可再触发', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-happy');
  const chain: ReadonlyArray<[TaskEvent, TaskStatus]> = [
    ['accept', 'ACTIVE'],
    ['submit', 'REVIEW_REQUESTED'],
    ['review_accept', 'IN_REVIEW'],
    ['approve', 'APPROVED'],
    ['merge_confirmed', 'MERGED'],
    ['complete', 'COMPLETED'],
  ];
  for (const [event, expected] of chain) {
    const result = applyTaskTransition(db, 'gt-happy', event);
    assert.equal(result.to, expected);
    assert.equal(
      db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('gt-happy')?.status,
      expected,
    );
  }
  for (const event of TASK_EVENTS) {
    expectTransitionInvalid(db, 'gt-happy', event);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c, chain.length);
});

test('子任务等待的 child_superseded 自环停留在 WAITING_CHILD', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-wait', 'WAITING_CHILD');
  const result = applyTaskTransition(db, 'gt-wait', 'child_superseded');
  assert.deepEqual(result, { from: 'WAITING_CHILD', to: 'WAITING_CHILD', eventSeq: result.eventSeq });
  assert.equal(
    db.prepare('SELECT status FROM tasks WHERE task_id = ?').get('gt-wait')?.status,
    'WAITING_CHILD',
  );
});

test('任务状态全集与终态集合与设计 §7 一致', () => {
  assert.equal(TASK_STATUSES.length, 12);
  assert.deepEqual(TASK_TERMINAL_STATUSES, ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED']);
});
