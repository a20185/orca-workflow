import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../db/database.ts';
import { GovError } from '../domain/errors.ts';

/** 设计 §7 任务状态全集。 */
export const TASK_STATUSES = [
  'DECLARED',
  'ACTIVE',
  'WAITING_CHILD',
  'REVIEW_REQUESTED',
  'IN_REVIEW',
  'CHANGES_REQUESTED',
  'APPROVED',
  'MERGED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'SUPERSEDED',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

/** 终态：无出边，任何事件都非法。 */
export const TASK_TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'] as const;

export type TaskTerminalStatus = (typeof TASK_TERMINAL_STATUSES)[number];

export const TASK_EVENTS = [
  'accept',
  'cancel',
  'supersede',
  'submit',
  'fail',
  'split',
  'child_merged',
  'child_terminated',
  'child_superseded',
  'review_request',
  'review_accept',
  'target_moved',
  'executor_replaced',
  'reject',
  'review_aborted',
  'approve',
  'merge_confirmed',
  'complete',
] as const;

export type TaskEvent = (typeof TASK_EVENTS)[number];

/**
 * 设计 §7 唯一合法迁移集（31 条边），以数据定义为本层真源。事件→目标态之外
 * 的资源动作（认领翻转、合并执行等）属上层服务；状态机只管 status 翻转与
 * events 表记录。
 */
export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, Partial<Record<TaskEvent, TaskStatus>>>> = {
  DECLARED: {
    accept: 'ACTIVE',
    cancel: 'CANCELLED',
    supersede: 'SUPERSEDED',
  },
  ACTIVE: {
    submit: 'REVIEW_REQUESTED',
    fail: 'FAILED',
    split: 'WAITING_CHILD',
    cancel: 'CANCELLED',
    supersede: 'SUPERSEDED',
  },
  WAITING_CHILD: {
    child_merged: 'ACTIVE',
    child_terminated: 'ACTIVE',
    child_superseded: 'WAITING_CHILD',
  },
  CHANGES_REQUESTED: {
    submit: 'REVIEW_REQUESTED',
    review_request: 'REVIEW_REQUESTED',
    fail: 'FAILED',
    split: 'WAITING_CHILD',
    cancel: 'CANCELLED',
    supersede: 'SUPERSEDED',
  },
  REVIEW_REQUESTED: {
    review_accept: 'IN_REVIEW',
    target_moved: 'ACTIVE',
    executor_replaced: 'ACTIVE',
    fail: 'FAILED',
    cancel: 'CANCELLED',
    supersede: 'SUPERSEDED',
  },
  IN_REVIEW: {
    reject: 'CHANGES_REQUESTED',
    review_aborted: 'REVIEW_REQUESTED',
    cancel: 'CANCELLED',
    supersede: 'SUPERSEDED',
    approve: 'APPROVED',
  },
  APPROVED: {
    merge_confirmed: 'MERGED',
    target_moved: 'CHANGES_REQUESTED',
  },
  MERGED: {
    complete: 'COMPLETED',
  },
  COMPLETED: {},
  FAILED: {},
  CANCELLED: {},
  SUPERSEDED: {},
};

export interface TaskTransitionEdge {
  readonly from: TaskStatus;
  readonly event: TaskEvent;
  readonly to: TaskStatus;
}

/** 展平的 31 条边，供逐边断言与上层遍历使用。 */
export const TASK_TRANSITION_EDGES: readonly TaskTransitionEdge[] = Object.entries(
  TASK_TRANSITIONS,
).flatMap(([from, byEvent]) =>
  Object.entries(byEvent).map(([event, to]) => ({
    from: from as TaskStatus,
    event: event as TaskEvent,
    to: to as TaskStatus,
  })),
);

export interface TaskTransitionMeta {
  /** 触发者（角色/会话标识），仅随事件记录，不参与校验。 */
  readonly actor?: string;
  /** 附加载荷，JSON 序列化后连同其 sha256 一并落 events 行。 */
  readonly payload?: unknown;
}

export interface TaskTransitionResult {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly eventSeq: number;
}

/**
 * 校验并执行一次任务状态迁移：合法则原子地翻转 tasks.status 并在 events 表
 * 记录一条该事件（payload 带 hash）；非法组合（未知事件、任务不存在、无该
 * 出边）抛 E_TRANSITION_INVALID。
 */
export function applyTaskTransition(
  db: DatabaseSync,
  taskId: string,
  event: TaskEvent,
  meta: TaskTransitionMeta = {},
): TaskTransitionResult {
  if (!(TASK_EVENTS as readonly string[]).includes(event)) {
    throw new GovError('E_TRANSITION_INVALID', `未知任务事件: ${event}`);
  }

  const row = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
  if (row === undefined) {
    throw new GovError('E_TRANSITION_INVALID', `任务不存在: ${taskId}`);
  }
  const from = row.status as TaskStatus;
  const to = TASK_TRANSITIONS[from][event];
  if (to === undefined) {
    throw new GovError('E_TRANSITION_INVALID', `非法任务迁移: ${from} --${event}--> (任务 ${taskId})`);
  }

  const now = new Date().toISOString();
  const payloadJson = meta.payload === undefined ? null : JSON.stringify(meta.payload);
  const payloadHash =
    payloadJson === null
      ? null
      : createHash('sha256').update(payloadJson, 'utf8').digest('hex');

  return withTransaction(db, (tx) => {
    tx.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE task_id = ?').run(to, now, taskId);
    const inserted = tx
      .prepare(
        'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(taskId, event, meta.actor ?? null, payloadJson, payloadHash, now);
    return { from, to, eventSeq: Number(inserted.lastInsertRowid) };
  });
}
