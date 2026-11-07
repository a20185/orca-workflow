import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDatabase, withTransaction } from '../../../src/db/database.ts';
import { MIGRATIONS, migrate } from '../../../src/db/migrations.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { T0, insertTask, openMigratedMemoryDb, openMigratedTmpDb } from './testing.ts';

const EXPECTED_TABLES = [
  'tasks',
  'acceptance_criteria',
  'claims',
  'workspaces',
  'submissions',
  'reviews',
  'findings',
  'evidence',
  'merges',
  'operations',
  'events',
  'capabilities',
];

function objectNames(db: ReturnType<typeof openDatabase>, kind: 'table' | 'index' | 'trigger') {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%'")
    .all(kind)
    .map((row) => String(row.name))
    .sort();
}

test('migrate 建齐 §6.2 全部 12 张记录表 + migrations + 业务索引与触发器', () => {
  const db = openMigratedMemoryDb();
  const tables = objectNames(db, 'table');
  for (const name of [...EXPECTED_TABLES, 'migrations']) {
    assert.ok(tables.includes(name), `缺表: ${name}`);
  }
  assert.equal(tables.length, EXPECTED_TABLES.length + 1);

  const indexes = objectNames(db, 'index');
  for (const name of [
    'uq_claims_live_per_task',
    'uq_submissions_claim_commit',
    'uq_reviews_conclusive_per_submission',
    'uq_operations_request',
  ]) {
    assert.ok(indexes.includes(name), `缺唯一索引: ${name}`);
  }

  const triggers = objectNames(db, 'trigger');
  for (const name of [
    'trg_operations_request_hash_insert_guard',
    'trg_operations_request_hash_update_guard',
  ]) {
    assert.ok(triggers.includes(name), `缺触发器: ${name}`);
  }
});

test('重复 migrate 幂等：同连接二次执行无新增', () => {
  const db = openMigratedMemoryDb();
  migrate(db);
  migrate(db);
  const rows = db.prepare('SELECT id FROM migrations ORDER BY id').all();
  assert.deepEqual(
    rows.map((row) => Number(row.id)),
    MIGRATIONS.map((m) => m.id),
  );
});

test('重启后重新打开：迁移幂等且既有数据完好', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-restart-'));
  const file = join(dir, 'gov.db');
  try {
    const first = openDatabase(file);
    migrate(first);
    insertTask(first, 'gt-restart');
    first.close();

    const reopened = openDatabase(file);
    migrate(reopened);
    const rows = reopened.prepare('SELECT id FROM migrations ORDER BY id').all();
    assert.deepEqual(
      rows.map((row) => Number(row.id)),
      MIGRATIONS.map((m) => m.id),
    );
    assert.ok(reopened.prepare("SELECT 1 AS ok FROM tasks WHERE task_id = 'gt-restart'").get());
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('迁移集 id 从 1 起连续（前缀校验的前提）', () => {
  MIGRATIONS.forEach((migration, i) => {
    assert.equal(migration.id, i + 1);
  });
});

test('降级打开（库中有本程序未知的迁移 id）抛 E_DB_MIGRATION', () => {
  const db = openMigratedMemoryDb();
  db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(99, T0);
  assert.throws(
    () => migrate(db),
    (err: unknown) => {
      assert.ok(err instanceof GovError);
      assert.equal(err.code, 'E_DB_MIGRATION');
      assert.ok(err.message.includes('迁移版本不一致'));
      return true;
    },
  );
});

test('迁移漂移（跳号导致已应用序列非前缀）抛 E_DB_MIGRATION', () => {
  const db = openMigratedMemoryDb();
  db.exec('DELETE FROM migrations');
  db.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(2, T0);
  assert.throws(
    () => migrate(db),
    (err: unknown) => {
      assert.ok(err instanceof GovError);
      assert.equal(err.code, 'E_DB_MIGRATION');
      return true;
    },
  );
});

test('文件库打开即 WAL + 外键强制', () => {
  const tmp = openMigratedTmpDb();
  const journal = tmp.db.prepare('PRAGMA journal_mode').get();
  const fk = tmp.db.prepare('PRAGMA foreign_keys').get();
  assert.equal(String(journal?.journal_mode), 'wal');
  assert.equal(Number(fk?.foreign_keys), 1);
  tmp.close();
});

test('withTransaction：成功提交、抛错整体回滚', () => {
  const db = openMigratedMemoryDb();
  withTransaction(db, (tx) => {
    insertTask(tx, 'gt-tx-ok');
  });
  assert.ok(db.prepare("SELECT 1 AS ok FROM tasks WHERE task_id = 'gt-tx-ok'").get());

  assert.throws(() =>
    withTransaction(db, (tx) => {
      insertTask(tx, 'gt-tx-bad');
      throw new Error('boom');
    }),
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE task_id = 'gt-tx-bad'").get()?.c,
    0,
  );
  // 回滚后连接可继续正常使用（无悬挂事务）。
  withTransaction(db, (tx) => {
    insertTask(tx, 'gt-tx-after');
  });
  assert.equal(db.prepare('SELECT COUNT(*) AS c FROM tasks').get()?.c, 2);
});
