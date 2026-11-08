/**
 * T5.1 guard-authorize 动作：镜像内受限启动器（/usr/local/lib/gov/guard）
 * 每次调用前的授权面。guard 把 {子命令, 参数摘要, 预置身份回执} 送来，gov
 * 按「令牌 ↔ 认领/评审绑定」裁决并返回解析出的终端与 Dispatch。
 *
 * 鉴权边界（设计 §9.2）：
 * - 仅 executor / reviewer 令牌可用（coordinator/operator 在动作集外即被
 *   authenticate 拒）；guard-authorize 本身不在角色动作集，属 guard 协议的
 *   引导型动作（同 token-issue 先例）。
 * - executor 令牌必须绑 claimId，且该 claim 是任务当前认领、状态
 *   DISPATCHED/ACTIVE；预置身份的 terminalHandle/dispatchId 必须与 claim 行
 *   逐字一致——不一致即身份漂移，拒绝。
 * - reviewer 令牌必须绑 reviewId；预置 dispatchId 必须与 review 行一致
 *   （评审表无终端列，terminalHandle 以 broker 0600 预置文件为准回执）。
 * - gov 动作必须落在角色动作集内；Orca 动词落在四个白名单内。
 * - 消息门：merge_ready 需本认领已有提交；worker_done 需任务已合并/已失败
 *   /评审已受理三通道之一，且 --outcome 与通道一致。
 *
 * 本模块禁止 import node:child_process：只查库与校验，不派生进程。
 */
import { z } from 'zod';
import type { DatabaseSync } from 'node:sqlite';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { GOV_ACTIONS_BY_ROLE } from '../domain/roles.ts';
import { GUARD_ORCA_VERBS, GUARD_SEND_TYPES_BY_ROLE, GUARD_WORKER_DONE_OUTCOMES } from './contract.ts';
import type { ActionHandler } from '../api.ts';

const guardAuthorizePayloadSchema = z.strictObject({
  /**
   * 任务归属声明：宿主 API 鉴权层要求任务绑定令牌在 payload.taskId 声明归属
   * （server.ts readClaimedTaskId）；值来自身份文件，handler 再与令牌绑定复核。
   */
  taskId: z.string().min(1).max(128),
  /** 'gov:<action>' 或 'orca:<verb>'。 */
  subcommand: z
    .string()
    .min(4)
    .max(64)
    .regex(/^(gov:[a-z][a-z-]{1,40}|orca:[a-z][a-z-]{2,20})$/, 'subcommand 必须是 gov:<action> 或 orca:<verb>'),
  /** guard 侧规范化参数串的 sha256（64 位小写十六进制）；gov 不复算（参数原文不经网络），只留档比对。 */
  argsDigest: z.string().regex(/^[0-9a-f]{64}$/),
  argCount: z.number().int().min(0).max(512).optional(),
  /** orca:send 时必填的消息类型。 */
  sendType: z.string().min(1).max(64).optional(),
  /** sendType=worker_done 时必填。 */
  outcome: z.enum(GUARD_WORKER_DONE_OUTCOMES).optional(),
  /** 预置身份回执（来自容器内 broker 0600 的 identity.json，非调用者可控）。 */
  identity: z.strictObject({
    terminalHandle: z.string().min(1).max(128),
    dispatchId: z.string().min(1).max(128),
  }),
});

export interface GuardAuthorizeResult {
  readonly allowed: true;
  readonly role: 'executor' | 'reviewer';
  readonly taskId: string;
  readonly claimId: string | null;
  readonly reviewId: string | null;
  readonly resolvedTerminal: string;
  readonly dispatchId: string;
}

interface ClaimRow {
  readonly claimId: string;
  readonly taskId: string;
  readonly status: string;
  readonly terminalHandle: string | null;
  readonly dispatchId: string | null;
}

function loadClaim(db: DatabaseSync, claimId: string, taskId: string): ClaimRow {
  const row = db
    .prepare(
      `SELECT claim_id, task_id, status, terminal_handle, dispatch_id
         FROM claims WHERE claim_id = ? AND task_id = ?`,
    )
    .get(claimId, taskId);
  if (row === undefined) {
    throw new GovError('E_FORBIDDEN_ACTION', `guard 令牌绑定的认领不存在或不属于任务 ${taskId}`);
  }
  return {
    claimId: String(row.claim_id),
    taskId: String(row.task_id),
    status: String(row.status),
    terminalHandle: row.terminal_handle === null ? null : String(row.terminal_handle),
    dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
  };
}

