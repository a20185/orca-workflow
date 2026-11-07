import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { withTransaction } from '../../../src/db/database.ts';
import { openDatabase } from '../../../src/db/database.ts';
import {
  assertWriteRejects,
  insertClaim,
  insertReview,
  insertSubmission,
  insertTask,
  openMigratedMemoryDb,
  openMigratedTmpDb,
  T0,
} from './testing.ts';

test('外键生效：孤儿认领（task 不存在）被拒', () => {
  const db = openMigratedMemoryDb();
  assertWriteRejects(
    db,
    `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
    ['cl-orphan', 'gt-missing', 'PREPARING', T0, T0],
    'FOREIGN KEY',
  );
});

test('外键生效：孤儿提交（claim 不存在）被拒', () => {
  const db = openMigratedMemoryDb();
  assertWriteRejects(
    db,
    `INSERT INTO submissions (submission_id, claim_id, commit_id, created_at) VALUES (?, ?, ?, ?)`,
    ['sb-orphan', 'cl-missing', 'a'.repeat(40), T0],
    'FOREIGN KEY',
  );
});

test('外键生效：孤儿证据（submission 不存在）被拒', () => {
  const db = openMigratedMemoryDb();
  assertWriteRejects(
    db,
    `INSERT INTO evidence (evidence_id, criterion_id, submission_id) VALUES (?, ?, ?)`,
    ['ev-orphan', 'crit-1', 'sb-missing'],
    'FOREIGN KEY',
  );
});

test('外键生效：孤儿验收标准与孤儿事件被拒', () => {
  const db = openMigratedMemoryDb();
  assertWriteRejects(
    db,
    `INSERT INTO acceptance_criteria (task_id, criterion_id, type, config_json, requires_manual)
     VALUES (?, ?, ?, ?, ?)`,
    ['gt-missing', 'crit-1', 'command', '{}', 0],
    'FOREIGN KEY',
  );
  assertWriteRejects(
    db,
    `INSERT INTO events (task_id, type, created_at) VALUES (?, ?, ?)`,
    ['gt-missing', 'declared', T0],
    'FOREIGN KEY',
  );
});

test('tasks.task_id 必须 gt- 前缀；status 越界被拒', () => {
  const db = openMigratedMemoryDb();
  assertWriteRejects(
    db,
    `INSERT INTO tasks (task_id, spec_hash, status, target_json, declared_session, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['xx-1', 'h', 'DECLARED', '{}', 's', T0, T0],
    'CHECK',
  );
  assertWriteRejects(
    db,
    `INSERT INTO tasks (task_id, spec_hash, status, target_json, declared_session, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ['gt-bad-status', 'h', 'PAUSED', '{}', 's', T0, T0],
    'CHECK',
  );
  insertTask(db, 'gt-ok');
});

test('同一任务第二个非终态认领被唯一索引拒绝；终态认领可并存', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-claim-uniq');
  insertClaim(db, 'cl-a', 'gt-claim-uniq', 'ACTIVE');

  // 各非终态形态都占用「唯一活跃位」。
  for (const [claimId, status] of [
    ['cl-b', 'PREPARING'],
    ['cl-c', 'DISPATCHED'],
    ['cl-d', 'ACTIVE'],
    ['cl-e', 'UNCERTAIN'],
  ] as const) {
    assertWriteRejects(
      db,
      `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      [claimId, 'gt-claim-uniq', status, T0, T0],
      'UNIQUE constraint failed: claims.task_id',
      `ACTIVE 之后再插 ${status} 应被拒`,
    );
  }

  // 终态（RELEASED/FENCED）不占活跃位。
  db.prepare(
    `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('cl-released', 'gt-claim-uniq', 'RELEASED', T0, T0);
  db.prepare(
    `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run('cl-fenced', 'gt-claim-uniq', 'FENCED', T0, T0);

  // 活跃位释放后（改 RELEASED）可再次认领。
  db.prepare(`UPDATE claims SET status = 'RELEASED' WHERE claim_id = 'cl-a'`).run();
  insertClaim(db, 'cl-next', 'gt-claim-uniq', 'ACTIVE');
});

test('submissions(claim_id, commit_id) 唯一：重复对拒，不同 claim 或不同 commit 可并存', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-sub');
  insertClaim(db, 'cl-1', 'gt-sub', 'ACTIVE');
  insertClaim(db, 'cl-2', 'gt-sub', 'RELEASED');
  insertSubmission(db, 'sb-1', 'cl-1', 'c1'.padEnd(40, '0'));
  assertWriteRejects(
    db,
    `INSERT INTO submissions (submission_id, claim_id, commit_id, created_at) VALUES (?, ?, ?, ?)`,
    ['sb-dup', 'cl-1', 'c1'.padEnd(40, '0'), T0],
    'UNIQUE constraint failed: submissions.claim_id, submissions.commit_id',
  );
  insertSubmission(db, 'sb-2', 'cl-1', 'c2'.padEnd(40, '0'));
  insertSubmission(db, 'sb-3', 'cl-2', 'c1'.padEnd(40, '0'));
});

