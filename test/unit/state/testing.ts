import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import type { TaskStatus } from '../../../src/state/task-machine.ts';
import type { ClaimStatus } from '../../../src/state/claim-machine.ts';

export const T0 = '2026-11-07T00:00:00.000Z';

/** 内存库：迁移后直接可用，适合约束与状态机单测。 */
export function openMigratedMemoryDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export interface TmpDb {
  readonly db: DatabaseSync;
  /** 库文件绝对路径（重开/多连接测试用）。 */
  readonly file: string;
  /** 关闭连接并删除临时目录（含 -wal/-shm）。 */
  close(): void;
}

/** 临时文件库：适合重启/跨连接（WAL、写锁）测试。 */
export function openMigratedTmpDb(): TmpDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-db-test-'));
  const file = path.join(dir, 'gov.db');
  const db = openDatabase(file);
  migrate(db);
  return {
    db,
    file,
    close() {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function insertTask(db: DatabaseSync, taskId: string, status: TaskStatus = 'DECLARED'): void {
  db.prepare(
    `INSERT INTO tasks (task_id, spec_hash, status, target_json, declared_session, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    taskId,
    `sha256:${taskId}`,
    status,
    JSON.stringify({ kind: 'top-level', bookmark: 'main' }),
    'session-opener',
    T0,
    T0,
  );
}

export function insertClaim(
  db: DatabaseSync,
  claimId: string,
  taskId: string,
  status: ClaimStatus = 'PREPARING',
): void {
  db.prepare(
    `INSERT INTO claims (claim_id, task_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(claimId, taskId, status, T0, T0);
}

export function insertSubmission(
  db: DatabaseSync,
  submissionId: string,
  claimId: string,
  commitId: string,
): void {
  db.prepare(
    `INSERT INTO submissions (submission_id, claim_id, commit_id, created_at) VALUES (?, ?, ?, ?)`,
  ).run(submissionId, claimId, commitId, T0);
}

export function insertReview(
  db: DatabaseSync,
  reviewId: string,
  submissionId: string,
  verdict: 'approved' | 'changes_requested' | 'aborted',
): void {
  db.prepare(
    `INSERT INTO reviews (review_id, submission_id, verdict, created_at) VALUES (?, ?, ?, ?)`,
  ).run(reviewId, submissionId, verdict, T0);
}

/** 断言写语句抛错且 message 含 keyword（SQLite 约束错误/触发器文本）。 */
export function assertWriteRejects(
  db: DatabaseSync,
  sql: string,
  params: readonly SQLInputValue[],
  keyword: string,
  message?: string,
): void {
  let threw: unknown;
  try {
    db.prepare(sql).run(...params);
  } catch (err) {
    threw = err;
  }
  if (threw === undefined) {
    assert.fail(message ?? `预期写入被拒但成功了: ${sql}`);
  }
  const text = threw instanceof Error ? threw.message : String(threw);
  if (!text.includes(keyword)) {
    assert.fail(`错误 message 不含 "${keyword}": ${text}`);
  }
}
