import { DatabaseSync } from 'node:sqlite';

/**
 * 打开 gov 数据库并立刻进入约定形态：WAL + 外键强制。单写入者纪律由上层
 * 保证，本层只保证每个连接自身的事务边界（见 withTransaction）。
 *
 * 库文件路径由调用方传入；测试用 `:memory:` 或临时文件。
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  return db;
}

/**
 * 单事务边界：BEGIN IMMEDIATE 立即取写锁（避免死锁窗口），fn 成功则 COMMIT，
 * 任何抛错则 ROLLBACK 后原样重抛。不支持嵌套（SQLite 本身不允许事务内再开
 * 事务）；调用方若已在外层事务中请直接执行语句，不要再包一层。
 */
export function withTransaction<T>(db: DatabaseSync, fn: (db: DatabaseSync) => T): T {
  db.exec('BEGIN IMMEDIATE');
  let result: T;
  try {
    result = fn(db);
    db.exec('COMMIT');
  } catch (err) {
    // COMMIT 自身失败（如延迟外键违约）时事务可能仍处于打开状态，回滚是
    // 清理动作，失败不应吞掉原始错误。
    try {
      db.exec('ROLLBACK');
    } catch {
      // 保留原始错误
    }
    throw err;
  }
  return result;
}