test('reviews：同一提交至多一行未作废结论（aborted 可多次）', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-rev');
  insertClaim(db, 'cl-r', 'gt-rev', 'ACTIVE');
  insertSubmission(db, 'sb-r', 'cl-r', 'c1'.padEnd(40, '0'));

  insertReview(db, 'rv-abort-1', 'sb-r', 'aborted');
  insertReview(db, 'rv-abort-2', 'sb-r', 'aborted');
  insertReview(db, 'rv-approve', 'sb-r', 'approved');
  assertWriteRejects(
    db,
    `INSERT INTO reviews (review_id, submission_id, verdict, created_at) VALUES (?, ?, ?, ?)`,
    ['rv-approve-2', 'sb-r', 'approved', T0],
    'UNIQUE constraint failed: reviews.submission_id',
  );
  assertWriteRejects(
    db,
    `INSERT INTO reviews (review_id, submission_id, verdict, created_at) VALUES (?, ?, ?, ?)`,
    ['rv-changes', 'sb-r', 'changes_requested', T0],
    'UNIQUE constraint failed: reviews.submission_id',
  );
});

test('merges：同一提交只有一行合并记录', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-merge');
  insertClaim(db, 'cl-m', 'gt-merge', 'ACTIVE');
  insertSubmission(db, 'sb-m', 'cl-m', 'c1'.padEnd(40, '0'));
  db.prepare(
    `INSERT INTO merges (merge_id, submission_id, target_bookmark) VALUES (?, ?, ?)`,
  ).run('mg-1', 'sb-m', 'main');
  assertWriteRejects(
    db,
    `INSERT INTO merges (merge_id, submission_id, target_bookmark) VALUES (?, ?, ?)`,
    ['mg-2', 'sb-m', 'main'],
    'UNIQUE',
  );
});

test('operations：request_id 唯一，request_hash 漂移被触发器拒绝，生命周期内不可变', () => {
  const db = openMigratedMemoryDb();
  const insert = `INSERT INTO operations (operation_id, request_id, request_hash, kind, status, created_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?)`;
  db.prepare(insert).run('op-1', 'req-1', 'hash-aaa', 'merge', 'PREPARED', T0, T0);

  // 同 id 同 hash：唯一索引拒绝（幂等重放路径，由调用方按回执处理）。
  assertWriteRejects(
    db,
    insert,
    ['op-1b', 'req-1', 'hash-aaa', 'merge', 'PREPARED', T0, T0],
    'UNIQUE constraint failed: operations.request_id',
  );
  // 同 id 不同 hash：触发器先于唯一约束拦截，错误信息可区分。
  assertWriteRejects(
    db,
    insert,
    ['op-1c', 'req-1', 'hash-bbb', 'merge', 'PREPARED', T0, T0],
    'request_hash 不一致',
  );
  // 生命周期内 request_id/request_hash 不可变更，但状态推进合法。
  assertWriteRejects(
    db,
    `UPDATE operations SET request_hash = ? WHERE operation_id = ?`,
    ['hash-ccc', 'op-1'],
    '不可变更',
  );
  db.prepare(`UPDATE operations SET status = 'CONFIRMED', updated_at = ? WHERE operation_id = ?`).run(
    T0,
    'op-1',
  );
  assert.equal(
    db.prepare(`SELECT status FROM operations WHERE operation_id = 'op-1'`).get()?.status,
    'CONFIRMED',
  );
});

