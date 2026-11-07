/**
 * 认领与接受服务（T3.1 claim/accept，设计 §8.1）。
 *
 * claim 严格顺序：保留认领（claims 行 PREPARING，部分唯一索引挡并发）→ jj
 * workspace → 一次性环境 → 宿主信任预置 → worker 启动（同任务尝试上限 3）→
 * DISPATCHED + executor 令牌。每步经 StepLedger 落 operations 回执（确定性
 * 幂等键 claim:<claimId>:<stage>），外部结果不确定（超时/进程被杀）置认领
 * UNCERTAIN 并阻断第二认领，确定失败则删认领行、清理资源、可重认领。
 *
 * 适配记录（相对简报字面）：claims 表无 blocked_reason/重试计数控列（T1.2
 * 迁移已冻结、不归本任务改动）——blockedReason 落 tasks.blocked_reason，
 * worker 启动尝试计数以 events 行（claim_worker_start）为真源。
 *
 * 本模块与 services/ 全目录禁止 import node:child_process：一切外部动作经
 * 注入端口（ports.ts），单测以假适配器逐段中断。
 */
import { createHash, randomBytes } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import type { TaskSpec } from '../domain/task-spec.ts';
import { applyClaimTransition, type ClaimStatus } from '../state/claim-machine.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import { withTransaction } from '../db/database.ts';
import { beginOperation, canonicalRequestHash, finalizeOperation } from '../operations.ts';
import { issueToken } from '../auth.ts';
import type { WorkerStartReceipt } from '../adapters/orca.ts';
import {
  isTrustGateFailure,
  isUncertainOutcome,
  isWorkerStartReady,
  type EnvPort,
  type JjPort,
  type OrcaPort,
  type TrustProvision,
} from './ports.ts';
import {
  createDefaultTrustProvision,
  prepareWorkspace,
  type PreparedWorkspace,
  type StepLedger,
} from './workspaces.ts';
import { loadDeclaredSpec } from './tasks.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

/** 同任务 worker 启动尝试上限（T2.1 实测口径）。 */
export const WORKER_START_RETRY_LIMIT = 3;

export const TRUST_GATE_BLOCKED_REASON = 'trust_gate';
export const RETRY_EXHAUSTED_BLOCKED_REASON = 'retry_exhausted';
export const WRITABLE_SWITCH_BLOCKED_REASON = 'writable_switch_failed';

/** 认领生命周期审计事件（事件表无外键约束的自由 type；也是尝试计数的真源）。 */
export const CLAIM_EVENT_TYPES = {
  workerStartAttempt: 'claim_worker_start',
  released: 'claim_released',
  uncertain: 'claim_uncertain',
} as const;

const CLAIM_ID_PREFIX = 'gcl_';

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// 步骤回执账本
// ---------------------------------------------------------------------------

/**
 * 把认领的每个外部步骤写进 operations 表：requestId = claim:<claimId>:<stage>
 * （accept 阶段带尝试序号），requestHash 由步骤引用计算——确定性幂等键使
 * 人工经 operation-resume 处置时有逐段可查的回执。
 */
export function createStepLedger(db: DatabaseSync, claimId: string): StepLedger {
  const begin = (stage: string, refs: Record<string, unknown>): string => {
    const requestId = `claim:${claimId}:${stage}`;
    const requestHash = canonicalRequestHash(requestId, 'claim', refs);
    const result = beginOperation(db, { requestId, requestHash, kind: 'claim' });
    if (result.type !== 'start') {
      throw new GovError('E_REQUEST_INVALID', `步骤账本 ${requestId} 非新开(${result.type})`);
    }
    db.prepare('UPDATE operations SET current_step = ? WHERE operation_id = ?').run(stage, result.operationId);
    return result.operationId;
  };
  const confirm = (operationId: string, stage: string, refs: Record<string, unknown>): void => {
    finalizeOperation(db, operationId, 'CONFIRMED', {
      httpStatus: 200,
      body: { ok: true, stage, refs },
    });
  };
  const fail = (operationId: string, stage: string, code: string, message: string): void => {
    finalizeOperation(
      db,
      operationId,
      'FAILED',
      { httpStatus: 400, body: { ok: false, error: { code, message } } },
      code,
    );
  };
  const uncertain = (operationId: string, stage: string, message: string): void => {
    finalizeOperation(
      db,
      operationId,
      'UNCERTAIN',
      { httpStatus: 504, body: { ok: false, error: { code: 'E_CLAIM_UNCERTAIN', message } } },
      'E_CLAIM_UNCERTAIN',
    );
  };
  return { begin, confirm, fail, uncertain };
}

