import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from './database.ts';
import { GovError } from '../domain/errors.ts';

/**
 * 版本化迁移集：顺序数组，id 必须从 1 起连续递增。已应用的 id 序列必须是本
 * 数组的前缀，否则视为降级/漂移，抛 E_DB_MIGRATION（migrate 内校验）。
 * 迁移只增不改：修改既有迁移内容等同篡改历史，需新开 id。
 */
const MIGRATION_V1 = `
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY CHECK (task_id GLOB 'gt-*'),
  orca_task_id TEXT,
  spec_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'DECLARED','ACTIVE','WAITING_CHILD','REVIEW_REQUESTED','IN_REVIEW',
    'CHANGES_REQUESTED','APPROVED','MERGED','COMPLETED','FAILED','CANCELLED','SUPERSEDED'
  )),
  blocked_reason TEXT,
  current_claim_id TEXT REFERENCES claims(claim_id),
  parent_task_id TEXT REFERENCES tasks(task_id),
  target_json TEXT NOT NULL,
  reviewed_commit_id TEXT,
  merged_commit_id TEXT,
  declared_session TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE acceptance_criteria (
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  criterion_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('command','artifact','manual')),
  config_json TEXT NOT NULL,
  requires_manual INTEGER NOT NULL CHECK (requires_manual IN (0, 1)),
  PRIMARY KEY (task_id, criterion_id)
);

CREATE TABLE claims (
  claim_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(task_id),
  dispatch_id TEXT,
  claimer_session TEXT,
  terminal_handle TEXT,
  workspace_id TEXT REFERENCES workspaces(workspace_id),
  status TEXT NOT NULL CHECK (status IN (
    'PREPARING','DISPATCHED','ACTIVE','FENCED','RELEASED','UNCERTAIN'
  )),
  token_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 业务唯一约束：同一任务至多一行非终态认领（终态=FENCED/RELEASED）。
-- node:sqlite (SQLite >= 3.35) 支持部分索引 WHERE 语法，无需触发器回退。
CREATE UNIQUE INDEX uq_claims_live_per_task
  ON claims(task_id) WHERE status NOT IN ('RELEASED','FENCED');

CREATE TABLE workspaces (
  workspace_id TEXT PRIMARY KEY,
  jj_workspace_name TEXT,
  host_path TEXT,
  env_instance_id TEXT,
  env_status TEXT CHECK (env_status IN ('running','suspended','destroying','uncertain')),
  base_commit_id TEXT,
  cleanup_status TEXT
);

CREATE TABLE submissions (
  submission_id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL REFERENCES claims(claim_id),
  commit_id TEXT NOT NULL,
  tree_id TEXT,
  dev_evidence_manifest_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_submissions_claim_commit ON submissions(claim_id, commit_id);

CREATE TABLE reviews (
  review_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(submission_id),
  dispatch_id TEXT,
  reviewer_session TEXT,
  workspace_id TEXT REFERENCES workspaces(workspace_id),
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested','aborted')),
  report_ref TEXT,
  reviewed_commit_id TEXT,
  reviewed_tree_id TEXT,
  created_at TEXT NOT NULL
);

-- 业务唯一约束：一条提交至多一行未作废结论；verdict='aborted' 视为已作废
-- （评审中止可重试，多次 aborted 允许，但结论只有一行）。
CREATE UNIQUE INDEX uq_reviews_conclusive_per_submission
  ON reviews(submission_id) WHERE verdict <> 'aborted';

CREATE TABLE findings (
  finding_id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES reviews(review_id),
  submission_id TEXT NOT NULL REFERENCES submissions(submission_id),
  severity TEXT NOT NULL CHECK (severity IN ('critical','high','medium','low')),
  status TEXT NOT NULL CHECK (status IN ('OPEN','PARKED','RESOLVED')),
  note TEXT,
  parked_reason TEXT,
  resolved_in_submission_id TEXT REFERENCES submissions(submission_id)
);

CREATE TABLE evidence (
  evidence_id TEXT PRIMARY KEY,
  -- criterion_id 不设外键：acceptance_criteria 主键是 (task_id, criterion_id)，
  -- criterionId 只在任务内唯一，全局 FK 语义不成立，归属由服务层校验。
  criterion_id TEXT NOT NULL,
  submission_id TEXT REFERENCES submissions(submission_id),
  review_id TEXT REFERENCES reviews(review_id),
  commit_id TEXT,
  artifact_path TEXT,
  content_hash TEXT,
  exit_code INTEGER,
  produced_by TEXT,
  manual_decision_id TEXT,
  -- submissionId 与 reviewId 二选一非空（异或）。
  CHECK ((submission_id IS NOT NULL) <> (review_id IS NOT NULL))
);

CREATE TABLE merges (
  merge_id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL UNIQUE REFERENCES submissions(submission_id),
  target_bookmark TEXT,
  expected_target_commit TEXT,
  result_commit TEXT,
  confirmed_at TEXT
);

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'PREPARED','IN_FLIGHT','CONFIRMED','FAILED','UNCERTAIN'
  )),
  current_step TEXT,
  external_refs_json TEXT,
  receipt_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX uq_operations_request ON operations(request_id);

-- request_id 幂等键：同 id 重放必须携带相同 request_hash。同 hash 重复由唯一
-- 索引拒绝（调用方按幂等回执处理）；同 id 不同 hash 是契约漂移，触发器在
-- 唯一约束检查之前拦截并给出可区分的错误信息。
CREATE TRIGGER trg_operations_request_hash_insert_guard
BEFORE INSERT ON operations
WHEN EXISTS (
  SELECT 1 FROM operations WHERE request_id = NEW.request_id AND request_hash <> NEW.request_hash
)
BEGIN
  SELECT RAISE(ABORT, 'operations request_id 已存在且 request_hash 不一致');
END;

-- 状态推进只改 status/step 等列，request_hash 与 request_id 在生命周期内不可变。
CREATE TRIGGER trg_operations_request_hash_update_guard
BEFORE UPDATE OF request_id, request_hash ON operations
WHEN NEW.request_id <> OLD.request_id OR NEW.request_hash <> OLD.request_hash
BEGIN
  SELECT RAISE(ABORT, 'operations request_id/request_hash 不可变更');
END;

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT REFERENCES tasks(task_id),
  type TEXT NOT NULL,
  actor TEXT,
  payload_json TEXT,
  payload_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE capabilities (
  capability_id TEXT PRIMARY KEY,
  token_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('coordinator','executor','dev','reviewer','operator')),
  task_id TEXT REFERENCES tasks(task_id),
  claim_id TEXT REFERENCES claims(claim_id),
  review_id TEXT REFERENCES reviews(review_id),
  actions_json TEXT,
  expires_at TEXT,
  revoked_at TEXT
);
`;