/** worker_done 三通道：合并确认 / fail 确认 / 评审受理。返回命中的通道名。 */
function workerDoneChannel(db: DatabaseSync, taskId: string): 'merged' | 'failed' | 'review-approved' | null {
  const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId);
  const status = task === undefined ? null : String((task as { status: unknown }).status);
  if (status === 'MERGED') {
    return 'merged';
  }
  if (status === 'FAILED') {
    return 'failed';
  }
  const mergeConfirmed = db
    .prepare(
      `SELECT 1 AS hit
         FROM merges m
         JOIN submissions s ON s.submission_id = m.submission_id
         JOIN claims c ON c.claim_id = s.claim_id
        WHERE c.task_id = ? AND m.confirmed_at IS NOT NULL
        LIMIT 1`,
    )
    .get(taskId);
  if (mergeConfirmed !== undefined) {
    return 'merged';
  }
  const reviewApproved = db
    .prepare(
      `SELECT 1 AS hit
         FROM reviews r
         JOIN submissions s ON s.submission_id = r.submission_id
         JOIN claims c ON c.claim_id = s.claim_id
        WHERE c.task_id = ? AND r.verdict = 'approved'
        LIMIT 1`,
    )
    .get(taskId);
  if (reviewApproved !== undefined) {
    return 'review-approved';
  }
  return null;
}