function recordTaskEvent(
  db: DatabaseSync,
  taskId: string,
  type: string,
  actor: string,
  payload: unknown,
): void {
  const json = JSON.stringify(payload);
  db.prepare(
    'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(taskId, type, actor, json, sha256Hex(json), new Date().toISOString());
}

/** 同任务 worker 启动尝试数（含确定失败、信任门与不确定结局——每次调用都是一次尝试）。 */
function countWorkerStartAttempts(db: DatabaseSync, taskId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = ?')
    .get(taskId, CLAIM_EVENT_TYPES.workerStartAttempt);
  return Number(row?.c ?? 0);
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

export interface ClaimInput {
  readonly taskId: string;
  /** 信任门恢复后的重派：上一失败的 Orca dispatchId。 */
  readonly retryOf?: string | undefined;
}

export interface ClaimResult {
  readonly claimId: string;
  readonly taskId: string;
  readonly status: 'DISPATCHED';
  readonly dispatchId: string;
  readonly terminalHandle: string | null;
  readonly workspace: {
    readonly workspaceId: string;
    readonly hostPath: string;
    readonly taskDirRel: string;
  };
  /** executor 明文令牌，仅此一次返回（库中只落 sha256；回执经 deepMaskGovTokens 遮蔽）。 */
  readonly executorToken: string;
  readonly executorCapabilityId: string;
  readonly executorTokenExpiresAt: string | null;
}

export interface AcceptInput {
  readonly taskId: string;
  readonly claimId: string;
  /** 令牌绑定的认领（executor 令牌签发时绑定 claimId）；必须与 claimId 一致。 */
  readonly tokenClaimId: string | null;
  readonly session: string;
}

export interface AcceptResult {
  readonly taskId: string;
  readonly claimId: string;
  readonly status: 'ACTIVE';
  readonly taskStatus: string;
  readonly workspace: {
    readonly hostPath: string;
    readonly taskDirRel: string;
    /** 只写 ownedPaths 的提示（声明任务书的持久真源）。 */
    readonly ownedPaths: readonly string[];
  };
}

export interface ClaimView {
  readonly claimId: string;
  readonly taskId: string;
  readonly status: ClaimStatus;
  readonly dispatchId: string | null;
  readonly claimerSession: string | null;
  readonly terminalHandle: string | null;
  readonly workspaceId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ClaimServiceDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: OrcaPort;
  readonly jj: JjPort;
  readonly env: EnvPort;
  readonly trustProvision?: TrustProvision | undefined;
  /**
   * 单个外部步骤的 in-process 超时上限。默认 25s，必须小于宿主 30s 处理上限：
   * 保证「判超时 → 置认领/账本 UNCERTAIN」发生在进程内，而不是被宿主信封
   * 超时抢先杀死后只留下 PREPARING 认领行。
   */
  readonly stepTimeoutMs?: number | undefined;
}

export interface ClaimService {
  claim(coordinatorSession: string, input: ClaimInput): Promise<ClaimResult>;
  accept(input: AcceptInput): Promise<AcceptResult>;
  /** 历史认领查询（含 RELEASED/UNCERTAIN 终态与活动态）；纯库读，同步返回。 */
  listClaims(taskId: string): ClaimView[];
}

function withStepTimeout<T>(promise: Promise<T>, ms: number, stage: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new GovError('E_TIMEOUT', `外部步骤超时(${stage}, ${ms}ms)`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createClaimService(deps: ClaimServiceDeps): ClaimService {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;
  const trustProvision = deps.trustProvision ?? createDefaultTrustProvision();

  /** 确定失败的认领收尾：清理已建资源 → 记 claim_released 事件 → 删认领行。 */
  async function releaseClaim(
    claimId: string,
    taskId: string,
    session: string,
    stage: string,
    prepared: PreparedWorkspace | undefined,
  ): Promise<void> {
    const rollbackErrors: string[] = [];
    if (prepared !== undefined) {
      await prepared.cleanup(rollbackErrors);
    }
    recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.released, session, { claimId, stage, rollbackErrors });
    // 认领从未 DISPATCHED，current_claim_id 不应指向它；防御性清一次再删行。
    db.prepare('UPDATE tasks SET current_claim_id = NULL WHERE current_claim_id = ?').run(claimId);
    db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId);
  }

  /** 外部结果不确定：认领置 UNCERTAIN（DISPATCHED/PREPARING 均有合法出边），可带 blockedReason。 */
  function markClaimUncertain(
    claimId: string,
    taskId: string,
    session: string,
    stage: string,
    blockedReason?: string,
  ): void {
    const now = new Date().toISOString();
    withTransaction(db, (tx) => {
      applyClaimTransition(tx, claimId, 'UNCERTAIN');
      tx.prepare('UPDATE claims SET updated_at = ? WHERE claim_id = ?').run(now, claimId);
      if (blockedReason !== undefined) {
        tx.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
          blockedReason,
          now,
          taskId,
        );
      }
    });
    recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.uncertain, session, { claimId, stage, blockedReason: blockedReason ?? null });
  }

  function recordWorkerStartAttempt(
    taskId: string,
    session: string,
    payload: {
      readonly claimId: string;
      readonly attempt: number;
      readonly dispatchId: string | null;
      readonly state: string;
      readonly failedStage: string | null;
      readonly retryOf: string | null;
      readonly errorCode?: string;
    },
  ): void {
    recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.workerStartAttempt, session, payload);
  }

  async function claim(coordinatorSession: string, input: ClaimInput): Promise<ClaimResult> {
    const task = db
      .prepare('SELECT task_id, status, orca_task_id, blocked_reason FROM tasks WHERE task_id = ?')
      .get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    if (String(task.status) !== 'DECLARED') {
      throw new GovError('E_CLAIM_STATE_INVALID', `任务状态 ${String(task.status)} 不可认领(须 DECLARED): ${input.taskId}`);
    }
    if (task.orca_task_id === null) {
      throw new GovError('E_CLAIM_STATE_INVALID', `任务尚未完成 Orca 登记(先重试 declare): ${input.taskId}`);
    }
    const attemptsBefore = countWorkerStartAttempts(db, input.taskId);
    if (attemptsBefore >= WORKER_START_RETRY_LIMIT) {
      throw new GovError(
        'E_CLAIM_RETRY_EXHAUSTED',
        `同任务 worker 启动尝试已达上限 ${WORKER_START_RETRY_LIMIT}，转人工: ${input.taskId}`,
      );
    }
    if (String(task.blocked_reason ?? '') === TRUST_GATE_BLOCKED_REASON && input.retryOf === undefined) {
      throw new GovError(
        'E_CLAIM_STATE_INVALID',
        `信任门首死待人工处置: ${input.taskId} 需在 UI 信任工作区后携带 retryOf 重派`,
      );
    }
    const live = db
      .prepare("SELECT claim_id, status FROM claims WHERE task_id = ? AND status NOT IN ('RELEASED','FENCED')")
      .get(input.taskId);
    if (live !== undefined) {
      throw new GovError(
        'E_CLAIM_EXISTS',
        `任务已有未终结认领: ${String(live.claim_id)}(${String(live.status)})`,
      );
    }

    // 任务书从声明事件恢复（tasks 表无 spec 载荷列，见文件头适配记录）。
    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    if (repo === undefined) {
      throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在配置中: ${spec.repoId}`);
    }

    const claimId = CLAIM_ID_PREFIX + randomBytes(12).toString('base64url');
    const now = new Date().toISOString();
    try {
      withTransaction(db, (tx) => {
        tx.prepare(
          'INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        ).run(claimId, input.taskId, 'PREPARING', now, now);
      });
    } catch (err) {
      // 并发第二认领：T1.2 部分唯一索引是最终裁决（先查后插只是友好路径）。
      if (errorMessage(err).includes('UNIQUE')) {
        throw new GovError('E_CLAIM_EXISTS', `并发认领被唯一约束拒绝: ${input.taskId}`);
      }
      throw err;
    }

    const ledger = createStepLedger(db, claimId);

    // —— 第 2–4 步：workspace → env → trust（确定失败在内部回滚并抛阶段错误）——
    let prepared: PreparedWorkspace | undefined;
    try {
      prepared = await prepareWorkspace(
        { db, jj: deps.jj, env: deps.env, config: deps.config, trustProvision, ledger },
        { claimId, spec, repoHostPath: repo.hostPath },
      );
    } catch (err) {
      if (err instanceof GovError && err.code === 'E_CLAIM_UNCERTAIN') {
        // 准备资源不清理（外部可能仍在建），认领 UNCERTAIN 阻断第二认领。
        markClaimUncertain(claimId, input.taskId, coordinatorSession, 'prepare');
        throw err;
      }
      await releaseClaim(claimId, input.taskId, coordinatorSession, 'prepare', undefined);
      throw err;
    }

    // —— 第 5 步：worker 启动（同任务尝试计数；信任门首死不盲重试）——
    const attempt = attemptsBefore + 1;
    const wsOp = ledger.begin('worker-start', {
      task: String(task.orca_task_id),
      worktree: `path:${prepared.hostPath}`,
      retryOf: input.retryOf ?? null,
      attempt,
    });
    let receipt: WorkerStartReceipt;
    try {
      const started = await withStepTimeout(
        deps.orca.workerStart({
          task: String(task.orca_task_id),
          worktree: `path:${prepared.hostPath}`,
          agent: spec.agentPolicy.executor,
          ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
        }),
        stepTimeoutMs,
        'worker_start',
      );
      receipt = started.raw;
    } catch (err) {
      const code = err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED';
      const message = errorMessage(err);
      recordWorkerStartAttempt(input.taskId, coordinatorSession, {
        claimId,
        attempt,
        dispatchId: null,
        state: 'error',
        failedStage: null,
        retryOf: input.retryOf ?? null,
        errorCode: code,
      });
      if (isUncertainOutcome(err)) {
        ledger.uncertain(wsOp, 'worker_start', message);
        markClaimUncertain(claimId, input.taskId, coordinatorSession, 'worker_start');
        throw new GovError('E_CLAIM_UNCERTAIN', `worker 启动结果不确定: ${message}`);
      }
      ledger.fail(wsOp, 'worker_start', code, message);
      await releaseClaim(claimId, input.taskId, coordinatorSession, 'worker_start', prepared);
      throw new GovError('E_CLAIM_PREP_FAILED', `worker 启动失败(阶段 worker_start, 已回滚): ${message}`);
    }
    recordWorkerStartAttempt(input.taskId, coordinatorSession, {
      claimId,
      attempt,
      dispatchId: receipt.dispatchId,
      state: receipt.state,
      failedStage: receipt.failedStage ?? null,
      retryOf: input.retryOf ?? null,
    });
    if (!isWorkerStartReady(receipt)) {
      const stageNote = `state=${receipt.state}${receipt.failedStage !== undefined ? ` failedStage=${receipt.failedStage}` : ''}`;
      if (isTrustGateFailure(receipt)) {
        ledger.fail(wsOp, 'worker_start', 'E_CLAIM_PREP_FAILED', `信任门首死(${stageNote})`);
        db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
          TRUST_GATE_BLOCKED_REASON,
          new Date().toISOString(),
          input.taskId,
        );
        await releaseClaim(claimId, input.taskId, coordinatorSession, 'trust_gate', prepared);
        throw new GovError(
          'E_CLAIM_PREP_FAILED',
          `worker 启动信任门首死(${stageNote}): 需人工在 UI 信任工作区后以 retryOf 重派`,
        );
      }
      ledger.fail(wsOp, 'worker_start', 'E_CLAIM_PREP_FAILED', `worker 启动失败(${stageNote})`);
      const attemptsAfter = countWorkerStartAttempts(db, input.taskId);
      if (attemptsAfter >= WORKER_START_RETRY_LIMIT) {
        db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
          RETRY_EXHAUSTED_BLOCKED_REASON,
          new Date().toISOString(),
          input.taskId,
        );
        await releaseClaim(claimId, input.taskId, coordinatorSession, 'retry_exhausted', prepared);
        throw new GovError(
          'E_CLAIM_RETRY_EXHAUSTED',
          `worker 启动 ${attemptsAfter} 次均失败(上限 ${WORKER_START_RETRY_LIMIT})，转人工: ${input.taskId}`,
        );
      }
      await releaseClaim(claimId, input.taskId, coordinatorSession, 'worker_start', prepared);
      throw new GovError('E_CLAIM_PREP_FAILED', `worker 启动失败(${stageNote}, 已回滚，可重认领)`);
    }
    ledger.confirm(wsOp, 'worker-start', {
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      state: receipt.state,
    });

    // —— 第 6 步：DISPATCHED + executor 令牌（原子提交）——
    const dispatchedAt = new Date().toISOString();
    const issued = withTransaction(db, (tx) => {
      applyClaimTransition(tx, claimId, 'DISPATCHED');
      const token = issueToken(tx, {
        role: 'executor',
        taskId: input.taskId,
        claimId,
        ttlSeconds: spec.budget.maxWallSeconds,
      });
      tx.prepare(
        'UPDATE claims SET dispatch_id = ?, terminal_handle = ?, claimer_session = ?, token_hash = ?, workspace_id = ?, updated_at = ? WHERE claim_id = ?',
      ).run(
        receipt.dispatchId,
        receipt.terminalHandle ?? null,
        coordinatorSession,
        sha256Hex(token.token),
        prepared.workspaceId,
        dispatchedAt,
        claimId,
      );
      tx.prepare('UPDATE tasks SET current_claim_id = ?, blocked_reason = NULL, updated_at = ? WHERE task_id = ?').run(
        claimId,
        dispatchedAt,
        input.taskId,
      );
      return token;
    });

    return {
      claimId,
      taskId: input.taskId,
      status: 'DISPATCHED',
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      workspace: {
        workspaceId: prepared.workspaceId,
        hostPath: prepared.hostPath,
        taskDirRel: prepared.taskDirRel,
      },
      executorToken: issued.token,
      executorCapabilityId: issued.capabilityId,
      executorTokenExpiresAt: issued.expiresAt,
    };
  }

  function countPriorAcceptSteps(claimId: string): number {
    const prefix = `claim:${claimId}:accept-writable:`;
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM operations WHERE substr(request_id, 1, ?) = ?')
      .get(prefix.length, prefix);
    return Number(row?.c ?? 0);
  }

  async function accept(input: AcceptInput): Promise<AcceptResult> {
    if (input.tokenClaimId === null || input.tokenClaimId !== input.claimId) {
      throw new GovError(
        'E_CLAIM_STATE_INVALID',
        `令牌未绑定该认领(令牌绑定 ${input.tokenClaimId ?? '无'}, 请求 ${input.claimId})`,
      );
    }
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    if (String(task.status) !== 'DECLARED') {
      throw new GovError('E_CLAIM_STATE_INVALID', `任务状态 ${String(task.status)} 不可接受(须 DECLARED): ${input.taskId}`);
    }
    const claim = db
      .prepare('SELECT task_id, status, workspace_id FROM claims WHERE claim_id = ?')
      .get(input.claimId);
    if (claim === undefined) {
      throw new GovError('E_NOT_FOUND', `认领不存在: ${input.claimId}`);
    }
    if (String(claim.task_id) !== input.taskId) {
      throw new GovError('E_CLAIM_STATE_INVALID', `认领不属于该任务: ${input.claimId}`);
    }
    if (String(claim.status) !== 'DISPATCHED') {
      throw new GovError('E_CLAIM_STATE_INVALID', `认领状态 ${String(claim.status)} 不可接受(须 DISPATCHED): ${input.claimId}`);
    }
    if (claim.workspace_id === null) {
      throw new GovError('E_CLAIM_STATE_INVALID', `认领未绑定工作区: ${input.claimId}`);
    }
    const workspace = db
      .prepare('SELECT host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
      .get(String(claim.workspace_id));
    if (workspace === undefined || workspace.env_instance_id === null) {
      throw new GovError('E_CLAIM_STATE_INVALID', `认领缺执行环境: ${input.claimId}`);
    }
    const envInstanceId = String(workspace.env_instance_id);

    // 写权限切换是外部副作用：落 step 回执（尝试序号使人工处置后可重试 accept）。
    const ledger = createStepLedger(db, input.claimId);
    const stage = `accept-writable:${countPriorAcceptSteps(input.claimId) + 1}`;
    const opId = ledger.begin(stage, { claimId: input.claimId, envInstanceId });
    try {
      await withStepTimeout(deps.env.setWritable(envInstanceId), stepTimeoutMs, stage);
    } catch (err) {
      const message = errorMessage(err);
      if (isUncertainOutcome(err)) {
        ledger.uncertain(opId, stage, message);
        await attemptReadonlyFallback(envInstanceId);
        markClaimUncertain(input.claimId, input.taskId, input.session, stage, WRITABLE_SWITCH_BLOCKED_REASON);
        throw new GovError('E_CLAIM_UNCERTAIN', `切可写结果不确定: ${message}`);
      }
      ledger.fail(opId, stage, 'E_ENV_SWITCH_FAILED', message);
      // 切换失败回退并转人工：显式回退只读（适配器内部已回退 0000，此处双保险），
      // 认领置 UNCERTAIN——worker 可能已在运行，写权限状态存疑时绝不能留在 DISPATCHED。
      await attemptReadonlyFallback(envInstanceId);
      markClaimUncertain(input.claimId, input.taskId, input.session, stage, WRITABLE_SWITCH_BLOCKED_REASON);
      throw new GovError(
        'E_ENV_SWITCH_FAILED',
        `切可写失败(认领已置 UNCERTAIN 转人工): ${message}`,
      );
    }
    ledger.confirm(opId, stage, { envInstanceId });

    // 先翻认领再翻任务（两个状态机各自原子）：单写入者纪律下无中间窗口。
    applyClaimTransition(db, input.claimId, 'ACTIVE');
    const transition = applyTaskTransition(db, input.taskId, 'accept', {
      actor: input.session,
      payload: { claimId: input.claimId },
    });

    const spec = loadDeclaredSpec(db, input.taskId, deps.config);
    // 可写子目录名不在 workspaces 表列中，以 env 步骤回执为持久真源。
    const envStep = db
      .prepare('SELECT receipt_json FROM operations WHERE request_id = ?')
      .get(`claim:${input.claimId}:env`);
    let taskDirRel = '';
    if (envStep !== undefined) {
      try {
        const refs = (
          JSON.parse(String(envStep.receipt_json)) as {
            body?: { refs?: { taskDirRel?: unknown } };
          }
        ).body?.refs;
        if (typeof refs?.taskDirRel === 'string') {
          taskDirRel = refs.taskDirRel;
        }
      } catch {
        // 回执损坏时提示退化为空，不影响已完成的 accept。
      }
    }
    return {
      taskId: input.taskId,
      claimId: input.claimId,
      status: 'ACTIVE',
      taskStatus: transition.to,
      workspace: {
        hostPath: String(workspace.host_path),
        taskDirRel,
        ownedPaths: spec.ownedPaths,
      },
    };
  }

  /** 切换失败后的只读回退：尽力而为，失败不掩盖原始错误。 */
  async function attemptReadonlyFallback(envInstanceId: string): Promise<void> {
    try {
      await withStepTimeout(deps.env.setReadonly(envInstanceId), stepTimeoutMs, 'accept-fallback');
    } catch {
      // 回退失败时认领同样落 UNCERTAIN；此处不抛出，保留原始切换错误给调用方。
    }
  }

  function listClaims(taskId: string): ClaimView[] {
    const rows = db
      .prepare(
        `SELECT claim_id, task_id, status, dispatch_id, claimer_session, terminal_handle, workspace_id, created_at, updated_at
           FROM claims WHERE task_id = ? ORDER BY created_at ASC, claim_id ASC`,
      )
      .all(taskId);
    return rows.map((row) => ({
      claimId: String(row.claim_id),
      taskId: String(row.task_id),
      status: row.status as ClaimStatus,
      dispatchId: row.dispatch_id === null ? null : String(row.dispatch_id),
      claimerSession: row.claimer_session === null ? null : String(row.claimer_session),
      terminalHandle: row.terminal_handle === null ? null : String(row.terminal_handle),
      workspaceId: row.workspace_id === null ? null : String(row.workspace_id),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    }));
  }

  return { claim, accept, listClaims };
}

// ---------------------------------------------------------------------------
// api.ts 接线（鉴权/幂等由 T1.3 信封处理；此处只做载荷解析与服务调用）
// ---------------------------------------------------------------------------

const claimPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  retryOf: z.string().min(1).optional(),
});

const acceptPayloadSchema = z.strictObject({
  taskId: z.string().min(1),
  claimId: z.string().min(1).optional(),
});

export interface ClaimHandlersDeps {
  readonly config: GovConfig;
  readonly orca: OrcaPort;
  readonly jj: JjPort;
  readonly env: EnvPort;
  readonly trustProvision?: TrustProvision | undefined;
  readonly stepTimeoutMs?: number | undefined;
}

function buildService(deps: ClaimHandlersDeps, ctx: ActionContext): ClaimService {
  return createClaimService({
    db: ctx.db,
    config: deps.config,
    orca: deps.orca,
    jj: deps.jj,
    env: deps.env,
    ...(deps.trustProvision !== undefined ? { trustProvision: deps.trustProvision } : {}),
    ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
  });
}

export function createClaimHandler(deps: ClaimHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = claimPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(claim): ${formatZodIssues(parsed.error)}`);
    }
    const input: ClaimInput = {
      taskId: parsed.data.taskId,
      ...(parsed.data.retryOf !== undefined ? { retryOf: parsed.data.retryOf } : {}),
    };
    return buildService(deps, ctx).claim(ctx.token.capabilityId, input);
  };
}

export function createAcceptHandler(deps: ClaimHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = acceptPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(accept): ${formatZodIssues(parsed.error)}`);
    }
    const claimId = parsed.data.claimId ?? ctx.token.claimId ?? '';
    return buildService(deps, ctx).accept({
      taskId: parsed.data.taskId,
      claimId,
      tokenClaimId: ctx.token.claimId,
      session: ctx.token.capabilityId,
    });
  };
}