export interface Migration {
  readonly id: number;
  readonly sql: string;
}

/**
 * T3.3 资源台账（设计 §8.6）：每任务每项待清资源一行，逐项幂等执行。
 * id 由 (taskId, kind, refId) 确定性派生（scheduleCleanup 内计算），同键重复
 * 登记被主键天然去重；status 只在 pending/done/failed 间推进，失败项带
 * lastError 可单独重试。expectedState 记录该项应到达的终态（销毁凭据口径）。
 */
const MIGRATION_V2 = `
CREATE TABLE cleanup_items (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('env','workspace','dispatch','terminal')),
  ref_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  expected_state TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending','done','failed')),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX ix_cleanup_items_task ON cleanup_items(task_id);
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: 1, sql: MIGRATION_V1 },
  { id: 2, sql: MIGRATION_V2 },
] as const;

function appliedIds(db: DatabaseSync): number[] {
  const rows = db.prepare('SELECT id FROM migrations ORDER BY id ASC').all();
  return rows.map((row) => Number(row.id));
}

/**
 * 应用迁移：重复打开幂等。已应用 id 序列必须是 MIGRATIONS 的严格前缀；
 * 出现未知 id（降级打开）或跳号/漂移均抛 E_DB_MIGRATION，不做任何降级写回。
 */
export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS migrations (id INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');

  const applied = appliedIds(db);
  const expected = MIGRATIONS.map((m) => m.id);
  const isPrefix =
    applied.length <= expected.length && applied.every((id, i) => id === expected[i]);
  if (!isPrefix) {
    throw new GovError(
      'E_DB_MIGRATION',
      `迁移版本不一致: 库中已应用 [${applied.join(',')}] 不是本程序迁移集 [${expected.join(',')}] 的前缀（疑似降级打开或迁移漂移）`,
    );
  }

  for (const migration of MIGRATIONS.slice(applied.length)) {
    withTransaction(db, (tx) => {
      tx.exec(migration.sql);
      tx.prepare('INSERT INTO migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      );
    });
  }
}