export function createGuardAuthorizeHandler(): ActionHandler {
  return async (ctx) => {
    const parsed = guardAuthorizePayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `guard-authorize 载荷校验失败: ${formatZodIssues(parsed.error)}`);
    }
    const input = parsed.data;

    // 1) 角色面：guard 令牌只可能是 executor / reviewer（coordinator/operator
    //    的动作集不含 guard-authorize，本就进不了这里；此处再拦一次防御演进）。
    const role = ctx.token.role;
    if (role !== 'executor' && role !== 'reviewer') {
      throw new GovError('E_FORBIDDEN_ACTION', `guard-authorize 仅 executor/reviewer 令牌可用: ${role}`);
    }
    const taskId = ctx.token.taskId;
    if (taskId === null) {
      throw new GovError('E_FORBIDDEN_ACTION', 'guard 令牌必须绑定 taskId');
    }
    if (input.taskId !== taskId) {
      throw new GovError('E_FORBIDDEN_ACTION', `guard 载荷任务归属与令牌绑定不符: ${input.taskId}`);
    }

    // 2) 绑定面与预置身份核对。
    let resolvedTerminal: string;
    let dispatchId: string;
    if (role === 'executor') {
      const claimId = ctx.token.claimId;
      if (claimId === null) {
        throw new GovError('E_FORBIDDEN_ACTION', 'executor guard 令牌必须绑定 claimId');
      }
      const claim = loadClaim(ctx.db, claimId, taskId);
      if (claim.status !== 'DISPATCHED' && claim.status !== 'ACTIVE') {
        throw new GovError(
          'E_CLAIM_STATE_INVALID',
          `认领状态 ${claim.status} 不允许 guard 动作（须 DISPATCHED/ACTIVE）`,
        );
      }
      const current = ctx.db
        .prepare('SELECT current_claim_id FROM tasks WHERE task_id = ?')
        .get(taskId) as { current_claim_id: unknown } | undefined;
      if (current === undefined || String(current.current_claim_id) !== claimId) {
        throw new GovError('E_FORBIDDEN_ACTION', `认领 ${claimId} 不是任务 ${taskId} 的当前认领`);
      }
      if (claim.terminalHandle === null || claim.dispatchId === null) {
        throw new GovError('E_CLAIM_STATE_INVALID', '认领缺少 terminal/dispatch 回执，guard 不能代理');
      }
      if (input.identity.terminalHandle !== claim.terminalHandle || input.identity.dispatchId !== claim.dispatchId) {
        throw new GovError(
          'E_FORBIDDEN_ACTION',
          `预置身份与认领回执不一致（terminal/dispatch 漂移），拒绝: claim=${claim.claimId}`,
        );
      }
      resolvedTerminal = claim.terminalHandle;
      dispatchId = claim.dispatchId;
    } else {
      const reviewId = ctx.token.reviewId;
      if (reviewId === null) {
        throw new GovError('E_FORBIDDEN_ACTION', 'reviewer guard 令牌必须绑定 reviewId');
      }
      const row = ctx.db
        .prepare(
          `SELECT r.dispatch_id AS dispatch_id, c.task_id AS task_id
             FROM reviews r
             JOIN submissions s ON s.submission_id = r.submission_id
             JOIN claims c ON c.claim_id = s.claim_id
            WHERE r.review_id = ?`,
        )
        .get(reviewId) as { dispatch_id: unknown; task_id: unknown } | undefined;
      if (row === undefined || String(row.task_id) !== taskId) {
        throw new GovError('E_FORBIDDEN_ACTION', `guard 令牌绑定的评审不存在或不属于任务 ${taskId}`);
      }
      if (row.dispatch_id === null || input.identity.dispatchId !== String(row.dispatch_id)) {
        throw new GovError(
          'E_FORBIDDEN_ACTION',
          `预置 dispatchId 与评审回执不一致（漂移），拒绝: review=${reviewId}`,
        );
      }
      // 评审表无终端列：terminalHandle 以 broker 0600 预置文件为权威（gov 无法
      // 复核），回执原值。
      resolvedTerminal = input.identity.terminalHandle;
      dispatchId = String(row.dispatch_id);
    }

    // 3) 子命令面。
    const [kind, name] = input.subcommand.split(':', 2) as [string, string | undefined];
    if (kind === 'gov') {
      if (name === undefined || !(GOV_ACTIONS_BY_ROLE[role] as readonly string[]).includes(name)) {
        throw new GovError('E_FORBIDDEN_ACTION', `gov 动作不在 ${role} 角色授权内: ${String(name)}`);
      }
    } else if (kind === 'orca') {
      if (name === undefined || !(GUARD_ORCA_VERBS as readonly string[]).includes(name)) {
        throw new GovError('E_FORBIDDEN_ACTION', `orca 动词不在 guard 白名单内: ${String(name)}`);
      }
      if (name === 'send') {
        if (input.sendType === undefined) {
          throw new GovError('E_REQUEST_INVALID', 'orca:send 必须携带 sendType');
        }
        if (!(GUARD_SEND_TYPES_BY_ROLE[role] as readonly string[]).includes(input.sendType)) {
          throw new GovError('E_FORBIDDEN_ACTION', `消息类型不在 ${role} 角色授权内: ${input.sendType}`);
        }
        if (input.sendType === 'merge_ready') {
          const hasSubmission = ctx.db
            .prepare('SELECT 1 AS hit FROM submissions WHERE claim_id = ? LIMIT 1')
            .get(ctx.token.claimId ?? '');
          if (hasSubmission === undefined) {
            throw new GovError('E_FORBIDDEN_ACTION', 'merge_ready 需本认领已有提交（submissions 缺席）');
          }
        }
        if (input.sendType === 'worker_done') {
          if (input.outcome === undefined) {
            throw new GovError('E_REQUEST_INVALID', 'worker_done 必须携带 outcome');
          }
          const channel = workerDoneChannel(ctx.db, taskId);
          if (channel === null) {
            throw new GovError(
              'E_FORBIDDEN_ACTION',
              'worker_done 需任务已合并/已失败/评审已受理之一（当前均未满足，禁止提前结算）',
            );
          }
          if (channel === 'failed' ? input.outcome !== 'failed' : input.outcome !== 'succeeded') {
            throw new GovError(
              'E_FORBIDDEN_ACTION',
              `worker_done 的 outcome 与结算通道不一致: channel=${channel} outcome=${input.outcome}`,
            );
          }
        }
      }
    } else {
      throw new GovError('E_REQUEST_INVALID', `未知子命令类别: ${input.subcommand}`);
    }

    const result: GuardAuthorizeResult = {
      allowed: true,
      role,
      taskId,
      claimId: ctx.token.claimId,
      reviewId: ctx.token.reviewId,
      resolvedTerminal,
      dispatchId,
    };
    return result;
  };
}