test('evidence：submission 与 review 二选一非空', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-ev');
  insertClaim(db, 'cl-ev', 'gt-ev', 'ACTIVE');
  insertSubmission(db, 'sb-ev', 'cl-ev', 'c1'.padEnd(40, '0'));
  insertReview(db, 'rv-ev', 'sb-ev', 'approved');

  assertWriteRejects(
    db,
    `INSERT INTO evidence (evidence_id, criterion_id) VALUES (?, ?)`,
    ['ev-both-null', 'crit-1'],
    'CHECK',
  );
  assertWriteRejects(
    db,
    `INSERT INTO evidence (evidence_id, criterion_id, submission_id, review_id) VALUES (?, ?, ?, ?)`,
    ['ev-both-set', 'crit-1', 'sb-ev', 'rv-ev'],
    'CHECK',
  );
  db.prepare(`INSERT INTO evidence (evidence_id, criterion_id, submission_id) VALUES (?, ?, ?)`).run(
    'ev-sub',
    'crit-1',
    'sb-ev',
  );
  db.prepare(`INSERT INTO evidence (evidence_id, criterion_id, review_id) VALUES (?, ?, ?)`).run(
    'ev-rev',
    'crit-1',
    'rv-ev',
  );
});

test('events.seq 单调递增（AUTOINCREMENT）', () => {
  const db = openMigratedMemoryDb();
  insertTask(db, 'gt-seq');
  const insert = `INSERT INTO events (task_id, type, created_at) VALUES (?, ?, ?)`;
  const seqs: number[] = [];
  for (let i = 0; i < 3; i++) {
    const result = db.prepare(insert).run('gt-seq', `t${i}`, T0);
    seqs.push(Number(result.lastInsertRowid));
  }
  assert.deepEqual(seqs, [1, 2, 3]);
  assert.ok(seqs.every((seq, i) => i === 0 || seq > seqs[i - 1]!));
});

test('并发事务：另一连接 BEGIN IMMEDIATE 立即失败，无脏写，提交后可重试', () => {
  const tmp = openMigratedTmpDb();
  try {
    insertTask(tmp.db, 'gt-concurrent');
    const other = openDatabase(tmp.file);

    // 连接 A 持写锁未提交。
    withTransaction(tmp.db, (tx) => {
      tx.prepare(
        `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('cl-a', 'gt-concurrent', 'ACTIVE', T0, T0);

      // 连接 B 同步取写锁：立即 SQLITE_BUSY 失败，而不是阻塞或脏写。
      assert.throws(
        () => other.exec('BEGIN IMMEDIATE'),
        (err: unknown) => err instanceof Error && err.message.includes('database is locked'),
      );
      // B 在锁被占期间确实写不进去。
      assert.throws(() =>
        other.prepare(
          `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
        ).run('cl-b', 'gt-concurrent', 'ACTIVE', T0, T0),
      );
    });
    // A 提交后 B 的事务可以成功。
    withTransaction(other, (tx) => {
      tx.prepare(
        `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('cl-b', 'gt-concurrent', 'RELEASED', T0, T0);
    });
    const count = tmp.db.prepare(`SELECT COUNT(*) AS c FROM claims`).get();
    assert.equal(Number(count?.c), 2);
    other.close();
  } finally {
    tmp.close();
  }
});
