/**
 * 完成操作恢复服务（T4.1，设计 §7.3/§13）。
 *
 * 四个恢复面：
 * 1. operationShow / operationResume——UNCERTAIN 操作的查明后恢复。铁律：
 *    结果不确定绝不自动重试；confirm-done / mark-failed-retryable 必须引用一次
 *    本操作的真实 verify-external 回执（E_RECOVERY_UNVERIFIED），且分类与动作
 *    一致（DONE 才可 confirm、ABSENT 才可 mark）；未经查明的 UNCERTAIN 一律不动。
 * 2. replaceExecutor——执行认领替换：先取旧 writer 退出证据（存活即
 *    E_RECOVERY_WRITER_ALIVE），结算回执落库后才 FENCE + 令牌吊销 + retry-of
 *    重派；REVIEW_REQUESTED 按 §13.14（取消并结算未开始评审、销毁评审资源、
 *    旧提交作废、回 ACTIVE）。旧提交/评审不转移：新认领的 submit 是新提交。
 * 3. supersedeTask——范围变化以新任务版本替代（declare 新任务 + 旧任务
 *    supersede→SUPERSEDED + 全量清理登记），不原地改旧任务书。
 * 4. recoverCoordinator——协调 Session 无状态：仅 orca.runUse 重绑并回报，
 *    gov 数据一律不动。
 *
 * 恢复的下游续跑只复用 T3.x 服务的既有幂等（completeTask 重入、claim 重走、
 * cleanup 逐项幂等），恢复自身不重复合并、不重复建 Session/环境；mid-prepare
 * 认领的 confirm-done 从「已查明的下一阶段」续跑，不重建已查明的资源。
 *
 * 与既有服务的两处结构适配（以既有为准，详见 phase 报告）：
 * - 认领状态机无 UNCERTAIN→DISPATCHED 出边：查明后的 mid-prepare 认领经
 *   UNCERTAIN→ACTIVE 恢复（setWritable 后），等价于补完 claim+accept 两步。
 * - 旧提交作废复用 task_rebase 事件的 supersededSubmissionIds 载体（唯一消费
 *   面 latestActiveSubmission 只读该事件类型），载荷注明 reason 以便审计。
 *
 * 本模块与 services/ 全目录同规：禁止 import node:child_process，一切外部
 * 动作经注入端口；容器存在性经 EnvFactsPort（T2.3 适配器无只读动词）。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { applyClaimTransition, type ClaimStatus } from '../state/claim-machine.ts';
import { applyTaskTransition } from '../state/task-machine.ts';
import { withTransaction } from '../db/database.ts';
import { beginOperation, canonicalRequestHash } from '../operations.ts';
import { issueToken } from '../auth.ts';
import type { WorkerStartReceipt } from '../adapters/orca.ts';
import {
  isUncertainOutcome,
  isTrustGateFailure,
  isWorkerStartReady,
  type EnvFactsPort,
  type EnvLifecyclePort,
  type JjFactsPort,
  type JjMergePort,
  type OrcaFactsPort,
  type OrcaSettlementPort,
  type TrustProvision,
} from './ports.ts';
import {
  createDefaultTrustProvision,
  prepareWorkspace,
  type PreparedWorkspace,
} from './workspaces.ts';
import { createStepLedger, CLAIM_EVENT_TYPES, WORKER_START_RETRY_LIMIT } from './claims.ts';
import { loadDeclaredSpec } from './tasks.ts';
import {
  errorMessage,
  lastKnownTargetCommit,
  latestActiveSubmission,
  recordCleanupIntent,
  recordTaskEvent,
  sha256Hex,
  supersededSubmissionIds,
  withStepTimeout,
} from './submissions.ts';
import { runCleanup, scheduleCleanup, type CleanupServiceDeps } from './cleanup.ts';
import type { ActionContext, ActionHandler } from '../api.ts';

/** 恢复审计事件（自由 type；events.task_id 可空——无任务关联的验证也留档）。 */
export const RECOVERY_EVENT_TYPES = {
  verification: 'recovery_verification',
  confirmed: 'recovery_confirmed',
  markedFailed: 'recovery_marked_failed_retryable',
  dispatchSettled: 'recovery_dispatch_settled',
} as const;

/** verify-external 的外部事实三分类。 */
export type ExternalClassification = 'EXTERNAL_DONE' | 'EXTERNAL_ABSENT' | 'EXTERNAL_UNKNOWN';

/** worker 仍可能在外部干活的 state 集（与 lifecycle 集测口径一致）。 */
const LIVE_WORKER_STATES = new Set(['ready', 'running', 'pending', 'starting']);

/** 结算类错误里可视为「派工已不在」的 Orca 错误码子串。 */
const DISPATCH_GONE_HINTS = ['not_found', 'dispatch_inactive'];

const VERIFICATION_ID_PREFIX = 'gvr_';
const CLAIM_ID_PREFIX = 'gcl_';
const MERGE_ID_PREFIX = 'gmg_';

export interface RecoveryDeps {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: OrcaSettlementPort & OrcaFactsPort;
  readonly jj: JjMergePort & JjFactsPort;
  readonly env: EnvLifecyclePort;
  /** 只读容器事实；缺席时 env 相关查明如实返回 EXTERNAL_UNKNOWN。 */
  readonly envFacts?: EnvFactsPort | undefined;
  /** worker 发现的 Run 归属范围（无回执派工只能按 Run+任务筛选）。 */
  readonly runId?: string | undefined;
  readonly trustProvision?: TrustProvision | undefined;
  readonly stepTimeoutMs?: number | undefined;
}

// ---------------------------------------------------------------------------
// 操作关联解析：request_id 前缀是 operations 与任务/认领的唯一稳定连线
// ---------------------------------------------------------------------------

export type OperationCategory =
  | 'claim-workspace'
  | 'claim-env'
  | 'claim-trust'
  | 'claim-worker-start'
  | 'claim-accept-writable'
  | 'merge-confirm'
  | 'envelope';

export interface OperationLinkage {
  readonly category: OperationCategory;
  readonly taskId: string | null;
  readonly claimId: string | null;
  readonly stage: string | null;
  readonly submissionId: string | null;
}

interface OperationRow {
  readonly operationId: string;
  readonly requestId: string;
  readonly kind: string;
  readonly status: string;
  readonly currentStep: string | null;
  readonly errorCode: string | null;
  readonly receipt: unknown;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function loadOperation(db: DatabaseSync, operationId: string): OperationRow {
  const row = db
    .prepare(
      'SELECT operation_id, request_id, kind, status, current_step, error_code, receipt_json, created_at, updated_at FROM operations WHERE operation_id = ?',
    )
    .get(operationId);
  if (row === undefined) {
    throw new GovError('E_NOT_FOUND', `操作不存在: ${operationId}`);
  }
  let receipt: unknown = null;
  if (row.receipt_json !== null) {
    try {
      receipt = JSON.parse(String(row.receipt_json));
    } catch {
      receipt = String(row.receipt_json);
    }
  }
  return {
    operationId: String(row.operation_id),
    requestId: String(row.request_id),
    kind: String(row.kind),
    status: String(row.status),
    currentStep: row.current_step === null ? null : String(row.current_step),
    errorCode: row.error_code === null ? null : String(row.error_code),
    receipt,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function claimBaseStage(stage: string): string {
  // resume 续跑键形如 `env:resume:2`，映射回基础阶段。
  const base = stage.split(':resume:')[0] ?? stage;
  return base;
}

function parseLinkage(db: DatabaseSync, op: OperationRow): OperationLinkage {
  const claimMatch = /^claim:(gcl_[A-Za-z0-9_-]+):(.+)$/.exec(op.requestId);
  if (claimMatch !== null && op.kind === 'claim') {
    const claimId = claimMatch[1] as string;
    const stage = claimMatch[2] as string;
    const base = claimBaseStage(stage);
    const category: OperationCategory =
      base === 'workspace'
        ? 'claim-workspace'
        : base === 'env'
          ? 'claim-env'
          : base === 'trust'
            ? 'claim-trust'
            : base === 'worker-start'
              ? 'claim-worker-start'
              : base.startsWith('accept-writable')
                ? 'claim-accept-writable'
                : 'envelope';
    const claim = db.prepare('SELECT task_id FROM claims WHERE claim_id = ?').get(claimId);
    return {
      category,
      claimId,
      stage,
      submissionId: null,
      taskId: claim === undefined ? null : String(claim.task_id),
    };
  }
  const mergeMatch = /^merge:(gsu_[A-Za-z0-9_-]+):\d+$/.exec(op.requestId);
  if (mergeMatch !== null) {
    const submissionId = mergeMatch[1] as string;
    const task = db
      .prepare(
        'SELECT c.task_id AS task_id FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE s.submission_id = ?',
      )
      .get(submissionId);
    return {
      category: 'merge-confirm',
      taskId: task === undefined ? null : String(task.task_id),
      claimId: null,
      stage: null,
      submissionId,
    };
  }
  // 信封级操作（kind=动作名）：载荷不落库，无法机械连线任务——verify 如实
  // 返回 UNKNOWN 并引导按 claim:/merge: 前缀逐段查明。
  return { category: 'envelope', taskId: null, claimId: null, stage: null, submissionId: null };
}

// ---------------------------------------------------------------------------
// 外部事实（全部只读）
// ---------------------------------------------------------------------------

export interface DispatchFact {
  readonly dispatchId: string;
  readonly state: string;
  readonly terminalHandle: string | null;
}

export interface ExternalFacts {
  readonly workspace: { readonly name: string | null; readonly registered: boolean; readonly matches: number; readonly error: string | null } | null;
  readonly env: { readonly envInstanceId: string | null; readonly exists: boolean; readonly discovered: boolean; readonly error: string | null } | null;
  readonly trust: { readonly hostPath: string; readonly entryPresent: boolean; readonly error: string | null } | null;
  readonly dispatch: { readonly dispatches: readonly DispatchFact[]; readonly error: string | null } | null;
  readonly bookmark: { readonly bookmark: string; readonly current: string | null; readonly expected: string | null; readonly to: string | null; readonly error: string | null } | null;
  readonly envWritable: { readonly hostDir: string; readonly writable: boolean; readonly error: string | null } | null;
}

function slugify(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '-');
}

function workspacePrefix(taskId: string): string {
  return `gt-${slugify(taskId)}-`;
}

/** 步骤账本 CONFIRMED 回执里的 refs（workspace 阶段的 name/path 等持久真源）。 */
function ledgerRefs(db: DatabaseSync, requestId: string): Record<string, unknown> | null {
  const row = db.prepare('SELECT receipt_json FROM operations WHERE request_id = ?').get(requestId);
  if (row === undefined) {
    return null;
  }
  try {
    const refs = (JSON.parse(String(row.receipt_json)) as { body?: { refs?: unknown } }).body?.refs;
    if (refs !== null && typeof refs === 'object' && !Array.isArray(refs)) {
      return refs as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

interface ClaimContext {
  readonly claimId: string;
  readonly taskId: string;
  readonly claimStatus: ClaimStatus;
  readonly dispatchId: string | null;
  readonly workspaceId: string | null;
  readonly workspaceName: string | null;
  readonly workspaceHostPath: string | null;
  readonly envInstanceId: string | null;
}

/** 收集中的可变事实视图（gatherExternalFacts 内部装配，返回时即定型）。 */
type MutableExternalFacts = { -readonly [K in keyof ExternalFacts]: ExternalFacts[K] };

function loadClaimContext(db: DatabaseSync, claimId: string): ClaimContext {
  const claim = db
    .prepare('SELECT task_id, status, dispatch_id, workspace_id FROM claims WHERE claim_id = ?')
    .get(claimId);
  if (claim === undefined) {
    throw new GovError('E_NOT_FOUND', `认领不存在: ${claimId}`);
  }
  // 认领行只在 DISPATCHED 落 workspace_id；mid-prepare 认领从步骤账本回执取
  // workspaceId/name/path（workspace 阶段 CONFIRMED 后即有）。
  const ledgerWs = ledgerRefs(db, `claim:${claimId}:workspace`);
  const idFromLedger =
    typeof ledgerWs?.['workspaceId'] === 'string' ? (ledgerWs['workspaceId'] as string) : null;
  const nameFromLedger =
    typeof ledgerWs?.['name'] === 'string' ? (ledgerWs['name'] as string) : null;
  const pathFromLedger =
    typeof ledgerWs?.['path'] === 'string' ? (ledgerWs['path'] as string) : null;
  const workspaceId =
    claim.workspace_id === null ? idFromLedger : String(claim.workspace_id);
  const wsRow = db
    .prepare('SELECT jj_workspace_name, host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(workspaceId ?? '__none__');
  const rowWsName = wsRow?.jj_workspace_name;
  const rowWsPath = wsRow?.host_path;
  return {
    claimId,
    taskId: String(claim.task_id),
    claimStatus: claim.status as ClaimStatus,
    dispatchId: claim.dispatch_id === null ? null : String(claim.dispatch_id),
    workspaceId,
    workspaceName:
      rowWsName === null || rowWsName === undefined
        ? nameFromLedger
        : String(rowWsName),
    workspaceHostPath:
      rowWsPath === null || rowWsPath === undefined ? pathFromLedger : String(rowWsPath),
    envInstanceId:
      wsRow?.env_instance_id === null || wsRow?.env_instance_id === undefined
        ? null
        : String(wsRow.env_instance_id),
  };
}

/** 已删除认领（确定失败回滚后）的历史操作：查明面降级为无认领事实。 */
function tryLoadClaimContext(db: DatabaseSync, claimId: string): ClaimContext | null {
  try {
    return loadClaimContext(db, claimId);
  } catch (err) {
    if (err instanceof GovError && err.code === 'E_NOT_FOUND') {
      return null;
    }
    throw err;
  }
}

async function gatherExternalFacts(
  deps: RecoveryDeps,
  db: DatabaseSync,
  linkage: OperationLinkage,
): Promise<ExternalFacts> {
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;
  const facts: MutableExternalFacts = {
    workspace: null,
    env: null,
    trust: null,
    dispatch: null,
    bookmark: null,
    envWritable: null,
  };

  let claim: ClaimContext | null = null;
  if (linkage.claimId !== null) {
    claim = tryLoadClaimContext(db, linkage.claimId);
  }
  const taskId = linkage.taskId ?? claim?.taskId ?? null;

  // workspace 事实（claim 链）：账本名精确命中 + 任务前缀扫描兜底（无回执时）。
  if (claim !== null) {
    const prefix = workspacePrefix(claim.taskId);
    try {
      const listed = await withStepTimeout(deps.jj.workspaceList(), stepTimeoutMs, 'facts_workspace_list');
      const entries = listed.workspaces;
      const known = claim.workspaceName;
      const matches = entries.filter((e) => e.name === known || e.name.startsWith(prefix));
      const unique = [...new Set(matches.map((e) => e.name))];
      facts.workspace = {
        name: unique.length === 1 ? (unique[0] as string) : known,
        registered: unique.length > 0,
        matches: unique.length,
        error: null,
      };
    } catch (err) {
      facts.workspace = { name: claim.workspaceName, registered: false, matches: 0, error: errorMessage(err) };
    }
  }

  // env 事实（claim 链）：行内 envInstanceId 优先；无回执时按挂载反查发现。
  if (claim !== null) {
    const hostPath = claim.workspaceHostPath;
    const taskDirRel = `${slugify(claim.claimId)}-w`;
    if (claim.envInstanceId !== null) {
      if (deps.envFacts === undefined) {
        facts.env = { envInstanceId: claim.envInstanceId, exists: false, discovered: false, error: 'envFacts 未注入，无法查明容器存在性' };
      } else {
        try {
          const exists = await withStepTimeout(deps.envFacts.exists(claim.envInstanceId), stepTimeoutMs, 'facts_env_exists');
          facts.env = { envInstanceId: claim.envInstanceId, exists, discovered: false, error: null };
        } catch (err) {
          facts.env = { envInstanceId: claim.envInstanceId, exists: false, discovered: false, error: errorMessage(err) };
        }
      }
    } else if (hostPath !== null) {
      if (deps.envFacts === undefined) {
        facts.env = { envInstanceId: null, exists: false, discovered: false, error: 'envFacts 未注入，无法按挂载发现容器' };
      } else {
        try {
          const found = await withStepTimeout(
            deps.envFacts.findByWorkspace(hostPath, taskDirRel),
            stepTimeoutMs,
            'facts_env_discover',
          );
          facts.env = {
            envInstanceId: found,
            exists: found !== null,
            discovered: found !== null,
            error: null,
          };
        } catch (err) {
          facts.env = { envInstanceId: null, exists: false, discovered: false, error: errorMessage(err) };
        }
      }
    } else {
      facts.env = { envInstanceId: null, exists: false, discovered: false, error: null };
    }
  }

  // trust 事实（claim 链）：宿主信任表条目（与 createDefaultTrustProvision 同一口径）。
  if (claim !== null && claim.workspaceHostPath !== null) {
    const hostPath = claim.workspaceHostPath;
    const configDir = process.env['CLAUDE_CONFIG_DIR'];
    const file = join(configDir !== undefined && configDir.length > 0 ? configDir : join(homedir(), '.claude'), '.claude.json');
    try {
      const doc = JSON.parse(await readFile(file, 'utf8')) as {
        projects?: Record<string, { hasTrustDialogAccepted?: unknown }>;
      };
      facts.trust = {
        hostPath,
        entryPresent: doc.projects?.[hostPath]?.hasTrustDialogAccepted === true,
        error: null,
      };
    } catch (err) {
      facts.trust = { hostPath, entryPresent: false, error: errorMessage(err) };
    }
  }

  // dispatch 事实：认领行已知派工 → workerShow；无回执派工 → workerList 按任务发现。
  if (claim !== null && taskId !== null) {
    const orcaTaskId = db.prepare('SELECT orca_task_id FROM tasks WHERE task_id = ?').get(taskId)?.orca_task_id;
    if (claim.dispatchId !== null) {
      try {
        const shown = await withStepTimeout(deps.orca.workerShow(claim.dispatchId), stepTimeoutMs, 'facts_worker_show');
        facts.dispatch = {
          dispatches: [
            {
              dispatchId: claim.dispatchId,
              state: shown.raw.worker.state,
              terminalHandle: null,
            },
          ],
          error: null,
        };
      } catch (err) {
        facts.dispatch = { dispatches: [], error: errorMessage(err) };
      }
    } else if (orcaTaskId !== null && orcaTaskId !== undefined) {
      // 无回执派工只能靠清单发现。两个实证口径：清单对刚创建的派工有短暂可见
      // 性延迟（零命中时短暂重列）；并发会话会把共享协调终端重绑到别的 Run，
      // 派工落在当前绑定 Run 而非恢复层记录的 runId——发现面按「本 Run + 当前
      // 绑定」双清单并集，按任务归属过滤后仍为零才判 ABSENT。
      try {
        const runScope = deps.runId !== undefined ? { run: deps.runId } : {};
        const byId = new Map<string, { dispatchId: string; state: string; terminalHandle: string | null }>();
        const collect = async (scope: { run?: string }): Promise<void> => {
          const listed = await withStepTimeout(deps.orca.workerList(scope), stepTimeoutMs, 'facts_worker_list');
          for (const w of (listed.raw.workers ?? []).filter((w) => w.taskId === String(orcaTaskId))) {
            byId.set(w.dispatchId, {
              dispatchId: w.dispatchId,
              state: w.workerState,
              terminalHandle: w.agentTerminalHandle ?? null,
            });
          }
        };
        let mine: Array<{ dispatchId: string; state: string; terminalHandle: string | null }> = [];
        for (let attempt = 0; attempt < 3 && mine.length === 0; attempt++) {
          await collect(runScope);
          if (byId.size === 0) {
            await collect({});
          }
          mine = [...byId.values()];
          if (mine.length === 0) {
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        }
        facts.dispatch = { dispatches: mine, error: null };
      } catch (err) {
        facts.dispatch = { dispatches: [], error: errorMessage(err) };
      }
    }
  }

  // bookmark 事实（merge 链 + 顶层目标任务只读快照）。
  if (taskId !== null) {
    try {
      const spec = loadDeclaredSpec(db, taskId, deps.config);
      if (spec.target.kind === 'top-level') {
        const expected = lastKnownTargetCommit(db, taskId, spec.baseCommitId);
        let to: string | null = null;
        if (linkage.submissionId !== null) {
          const row = db.prepare('SELECT commit_id FROM submissions WHERE submission_id = ?').get(linkage.submissionId);
          to = row === undefined ? null : String(row.commit_id);
        }
        let current: string | null = null;
        let error: string | null = null;
        try {
          current = (await withStepTimeout(deps.jj.bookmarkCurrent(spec.target.bookmark), stepTimeoutMs, 'facts_bookmark')).commitId;
        } catch (err) {
          error = errorMessage(err);
        }
        facts.bookmark = { bookmark: spec.target.bookmark, current, expected, to, error };
      }
    } catch {
      // 任务书不可恢复（库内漂移）时 bookmark 事实缺席，分类自然落 UNKNOWN。
    }
  }

  // accept-writable 事实：宿主可写目录权限位（0000/0777 切换的可读投影）。
  if (claim !== null && linkage.category === 'claim-accept-writable' && claim.workspaceHostPath !== null) {
    const hostDir = join(claim.workspaceHostPath, `${slugify(claim.claimId)}-w`);
    try {
      const mode = statSync(hostDir).mode;
      facts.envWritable = { hostDir, writable: (mode & 0o200) !== 0, error: null };
    } catch (err) {
      facts.envWritable = { hostDir, writable: false, error: errorMessage(err) };
    }
  }

  return facts;
}

function classify(category: OperationCategory, facts: ExternalFacts): { classification: ExternalClassification; reason: string } {
  switch (category) {
    case 'claim-workspace': {
      const w = facts.workspace;
      if (w === null || w.error !== null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: w?.error ?? 'workspace 事实缺失' };
      }
      if (w.matches === 1 && w.registered) {
        return { classification: 'EXTERNAL_DONE', reason: `jj workspace 已注册: ${w.name}` };
      }
      if (w.matches === 0) {
        return { classification: 'EXTERNAL_ABSENT', reason: '任务前缀下无已注册 workspace' };
      }
      return { classification: 'EXTERNAL_UNKNOWN', reason: `任务前缀命中 ${w.matches} 个 workspace，无法唯一归属` };
    }
    case 'claim-env': {
      const e = facts.env;
      if (e === null || e.error !== null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: e?.error ?? 'env 事实缺失' };
      }
      return e.exists
        ? { classification: 'EXTERNAL_DONE', reason: `容器存在: ${e.envInstanceId}` }
        : { classification: 'EXTERNAL_ABSENT', reason: '按挂载面未发现容器' };
    }
    case 'claim-trust': {
      const t = facts.trust;
      if (t === null || t.error !== null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: t?.error ?? 'trust 事实缺失' };
      }
      return t.entryPresent
        ? { classification: 'EXTERNAL_DONE', reason: `信任条目存在: ${t.hostPath}` }
        : { classification: 'EXTERNAL_ABSENT', reason: `信任条目缺失: ${t.hostPath}` };
    }
    case 'claim-worker-start': {
      const d = facts.dispatch;
      if (d === null || d.error !== null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: d?.error ?? 'dispatch 事实缺失' };
      }
      if (d.dispatches.length === 1) {
        const found = d.dispatches[0] as DispatchFact;
        return { classification: 'EXTERNAL_DONE', reason: `派工存在(state=${found.state}): ${found.dispatchId}` };
      }
      if (d.dispatches.length === 0) {
        return { classification: 'EXTERNAL_ABSENT', reason: '任务名下无派工' };
      }
      return { classification: 'EXTERNAL_UNKNOWN', reason: `任务名下命中 ${d.dispatches.length} 个派工，无法唯一归属` };
    }
    case 'claim-accept-writable': {
      const w = facts.envWritable;
      if (w === null || w.error !== null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: w?.error ?? 'writable 事实缺失' };
      }
      return w.writable
        ? { classification: 'EXTERNAL_DONE', reason: `可写区已开放写: ${w.hostDir}` }
        : { classification: 'EXTERNAL_ABSENT', reason: `可写区仍处只读: ${w.hostDir}` };
    }
    case 'merge-confirm': {
      const b = facts.bookmark;
      if (b === null || b.error !== null || b.current === null || b.to === null || b.expected === null) {
        return { classification: 'EXTERNAL_UNKNOWN', reason: b?.error ?? 'bookmark 事实缺失' };
      }
      if (b.current === b.to) {
        return { classification: 'EXTERNAL_DONE', reason: `bookmark 已在合并提交(${b.to})` };
      }
      if (b.current === b.expected) {
        return { classification: 'EXTERNAL_ABSENT', reason: `bookmark 仍在评审基线(${b.expected})，未移动` };
      }
      return {
        classification: 'EXTERNAL_UNKNOWN',
        reason: `bookmark 在第三处(${b.current}，基线 ${b.expected}，目标 ${b.to})，需人工判读`,
      };
    }
    case 'envelope':
      return {
        classification: 'EXTERNAL_UNKNOWN',
        reason: '信封级操作无步骤账本连线；请以 operationShow 列出的 claim:/merge: 步骤操作逐段查明',
      };
  }
}

// ---------------------------------------------------------------------------
// 查明回执（verify-external 的持久化：verificationId 是 confirm/mark 的引用）
// ---------------------------------------------------------------------------

export interface VerificationRecord {
  readonly verificationId: string;
  readonly operationId: string;
  readonly classification: ExternalClassification;
  readonly reason: string;
  readonly facts: ExternalFacts;
  readonly checkedAt: string;
}

function findVerification(db: DatabaseSync, verificationId: string, operationId: string): VerificationRecord | undefined {
  const rows = db
    .prepare('SELECT payload_json FROM events WHERE type = ? ORDER BY seq ASC')
    .all(RECOVERY_EVENT_TYPES.verification);
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as {
        verificationId?: unknown;
        operationId?: unknown;
        classification?: unknown;
        reason?: unknown;
        facts?: unknown;
        checkedAt?: unknown;
      };
      if (payload.verificationId === verificationId && payload.operationId === operationId) {
        return {
          verificationId,
          operationId,
          classification: payload.classification as ExternalClassification,
          reason: typeof payload.reason === 'string' ? payload.reason : '',
          facts: (payload.facts ?? {}) as ExternalFacts,
          checkedAt: typeof payload.checkedAt === 'string' ? payload.checkedAt : '',
        };
      }
    } catch {
      // 损坏行跳过：引用不匹配任何合法回执即 E_RECOVERY_UNVERIFIED。
    }
  }
  return undefined;
}

function requireResumableStatus(op: OperationRow): void {
  if (op.status === 'CONFIRMED' || op.status === 'FAILED') {
    throw new GovError(
      'E_RECOVERY_STATE_INVALID',
      `操作已处终态 ${op.status}，无恢复对象: ${op.operationId}`,
    );
  }
  if (op.status !== 'UNCERTAIN' && op.status !== 'IN_FLIGHT' && op.status !== 'PREPARED') {
    throw new GovError('E_RECOVERY_STATE_INVALID', `操作状态 ${op.status} 不可恢复处置: ${op.operationId}`);
  }
}

function settleOperationStatus(db: DatabaseSync, operationId: string, status: 'CONFIRMED' | 'FAILED', step: string): void {
  db.prepare('UPDATE operations SET status = ?, current_step = ?, updated_at = ? WHERE operation_id = ?').run(
    status,
    `recovered:${step}`,
    new Date().toISOString(),
    operationId,
  );
}

/** 恢复处置结果回放（重复 confirm/mark 不重做副作用）。 */
function findDisposition(db: DatabaseSync, eventType: string, operationId: string): Record<string, unknown> | undefined {
  const rows = db.prepare('SELECT payload_json FROM events WHERE type = ?').all(eventType);
  for (const row of rows) {
    try {
      const payload = JSON.parse(String(row.payload_json)) as { operationId?: unknown };
      if (payload.operationId === operationId) {
        return payload as Record<string, unknown>;
      }
    } catch {
      // 损坏行跳过。
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// mid-prepare 认领的续跑（confirm-done：不重建已查明的资源）
// ---------------------------------------------------------------------------

interface ResumeLedger {
  begin(stage: string, refs: Record<string, unknown>): string;
  confirm(operationId: string, stage: string, refs: Record<string, unknown>): void;
  fail(operationId: string, stage: string, code: string, message: string): void;
  uncertain(operationId: string, stage: string, message: string): void;
}

/** 续跑步骤账本：`claim:<claimId>:<stage>:resume:<N>`，与首跑键不冲突。 */
function createResumeLedger(db: DatabaseSync, claimId: string): ResumeLedger {
  const nextAttempt = (stage: string): number => {
    const prefix = `claim:${claimId}:${stage}:resume:`;
    const row = db
      .prepare('SELECT COUNT(*) AS c FROM operations WHERE substr(request_id, 1, ?) = ?')
      .get(prefix.length, prefix);
    return Number(row?.c ?? 0) + 1;
  };
  const begin = (stage: string, refs: Record<string, unknown>): string => {
    const requestId = `claim:${claimId}:${stage}:resume:${nextAttempt(stage)}`;
    const requestHash = canonicalRequestHash(requestId, 'claim', refs);
    const result = beginOperation(db, { requestId, requestHash, kind: 'claim' });
    if (result.type !== 'start') {
      throw new GovError('E_REQUEST_INVALID', `续跑账本 ${requestId} 非新开(${result.type})`);
    }
    db.prepare('UPDATE operations SET current_step = ? WHERE operation_id = ?').run(stage, result.operationId);
    return result.operationId;
  };
  const confirm = (operationId: string, stage: string, refs: Record<string, unknown>): void => {
    db.prepare('UPDATE operations SET status = ?, current_step = ?, receipt_json = ?, updated_at = ? WHERE operation_id = ?').run(
      'CONFIRMED',
      stage,
      JSON.stringify({ httpStatus: 200, body: { ok: true, stage, refs } }),
      new Date().toISOString(),
      operationId,
    );
  };
  const fail = (operationId: string, stage: string, code: string, message: string): void => {
    db.prepare('UPDATE operations SET status = ?, current_step = ?, receipt_json = ?, error_code = ?, updated_at = ? WHERE operation_id = ?').run(
      'FAILED',
      stage,
      JSON.stringify({ httpStatus: 400, body: { ok: false, error: { code, message } } }),
      code,
      new Date().toISOString(),
      operationId,
    );
  };
  const uncertain = (operationId: string, stage: string, message: string): void => {
    db.prepare('UPDATE operations SET status = ?, current_step = ?, receipt_json = ?, error_code = ?, updated_at = ? WHERE operation_id = ?').run(
      'UNCERTAIN',
      stage,
      JSON.stringify({ httpStatus: 504, body: { ok: false, error: { code: 'E_CLAIM_UNCERTAIN', message } } }),
      'E_CLAIM_UNCERTAIN',
      new Date().toISOString(),
      operationId,
    );
  };
  return { begin, confirm, fail, uncertain };
}

function countWorkerStartAttempts(db: DatabaseSync, taskId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = ?')
    .get(taskId, CLAIM_EVENT_TYPES.workerStartAttempt);
  return Number(row?.c ?? 0);
}

function countAcceptWritableSteps(db: DatabaseSync, claimId: string): number {
  const prefix = `claim:${claimId}:accept-writable:`;
  const row = db
    .prepare('SELECT COUNT(*) AS c FROM operations WHERE substr(request_id, 1, ?) = ?')
    .get(prefix.length, prefix);
  return Number(row?.c ?? 0);
}

export interface RecoveryService {
  operationShow(input: { readonly requestId: string }): Promise<OperationShowResult>;
  operationResume(input: ResumeInput): Promise<ResumeResult>;
  replaceExecutor(input: { readonly taskId: string; readonly session: string }): Promise<ReplaceExecutorResult>;
  supersedeTask(input: { readonly taskId: string; readonly newSpec: unknown; readonly session: string }): Promise<SupersedeTaskResult>;
  recoverCoordinator(input: { readonly runId: string; readonly session: string }): Promise<RecoverCoordinatorResult>;
}

// ---------------------------------------------------------------------------
// 结果形状
// ---------------------------------------------------------------------------

export interface OperationShowResult {
  readonly operation: OperationRow;
  readonly linkage: OperationLinkage;
  readonly task: {
    readonly taskId: string;
    readonly status: string;
    readonly blockedReason: string | null;
    readonly currentClaimId: string | null;
    readonly orcaTaskId: string | null;
  } | null;
  readonly claim: {
    readonly claimId: string;
    readonly status: ClaimStatus;
    readonly dispatchId: string | null;
    readonly workspaceId: string | null;
  } | null;
  readonly externalFacts: ExternalFacts;
}

export interface ResumeInput {
  readonly operationId: string;
  readonly action: 'verify-external' | 'confirm-done' | 'mark-failed-retryable';
  readonly verificationRef?: string | undefined;
  readonly session: string;
}

export type ResumeResult =
  | {
      readonly action: 'verify-external';
      readonly verificationId: string;
      readonly operationId: string;
      readonly category: OperationCategory;
      readonly classification: ExternalClassification;
      readonly reason: string;
      readonly facts: ExternalFacts;
      readonly checkedAt: string;
    }
  | {
      readonly action: 'confirm-done' | 'mark-failed-retryable';
      readonly operationId: string;
      readonly category: OperationCategory;
      readonly idempotentReplay: boolean;
      readonly summary: Record<string, unknown>;
    };

export interface DispatchSettlementOutcome {
  readonly dispatchId: string;
  readonly state: string;
  readonly alreadySettled: boolean | null;
  readonly processAction: string | null;
  readonly via: 'stop' | 'abandon' | 'gone';
}

export interface ReplaceExecutorResult {
  readonly taskId: string;
  readonly taskStatus: string;
  readonly oldClaimId: string;
  readonly newClaimId: string;
  readonly newDispatchId: string;
  readonly retryOf: string | null;
  readonly settlement: DispatchSettlementOutcome | null;
  readonly reviewCancelled: { readonly reviewId: string; readonly resourcesDestroyed: number } | null;
  readonly voidedSubmissionIds: readonly string[];
  readonly scheduledCleanupItems: number;
  readonly executorToken: string;
  readonly executorCapabilityId: string;
  readonly claimStatus: 'DISPATCHED' | 'ACTIVE';
}

export interface SupersedeTaskResult {
  readonly oldTaskId: string;
  readonly newTaskId: string;
  readonly newSpecHash: string;
  readonly newOrcaTaskId: string;
  readonly oldTaskStatus: 'SUPERSEDED';
  readonly reviewCancelled: { readonly reviewId: string; readonly resourcesDestroyed: number } | null;
  readonly claimFenced: string | null;
  readonly scheduledCleanupItems: number;
}

export interface RecoverCoordinatorResult {
  readonly runId: string;
  readonly objective: string;
  readonly coordinatorHandle: string;
  readonly govDataUntouched: true;
}

// ---------------------------------------------------------------------------
// 服务实现
// ---------------------------------------------------------------------------

export function createRecoveryService(deps: RecoveryDeps): RecoveryService {
  const db = deps.db;
  const stepTimeoutMs = deps.stepTimeoutMs ?? 25_000;
  const trustProvision = deps.trustProvision ?? createDefaultTrustProvision();

  function cleanupDeps(): CleanupServiceDeps {
    return {
      db,
      config: deps.config,
      jj: deps.jj,
      env: deps.env,
      orca: deps.orca,
      ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
    };
  }

  // -------------------------------------------------------------------------
  // operationShow
  // -------------------------------------------------------------------------

  async function operationShow(input: { readonly requestId: string }): Promise<OperationShowResult> {
    const row = db
      .prepare(
        'SELECT operation_id FROM operations WHERE request_id = ?',
      )
      .get(input.requestId);
    if (row === undefined) {
      throw new GovError('E_NOT_FOUND', `操作不存在(requestId): ${input.requestId}`);
    }
    const op = loadOperation(db, String(row.operation_id));
    const linkage = parseLinkage(db, op);
    const facts = await gatherExternalFacts(deps, db, linkage);

    let task: OperationShowResult['task'] = null;
    if (linkage.taskId !== null) {
      const t = db
        .prepare('SELECT task_id, status, blocked_reason, current_claim_id, orca_task_id FROM tasks WHERE task_id = ?')
        .get(linkage.taskId);
      if (t !== undefined) {
        task = {
          taskId: String(t.task_id),
          status: String(t.status),
          blockedReason: t.blocked_reason === null ? null : String(t.blocked_reason),
          currentClaimId: t.current_claim_id === null ? null : String(t.current_claim_id),
          orcaTaskId: t.orca_task_id === null ? null : String(t.orca_task_id),
        };
      }
    }
    let claim: OperationShowResult['claim'] = null;
    if (linkage.claimId !== null) {
      const ctx = tryLoadClaimContext(db, linkage.claimId);
      if (ctx !== null) {
        claim = {
          claimId: ctx.claimId,
          status: ctx.claimStatus,
          dispatchId: ctx.dispatchId,
          workspaceId: ctx.workspaceId,
        };
      }
    }
    return { operation: op, linkage, task, claim, externalFacts: facts };
  }

  // -------------------------------------------------------------------------
  // operationResume
  // -------------------------------------------------------------------------

  async function operationResume(input: ResumeInput): Promise<ResumeResult> {
    const op = loadOperation(db, input.operationId);
    const linkage = parseLinkage(db, op);

    if (input.action === 'verify-external') {
      requireResumableStatus(op);
      const facts = await gatherExternalFacts(deps, db, linkage);
      const { classification, reason } = classify(linkage.category, facts);
      const verificationId = VERIFICATION_ID_PREFIX + randomBytes(12).toString('base64url');
      const checkedAt = new Date().toISOString();
      const payload = {
        verificationId,
        operationId: op.operationId,
        requestId: op.requestId,
        category: linkage.category,
        classification,
        reason,
        facts,
        checkedAt,
      };
      const json = JSON.stringify(payload);
      db.prepare(
        'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(linkage.taskId, RECOVERY_EVENT_TYPES.verification, input.session, json, sha256Hex(json), checkedAt);
      return {
        action: 'verify-external',
        verificationId,
        operationId: op.operationId,
        category: linkage.category,
        classification,
        reason,
        facts,
        checkedAt,
      };
    }

    if (input.action === 'confirm-done') {
      const prior = findDisposition(db, RECOVERY_EVENT_TYPES.confirmed, op.operationId);
      if (prior !== undefined) {
        return {
          action: 'confirm-done',
          operationId: op.operationId,
          category: linkage.category,
          idempotentReplay: true,
          summary: (prior['summary'] as Record<string, unknown>) ?? {},
        };
      }
      requireResumableStatus(op);
      const verification = requireVerification(op, input, 'confirm-done', 'EXTERNAL_DONE');
      const summary = await confirmDownstream(op, linkage, verification);
      settleOperationStatus(db, op.operationId, 'CONFIRMED', 'confirm-done');
      recordDisposition(RECOVERY_EVENT_TYPES.confirmed, op, linkage, input.session, summary);
      return { action: 'confirm-done', operationId: op.operationId, category: linkage.category, idempotentReplay: false, summary };
    }

    // mark-failed-retryable
    const prior = findDisposition(db, RECOVERY_EVENT_TYPES.markedFailed, op.operationId);
    if (prior !== undefined) {
      return {
        action: 'mark-failed-retryable',
        operationId: op.operationId,
        category: linkage.category,
        idempotentReplay: true,
        summary: (prior['summary'] as Record<string, unknown>) ?? {},
      };
    }
    requireResumableStatus(op);
    const verification = requireVerification(op, input, 'mark-failed-retryable', 'EXTERNAL_ABSENT');
    const summary = await markFailedDownstream(op, linkage, verification, input.session);
    settleOperationStatus(db, op.operationId, 'FAILED', 'mark-failed-retryable');
    recordDisposition(RECOVERY_EVENT_TYPES.markedFailed, op, linkage, input.session, summary);
    return { action: 'mark-failed-retryable', operationId: op.operationId, category: linkage.category, idempotentReplay: false, summary };
  }

  function requireVerification(
    op: OperationRow,
    input: ResumeInput,
    action: 'confirm-done' | 'mark-failed-retryable',
    expected: ExternalClassification,
  ): VerificationRecord {
    if (input.verificationRef === undefined || input.verificationRef.length === 0) {
      throw new GovError('E_RECOVERY_UNVERIFIED', `${action} 必须附带本操作的 verify-external 回执引用`);
    }
    const record = findVerification(db, input.verificationRef, op.operationId);
    if (record === undefined) {
      throw new GovError(
        'E_RECOVERY_UNVERIFIED',
        `查明回执不存在或不属于该操作(${input.verificationRef} / ${op.operationId})`,
      );
    }
    if (record.classification !== expected) {
      throw new GovError(
        'E_RECOVERY_UNVERIFIED',
        `查明结论为 ${record.classification}(${record.reason})，不可 ${action}(需 ${expected})`,
      );
    }
    return record;
  }

  function recordDisposition(
    type: string,
    op: OperationRow,
    linkage: OperationLinkage,
    session: string,
    summary: Record<string, unknown>,
  ): void {
    // task_id 可空：信封级等无任务关联的处置也留档（与查明回执同口径）。
    const json = JSON.stringify({ operationId: op.operationId, requestId: op.requestId, category: linkage.category, summary });
    db.prepare(
      'INSERT INTO events (task_id, type, actor, payload_json, payload_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(linkage.taskId, type, session, json, sha256Hex(json), new Date().toISOString());
  }

  // -- confirm-done 的下游（分类必须已判 DONE；副作用绝不重复） -----------------

  async function confirmDownstream(
    op: OperationRow,
    linkage: OperationLinkage,
    verification: VerificationRecord,
  ): Promise<Record<string, unknown>> {
    if (linkage.category === 'merge-confirm') {
      return settleConfirmedMerge(linkage, verification);
    }
    if (linkage.category === 'envelope') {
      throw new GovError(
        'E_RECOVERY_UNVERIFIED',
        '信封级操作无法机械连线外部事实（分类必为 UNKNOWN），请对 claim:/merge: 步骤操作逐段恢复',
      );
    }
    if (linkage.claimId === null || linkage.taskId === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `认领链操作缺任务/认领关联: ${op.requestId}`);
    }
    const claim = loadClaimContext(db, linkage.claimId);
    if (claim.claimStatus !== 'UNCERTAIN') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `认领状态 ${claim.claimStatus} 不可查明恢复(须 UNCERTAIN): ${claim.claimId}`,
      );
    }
    switch (linkage.category) {
      case 'claim-workspace':
      case 'claim-env':
      case 'claim-trust':
        return resumePreparation(claim, linkage.category, verification);
      case 'claim-worker-start':
        return adoptDiscoveredDispatch(claim, verification);
      case 'claim-accept-writable':
        return resumeAcceptedClaim(claim);
      default:
        throw new GovError('E_RECOVERY_STATE_INVALID', `未知恢复类别: ${linkage.category}`);
    }
  }

  /**
   * mid-prepare 续跑：已查明资源不重建（workspace/env 按查明事实修复库内行），
   * 从下一阶段续跑 trust / worker-start，再补完 claim+accept 等价收尾
   * （setWritable → UNCERTAIN→ACTIVE → 任务 accept）。续跑中新不确定仍置回
   * UNCERTAIN 由人工再查明；确定失败保留已查明资源、认领留 UNCERTAIN 转人工。
   */
  async function resumePreparation(
    claim: ClaimContext,
    category: OperationCategory,
    verification: VerificationRecord,
  ): Promise<Record<string, unknown>> {
    const task = db.prepare('SELECT status, orca_task_id FROM tasks WHERE task_id = ?').get(claim.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${claim.taskId}`);
    }
    if (String(task.status) !== 'DECLARED') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${String(task.status)} 不可续跑准备(须 DECLARED): ${claim.taskId}`,
      );
    }
    const spec = loadDeclaredSpec(db, claim.taskId, deps.config);
    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    if (repo === undefined) {
      throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在配置中: ${spec.repoId}`);
    }
    const wsRoot = join(repo.hostPath, '.gov-workspaces');
    const ledger = createResumeLedger(db, claim.claimId);
    const taskDirRel = `${slugify(claim.claimId)}-w`;

    // 库内工作区行修复：workspace 阶段查明时行尚未写入；env 阶段查明时行已在。
    let workspaceId = claim.workspaceId;
    let hostPath = claim.workspaceHostPath;
    let jjName = claim.workspaceName;
    if (category === 'claim-workspace') {
      const w = verification.facts.workspace;
      if (w === null || !w.registered || w.name === null) {
        throw new GovError('E_RECOVERY_UNVERIFIED', 'workspace 查明事实缺失，拒绝续跑');
      }
      jjName = w.name;
      const listed = await deps.jj.workspaceList();
      const entry = listed.workspaces.find((e) => e.name === jjName);
      hostPath = entry?.path ?? hostPath;
      workspaceId = `gws_${randomBytes(12).toString('base64url')}`;
      db.prepare(
        'INSERT INTO workspaces (workspace_id, jj_workspace_name, host_path, base_commit_id) VALUES (?, ?, ?, ?)',
      ).run(workspaceId, jjName, hostPath, spec.baseCommitId);
    }

    // env 阶段：查明存在 → 把发现的容器写回工作区行；未到该阶段 → 真实续跑创建。
    if (hostPath === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `认领缺工作区路径，无法续跑: ${claim.claimId}`);
    }
    let envInstanceId = claim.envInstanceId;
    if (category === 'claim-env') {
      const e = verification.facts.env;
      if (e === null || e.envInstanceId === null) {
        throw new GovError('E_RECOVERY_UNVERIFIED', 'env 查明事实缺失，拒绝续跑');
      }
      envInstanceId = e.envInstanceId;
      db.prepare('UPDATE workspaces SET env_instance_id = ?, env_status = ? WHERE workspace_id = ?').run(
        envInstanceId,
        'running',
        workspaceId,
      );
    } else if (category === 'claim-workspace' && workspaceId !== null) {
      const envOp = ledger.begin('env', { workspaceId, taskDirRel });
      try {
        mkdirSync(join(hostPath, taskDirRel), { recursive: true });
        const created = await withStepTimeout(
          deps.env.create({ workspaceHostPath: hostPath, taskDirRel }),
          stepTimeoutMs,
          'resume_env_create',
        );
        envInstanceId = created.envInstanceId;
        db.prepare('UPDATE workspaces SET env_instance_id = ?, env_status = ? WHERE workspace_id = ?').run(
          envInstanceId,
          'running',
          workspaceId,
        );
        ledger.confirm(envOp, 'env', { envInstanceId, taskDirRel });
      } catch (err) {
        return resumeStageFailure(ledger, envOp, 'env', claim, err, 'env');
      }
    }

    // trust 阶段：查明条目存在 → 跳过；否则幂等续跑（已信任不写盘）。
    if (category !== 'claim-trust') {
      const trustOp = ledger.begin('trust', { workspaceId, hostPath });
      try {
        await withStepTimeout(trustProvision(hostPath), stepTimeoutMs, 'resume_trust');
        ledger.confirm(trustOp, 'trust', { hostPath });
      } catch (err) {
        return resumeStageFailure(ledger, trustOp, 'trust', claim, err, 'trust');
      }
    }

    // worker-start：同任务尝试上限沿用 T3.1 口径；成功回执补记尝试事件。
    const attemptsBefore = countWorkerStartAttempts(db, claim.taskId);
    if (attemptsBefore >= WORKER_START_RETRY_LIMIT) {
      throw new GovError(
        'E_CLAIM_RETRY_EXHAUSTED',
        `同任务 worker 启动尝试已达上限 ${WORKER_START_RETRY_LIMIT}，转人工: ${claim.taskId}`,
      );
    }
    const attempt = attemptsBefore + 1;
    const wsOp = ledger.begin('worker-start', {
      task: String(task.orca_task_id),
      worktree: `path:${hostPath}`,
      attempt,
      resumedFrom: category,
    });
    let receipt: WorkerStartReceipt;
    try {
      const started = await withStepTimeout(
        deps.orca.workerStart({
          task: String(task.orca_task_id),
          worktree: `path:${hostPath}`,
          agent: spec.agentPolicy.executor,
        }),
        stepTimeoutMs,
        'resume_worker_start',
      );
      receipt = started.raw;
    } catch (err) {
      recordTaskEvent(db, claim.taskId, CLAIM_EVENT_TYPES.workerStartAttempt, 'recovery', {
        claimId: claim.claimId,
        attempt,
        dispatchId: null,
        state: 'error',
        failedStage: null,
        retryOf: null,
        errorCode: err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED',
      });
      return resumeStageFailure(ledger, wsOp, 'worker-start', claim, err, 'worker_start');
    }
    recordTaskEvent(db, claim.taskId, CLAIM_EVENT_TYPES.workerStartAttempt, 'recovery', {
      claimId: claim.claimId,
      attempt,
      dispatchId: receipt.dispatchId,
      state: receipt.state,
      failedStage: receipt.failedStage ?? null,
      retryOf: null,
    });
    if (!isWorkerStartReady(receipt)) {
      const note = `state=${receipt.state}${receipt.failedStage !== undefined ? ` failedStage=${receipt.failedStage}` : ''}`;
      ledger.fail(wsOp, 'worker-start', 'E_CLAIM_PREP_FAILED', `续跑 worker 启动失败(${note})`);
      if (isTrustGateFailure(receipt)) {
        db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
          'trust_gate',
          new Date().toISOString(),
          claim.taskId,
        );
      }
      // 认领留 UNCERTAIN：已查明的资源不销毁（人工证实过），处置走 mark-failed 或再次查明。
      throw new GovError('E_CLAIM_PREP_FAILED', `续跑 worker 启动失败(${note})，认领保持 UNCERTAIN 转人工`);
    }
    ledger.confirm(wsOp, 'worker-start', {
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      state: receipt.state,
    });

    return finalizeResumedClaim(claim, {
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      workspaceId,
      envInstanceId: envInstanceId ?? '',
    });
  }

  /** 续跑阶段失败：不确定回 UNCERTAIN（人工再查明）；确定失败保留资源转人工。 */
  function resumeStageFailure(
    ledger: ResumeLedger,
    operationId: string,
    stage: string,
    claim: ClaimContext,
    err: unknown,
    stepName: string,
  ): never {
    const message = errorMessage(err);
    if (isUncertainOutcome(err)) {
      ledger.uncertain(operationId, stage, message);
      throw new GovError('E_CLAIM_UNCERTAIN', `续跑结果不确定(阶段 ${stepName})，认领保持 UNCERTAIN: ${message}`);
    }
    ledger.fail(operationId, stage, err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED', message);
    throw new GovError(
      'E_CLAIM_PREP_FAILED',
      `续跑失败(阶段 ${stepName}，已查明资源保留，认领保持 UNCERTAIN 转人工): ${message}`,
    );
  }

  /** 查明派工收养：无回执但外部已 ready 的派工直接补齐账面并恢复执行。 */
  async function adoptDiscoveredDispatch(
    claim: ClaimContext,
    verification: VerificationRecord,
  ): Promise<Record<string, unknown>> {
    const d = verification.facts.dispatch;
    const found = d?.dispatches[0];
    if (d === null || d.dispatches.length !== 1 || found === undefined) {
      throw new GovError('E_RECOVERY_UNVERIFIED', 'dispatch 查明事实非唯一，拒绝收养');
    }
    const attempts = countWorkerStartAttempts(db, claim.taskId);
    if (attempts >= WORKER_START_RETRY_LIMIT) {
      throw new GovError(
        'E_CLAIM_RETRY_EXHAUSTED',
        `同任务 worker 启动尝试已达上限 ${WORKER_START_RETRY_LIMIT}，转人工: ${claim.taskId}`,
      );
    }
    recordTaskEvent(db, claim.taskId, CLAIM_EVENT_TYPES.workerStartAttempt, 'recovery', {
      claimId: claim.claimId,
      attempt: countWorkerStartAttempts(db, claim.taskId) + 1,
      dispatchId: found.dispatchId,
      state: found.state,
      failedStage: null,
      retryOf: null,
      adopted: true,
    });
    const ctx = loadClaimContext(db, claim.claimId);
    return finalizeResumedClaim(claim, {
      dispatchId: found.dispatchId,
      terminalHandle: found.terminalHandle,
      workspaceId: ctx.workspaceId,
      envInstanceId: ctx.envInstanceId ?? '',
    });
  }

  /** accept-writable 查明已可写：UNCERTAIN→ACTIVE + 任务 accept（原地恢复）。 */
  async function resumeAcceptedClaim(claim: ClaimContext): Promise<Record<string, unknown>> {
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(claim.taskId);
    if (task === undefined || String(task.status) !== 'DECLARED') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${String(task?.status ?? '?')} 与 accept 恢复不符(须 DECLARED): ${claim.taskId}`,
      );
    }
    const transition = applyTaskTransition(db, claim.taskId, 'accept', {
      actor: 'recovery',
      payload: { claimId: claim.claimId, recovered: true },
    });
    applyClaimTransition(db, claim.claimId, 'ACTIVE');
    return {
      claimId: claim.claimId,
      claimStatus: 'ACTIVE',
      taskStatus: transition.to,
      recovered: 'accept-writable',
    };
  }

  /** 补完 claim+accept 等价收尾：切可写（幂等 chmod）→ 认领 ACTIVE → 任务 accept。 */
  async function finalizeResumedClaim(
    claim: ClaimContext,
    facts: {
      readonly dispatchId: string;
      readonly terminalHandle: string | null;
      readonly workspaceId: string | null;
      readonly envInstanceId: string;
    },
  ): Promise<Record<string, unknown>> {
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(claim.taskId);
    if (task === undefined || String(task.status) !== 'DECLARED') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${String(task?.status ?? '?')} 不可收尾续跑(须 DECLARED): ${claim.taskId}`,
      );
    }
    const spec = loadDeclaredSpec(db, claim.taskId, deps.config);

    const stage = `accept-writable:${countAcceptWritableSteps(db, claim.claimId) + 1}`;
    const ledger = createStepLedger(db, claim.claimId);
    const opId = ledger.begin(stage, { claimId: claim.claimId, envInstanceId: facts.envInstanceId, resumed: true });
    try {
      await withStepTimeout(deps.env.setWritable(facts.envInstanceId), stepTimeoutMs, stage);
    } catch (err) {
      const message = errorMessage(err);
      if (isUncertainOutcome(err)) {
        ledger.uncertain(opId, stage, message);
        throw new GovError('E_CLAIM_UNCERTAIN', `续跑切可写结果不确定: ${message}`);
      }
      ledger.fail(opId, stage, 'E_ENV_SWITCH_FAILED', message);
      throw new GovError('E_ENV_SWITCH_FAILED', `续跑切可写失败(认领保持 UNCERTAIN 转人工): ${message}`);
    }
    ledger.confirm(opId, stage, { envInstanceId: facts.envInstanceId });

    const issued = withTransaction(db, (tx) => {
      applyClaimTransition(tx, claim.claimId, 'ACTIVE');
      const token = issueToken(tx, {
        role: 'executor',
        taskId: claim.taskId,
        claimId: claim.claimId,
        ttlSeconds: spec.budget.maxWallSeconds,
      });
      tx.prepare(
        'UPDATE claims SET dispatch_id = ?, terminal_handle = ?, token_hash = ?, workspace_id = ?, updated_at = ? WHERE claim_id = ?',
      ).run(facts.dispatchId, facts.terminalHandle, sha256Hex(token.token), facts.workspaceId, new Date().toISOString(), claim.claimId);
      tx.prepare('UPDATE tasks SET current_claim_id = ?, blocked_reason = NULL, updated_at = ? WHERE task_id = ?').run(
        claim.claimId,
        new Date().toISOString(),
        claim.taskId,
      );
      return token;
    });
    const transition = applyTaskTransition(db, claim.taskId, 'accept', {
      actor: 'recovery',
      payload: { claimId: claim.claimId, recovered: true },
    });
    return {
      claimId: claim.claimId,
      claimStatus: 'ACTIVE',
      taskStatus: transition.to,
      dispatchId: facts.dispatchId,
      envInstanceId: facts.envInstanceId,
      executorToken: issued.token,
      executorCapabilityId: issued.capabilityId,
    };
  }

  /** 合并查明 DONE：只补账（merges 行 + 任务 MERGED），绝不二次移动 bookmark。 */
  function settleConfirmedMerge(
    linkage: OperationLinkage,
    verification: VerificationRecord,
  ): Record<string, unknown> {
    if (linkage.taskId === null || linkage.submissionId === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', '合并操作缺任务/提交关联');
    }
    const b = verification.facts.bookmark;
    if (b === null || b.current === null || b.to === null || b.current !== b.to) {
      throw new GovError('E_RECOVERY_UNVERIFIED', 'bookmark 查明事实与合并提交不一致，拒绝补账');
    }
    const task = db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(linkage.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${linkage.taskId}`);
    }
    if (String(task.status) === 'MERGED') {
      return { taskId: linkage.taskId, taskStatus: 'MERGED', idempotentReplay: true };
    }
    if (String(task.status) !== 'APPROVED') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${String(task.status)} 不可合并补账(须 APPROVED): ${linkage.taskId}`,
      );
    }
    const mergeId = MERGE_ID_PREFIX + randomBytes(12).toString('base64url');
    const confirmedAt = new Date().toISOString();
    try {
      db.prepare(
        `INSERT INTO merges (merge_id, submission_id, target_bookmark, expected_target_commit, result_commit, confirmed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(mergeId, linkage.submissionId, b.bookmark, b.expected ?? b.current, b.to, confirmedAt);
    } catch (err) {
      if (!errorMessage(err).includes('UNIQUE')) {
        throw err;
      }
      // 崩断重入：合并行已存在则复用。
    }
    db.prepare('UPDATE tasks SET merged_commit_id = ?, updated_at = ? WHERE task_id = ?').run(b.to, confirmedAt, linkage.taskId);
    applyTaskTransition(db, linkage.taskId, 'merge_confirmed', {
      actor: 'recovery',
      payload: { mergeId, submissionId: linkage.submissionId, bookmark: b.bookmark, from: b.expected ?? b.current, to: b.to, recovered: true },
    });
    db.prepare('UPDATE tasks SET blocked_reason = NULL, updated_at = ? WHERE task_id = ? AND blocked_reason = ?').run(
      new Date().toISOString(),
      linkage.taskId,
      'merge_uncertain',
    );
    return { taskId: linkage.taskId, taskStatus: 'MERGED', mergeId, bookmarkMovedAgain: false };
  }

  // -- mark-failed-retryable 的下游（分类必须已判 ABSENT） ---------------------

  async function markFailedDownstream(
    op: OperationRow,
    linkage: OperationLinkage,
    verification: VerificationRecord,
    session: string,
  ): Promise<Record<string, unknown>> {
    if (linkage.category === 'merge-confirm') {
      if (linkage.taskId === null) {
        throw new GovError('E_RECOVERY_STATE_INVALID', '合并操作缺任务关联');
      }
      db.prepare('UPDATE tasks SET blocked_reason = NULL, updated_at = ? WHERE task_id = ? AND blocked_reason = ?').run(
        new Date().toISOString(),
        linkage.taskId,
        'merge_uncertain',
      );
      return {
        taskId: linkage.taskId,
        disposition: 'merge_uncertain_cleared',
        retry: '换新 requestId 重走 completeTask（confirmMerge 自动递增 attempt 键）',
      };
    }
    if (linkage.category === 'envelope') {
      throw new GovError(
        'E_RECOVERY_UNVERIFIED',
        '信封级操作无法机械连线外部事实（分类必为 UNKNOWN），请对 claim:/merge: 步骤操作逐段恢复',
      );
    }
    if (linkage.claimId === null || linkage.taskId === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `认领链操作缺任务/认领关联: ${op.requestId}`);
    }
    const claim = loadClaimContext(db, linkage.claimId);
    if (claim.claimStatus !== 'UNCERTAIN') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `认领状态 ${claim.claimStatus} 不可标记失败(须 UNCERTAIN): ${claim.claimId}`,
      );
    }

    // 旧 writer 结算纪律：DISPATCHED 后中断的认领可能持有派工（accept-writable 场景）。
    let settlement: DispatchSettlementOutcome | null = null;
    if (claim.dispatchId !== null) {
      settlement = await settleDispatchWithEvidence(linkage.taskId, claim.dispatchId, session);
      // 结算后即释放派工台账（cleanup 的 dispatch 项动作同款；失败不阻断 FENCE）。
      try {
        await withStepTimeout(deps.orca.workerRelease(claim.dispatchId), stepTimeoutMs, 'recovery_worker_release');
      } catch {
        // 释放失败由清理台账兜底：认领侧资源在任务收尾清理时再执行 dispatch 项。
      }
    }

    applyClaimTransition(db, claim.claimId, 'FENCED');
    const revoked = db
      .prepare('UPDATE capabilities SET revoked_at = ? WHERE claim_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), claim.claimId);
    recordTaskEvent(db, linkage.taskId, CLAIM_EVENT_TYPES.released, session, {
      claimId: claim.claimId,
      stage: 'recovery_marked_failed',
      fenced: true,
      revokedCapabilities: Number(revoked.changes),
      verificationId: verification.verificationId,
    });

    // 已存在的准备资源直接回收（查明为 ABSENT 的那一段本就无外部资源）。
    const cleanupErrors = await cleanupPreparedResources(claim);
    return {
      claimId: claim.claimId,
      disposition: 'FENCED',
      revokedCapabilities: Number(revoked.changes),
      settlement,
      cleanupErrors,
      retry: '任务回可认领面后换新 requestId 重走 claim',
    };
  }

  /** 准备期资源的直接回收：env 销毁 + jj 注销 + 目录删除（路径在锁定根内才删）。 */
  async function cleanupPreparedResources(claim: ClaimContext): Promise<string[]> {
    const errors: string[] = [];
    const ctx = loadClaimContext(db, claim.claimId);
    let envSettled = false;
    if (ctx.envInstanceId !== null) {
      try {
        await withStepTimeout(deps.env.destroy(ctx.envInstanceId), stepTimeoutMs, 'recovery_destroy_env');
        envSettled = true;
      } catch (err) {
        errors.push(`env.destroy(${ctx.envInstanceId}): ${errorMessage(err)}`);
      }
    }
    if (ctx.workspaceName !== null) {
      try {
        await withStepTimeout(deps.jj.workspaceForget(ctx.workspaceName), stepTimeoutMs, 'recovery_forget_ws');
      } catch (err) {
        if (!/No workspace named/i.test(errorMessage(err))) {
          errors.push(`jj.workspaceForget(${ctx.workspaceName}): ${errorMessage(err)}`);
        }
      }
    }
    const spec = loadDeclaredSpec(db, claim.taskId, deps.config);
    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    const wsRoot = repo === undefined ? undefined : join(repo.hostPath, '.gov-workspaces');
    if (wsRoot !== undefined && ctx.workspaceHostPath !== null) {
      const hostPath = ctx.workspaceHostPath;
      if (hostPath === wsRoot || hostPath.startsWith(`${wsRoot}/`)) {
        rmSync(hostPath, { recursive: true, force: true });
      }
    }
    if (ctx.workspaceId !== null) {
      db.prepare('UPDATE workspaces SET env_status = ?, cleanup_status = ? WHERE workspace_id = ?').run(
        envSettled ? null : ctx.envInstanceId === null ? null : 'uncertain',
        'released',
        ctx.workspaceId,
      );
    }
    return errors;
  }

  // -------------------------------------------------------------------------
  // 派工结算（替换/作废共用）：先判活，再取结算回执；无回执不重派
  // -------------------------------------------------------------------------

  /** worker 仍存活即拒绝替换/收尾——旧 writer 未结算前不得动认领。 */
  async function assertWriterNotAlive(taskId: string, dispatchId: string): Promise<void> {
    try {
      const shown = await withStepTimeout(deps.orca.workerShow(dispatchId), stepTimeoutMs, 'recovery_writer_show');
      if (LIVE_WORKER_STATES.has(shown.raw.worker.state)) {
        throw new GovError(
          'E_RECOVERY_WRITER_ALIVE',
          `旧 writer 仍存活(worker.state=${shown.raw.worker.state})，先结算再替换: ${dispatchId}`,
        );
      }
    } catch (err) {
      if (err instanceof GovError && err.code === 'E_RECOVERY_WRITER_ALIVE') {
        throw err;
      }
      // workerShow 本身失败：判活无结论，交结算段以回执为准。
    }
  }

  async function settleDispatchWithEvidence(
    taskId: string,
    dispatchId: string,
    session: string,
  ): Promise<DispatchSettlementOutcome> {
    try {
      const stopped = await withStepTimeout(deps.orca.workerStop(dispatchId), stepTimeoutMs, 'recovery_worker_stop');
      const receipt: DispatchSettlementOutcome = {
        dispatchId,
        state: stopped.raw.state,
        alreadySettled: stopped.raw.alreadySettled ?? null,
        processAction: stopped.raw.processAction ?? null,
        via: 'stop',
      };
      recordTaskEvent(db, taskId, RECOVERY_EVENT_TYPES.dispatchSettled, session, { ...receipt });
      return receipt;
    } catch (err) {
      const message = errorMessage(err);
      if (isUncertainOutcome(err)) {
        // 正面退出证据才可 abandon：workerShow 显示已非运行（merges.ts 同口径）。
        try {
          const shown = await withStepTimeout(deps.orca.workerShow(dispatchId), stepTimeoutMs, 'recovery_worker_show');
          if (shown.raw.worker.state !== 'running' && !LIVE_WORKER_STATES.has(shown.raw.worker.state)) {
            const abandoned = await withStepTimeout(deps.orca.workerAbandon(dispatchId), stepTimeoutMs, 'recovery_worker_abandon');
            const receipt: DispatchSettlementOutcome = {
              dispatchId,
              state: abandoned.raw.state,
              alreadySettled: abandoned.raw.alreadySettled ?? null,
              processAction: abandoned.raw.processAction ?? null,
              via: 'abandon',
            };
            recordTaskEvent(db, taskId, RECOVERY_EVENT_TYPES.dispatchSettled, session, { ...receipt });
            return receipt;
          }
        } catch (evidenceErr) {
          throw new GovError(
            'E_RECOVERY_STATE_INVALID',
            `派工结算无回执且退出证据不可得(stop: ${message}; evidence: ${errorMessage(evidenceErr)})，拒绝继续`,
          );
        }
        throw new GovError(
          'E_RECOVERY_STATE_INVALID',
          `派工结算无回执且 worker 显示仍存活(${dispatchId})，拒绝继续`,
        );
      }
      const orcaCode = (err as { detail?: { orcaErrorCode?: string } } | null)?.detail?.orcaErrorCode ?? '';
      if (DISPATCH_GONE_HINTS.some((hint) => orcaCode.includes(hint) || message.includes(hint))) {
        const receipt: DispatchSettlementOutcome = {
          dispatchId,
          state: 'gone',
          alreadySettled: null,
          processAction: null,
          via: 'gone',
        };
        recordTaskEvent(db, taskId, RECOVERY_EVENT_TYPES.dispatchSettled, session, { ...receipt });
        return receipt;
      }
      throw err instanceof GovError
        ? err
        : new GovError('E_RECOVERY_STATE_INVALID', `派工结算失败(${dispatchId}): ${message}`);
    }
  }

  // -------------------------------------------------------------------------
  // §13.14：REVIEW_REQUESTED 上的替换/作废先收口在飞评审
  // -------------------------------------------------------------------------

  async function cancelOpenReview(
    taskId: string,
    session: string,
    reason: 'executor_replaced' | 'task_superseded',
  ): Promise<{ readonly reviewId: string; readonly resourcesDestroyed: number } | null> {
    const submission = latestActiveSubmission(db, taskId);
    if (submission === undefined) {
      return null;
    }
    const row = db
      .prepare(
        'SELECT review_id, verdict, dispatch_id, workspace_id FROM reviews WHERE submission_id = ? ORDER BY rowid DESC LIMIT 1',
      )
      .get(submission.submissionId);
    if (row === undefined) {
      return null;
    }
    const reviewId = String(row.review_id);
    // 已出结论的评审不是「未开始评审」；已作废（review_aborted/superseded 事件
    // 点名该 reviewId）的也不重收口——与 reviews.isReviewDead 同口径。
    let dead = false;
    for (const type of ['review_aborted', 'review_superseded']) {
      const rows = db
        .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
        .all(taskId, type);
      dead ||= rows.some((r) => {
        try {
          const payload = JSON.parse(String(r.payload_json)) as { reviewId?: unknown; oldReviewId?: unknown };
          return payload.reviewId === reviewId || payload.oldReviewId === reviewId;
        } catch {
          return false;
        }
      });
      if (dead) {
        break;
      }
    }
    if (String(row.verdict) !== 'aborted' || dead) {
      return null;
    }
    const dispatchId = row.dispatch_id === null ? null : String(row.dispatch_id);
    if (dispatchId !== null) {
      // 未开始评审的派工先结算（结算失败即中止收口，不留活评审员）。
      await settleDispatchWithEvidence(taskId, dispatchId, session);
    }
    recordTaskEvent(db, taskId, 'review_aborted', session, { reviewId, reason });
    const workspaceId = row.workspace_id === null ? null : String(row.workspace_id);
    let envInstanceId: string | null = null;
    if (workspaceId !== null) {
      const ws = db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(workspaceId);
      envInstanceId = ws?.env_instance_id === null || ws?.env_instance_id === undefined ? null : String(ws.env_instance_id);
    }
    recordCleanupIntent(db, taskId, session, {
      reason,
      review: { reviewId, workspaceId, envInstanceId, dispatchId },
    });
    scheduleCleanup(cleanupDeps(), taskId, { kind: 'review', reviewId }, session);
    // runCleanup 逐项幂等：此处只会执行评审侧登记项；若任务同时挂着未决的认领侧
    // 项，收尾门（enforceClaimGate）会如实抛 E_CLEANUP_FAILED 交人工——§13.14
    // 场景（首轮评审在飞）不出现该并列。
    const run = await runCleanup(cleanupDeps(), { taskId, actor: session });
    return { reviewId, resourcesDestroyed: run.done };
  }

  /** 旧提交作废：复用 task_rebase 的 supersededSubmissionIds 载体（注明 reason）。 */
  function voidSubmissions(taskId: string, session: string, reason: string): readonly string[] {
    const rows = db
      .prepare(
        `SELECT s.submission_id AS sid FROM submissions s JOIN claims c ON s.claim_id = c.claim_id WHERE c.task_id = ?`,
      )
      .all(taskId);
    const superseded = supersededSubmissionIds(db, taskId);
    const ids = rows.map((r) => String(r.sid)).filter((sid) => !superseded.has(sid));
    if (ids.length === 0) {
      return [];
    }
    const spec = loadDeclaredSpec(db, taskId, deps.config);
    const newBase = lastKnownTargetCommit(db, taskId, spec.baseCommitId);
    recordTaskEvent(db, taskId, 'task_rebase', session, {
      reason,
      newBase,
      supersededSubmissionIds: ids,
    });
    return ids;
  }

  // -------------------------------------------------------------------------
  // replaceExecutor
  // -------------------------------------------------------------------------

  async function replaceExecutor(input: { readonly taskId: string; readonly session: string }): Promise<ReplaceExecutorResult> {
    const task = db
      .prepare('SELECT status, orca_task_id, current_claim_id FROM tasks WHERE task_id = ?')
      .get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const status = String(task.status);
    if (!['DECLARED', 'ACTIVE', 'CHANGES_REQUESTED', 'REVIEW_REQUESTED'].includes(status)) {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${status} 不可替换执行者(IN_REVIEW 先等结论或走 cancel；终态任务走 supersede 无意义): ${input.taskId}`,
      );
    }
    const oldClaimId = task.current_claim_id === null ? null : String(task.current_claim_id);
    if (oldClaimId === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `任务无当前认领，无可替换执行者: ${input.taskId}`);
    }
    const oldClaim = db.prepare('SELECT status, dispatch_id FROM claims WHERE claim_id = ?').get(oldClaimId);
    if (oldClaim === undefined) {
      throw new GovError('E_NOT_FOUND', `认领不存在: ${oldClaimId}`);
    }
    const oldStatus = String(oldClaim.status);
    if (!['DISPATCHED', 'ACTIVE', 'UNCERTAIN'].includes(oldStatus)) {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `认领状态 ${oldStatus} 不可替换(PREPARING 由 claim 调用方收口；FENCED/RELEASED 已终结): ${oldClaimId}`,
      );
    }
    const oldDispatchId = oldClaim.dispatch_id === null ? null : String(oldClaim.dispatch_id);

    // 门：旧 writer 存活即拒绝；随后取结算回执（无回执不重派）。
    let settlement: DispatchSettlementOutcome | null = null;
    if (oldDispatchId !== null) {
      await assertWriterNotAlive(input.taskId, oldDispatchId);
      settlement = await settleDispatchWithEvidence(input.taskId, oldDispatchId, input.session);
    }

    // §13.14：REVIEW_REQUESTED 先取消并结算未开始评审、作废旧提交、回 ACTIVE。
    let reviewCancelled: ReplaceExecutorResult['reviewCancelled'] = null;
    let voided: readonly string[] = [];
    if (status === 'REVIEW_REQUESTED') {
      reviewCancelled = await cancelOpenReview(input.taskId, input.session, 'executor_replaced');
      voided = voidSubmissions(input.taskId, input.session, 'executor_replaced');
      applyTaskTransition(db, input.taskId, 'executor_replaced', {
        actor: input.session,
        payload: { oldClaimId, settlement, reviewCancelled: reviewCancelled?.reviewId ?? null },
      });
    }

    applyClaimTransition(db, oldClaimId, 'FENCED');
    const revoked = db
      .prepare('UPDATE capabilities SET revoked_at = ? WHERE claim_id = ? AND revoked_at IS NULL')
      .run(new Date().toISOString(), oldClaimId);
    recordTaskEvent(db, input.taskId, CLAIM_EVENT_TYPES.released, input.session, {
      claimId: oldClaimId,
      stage: 'executor_replaced',
      fenced: true,
      revokedCapabilities: Number(revoked.changes),
    });
    // 旧认领资源登记清理（任务未到收尾面时由台账挂起，收尾时执行）。
    const scheduled = scheduleCleanup(cleanupDeps(), input.taskId, { kind: 'claim', claimId: oldClaimId }, input.session);

    // 重派必须走 retry-of：DECLARED 走既有 claim 服务；已开工任务就地换发新认领。
    if (status === 'DECLARED') {
      const { createClaimService } = await import('./claims.ts');
      const claimService = createClaimService({
        db,
        config: deps.config,
        orca: deps.orca,
        jj: deps.jj,
        env: deps.env,
        trustProvision,
        ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
      });
      const claimed = await claimService.claim(input.session, {
        taskId: input.taskId,
        ...(oldDispatchId !== null ? { retryOf: oldDispatchId } : {}),
      });
      return {
        taskId: input.taskId,
        taskStatus: 'DECLARED',
        oldClaimId,
        newClaimId: claimed.claimId,
        newDispatchId: claimed.dispatchId,
        retryOf: oldDispatchId,
        settlement,
        reviewCancelled,
        voidedSubmissionIds: voided,
        scheduledCleanupItems: scheduled.newlyRegistered.length,
        executorToken: claimed.executorToken,
        executorCapabilityId: claimed.executorCapabilityId,
        claimStatus: 'DISPATCHED',
      };
    }

    const replacement = await dispatchReplacementClaim(input.taskId, input.session, oldDispatchId);
    return {
      taskId: input.taskId,
      taskStatus: String(db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(input.taskId)?.status),
      oldClaimId,
      newClaimId: replacement.claimId,
      newDispatchId: replacement.dispatchId,
      retryOf: oldDispatchId,
      settlement,
      reviewCancelled,
      voidedSubmissionIds: voided,
      scheduledCleanupItems: scheduled.newlyRegistered.length,
      executorToken: replacement.executorToken,
      executorCapabilityId: replacement.executorCapabilityId,
      claimStatus: 'ACTIVE',
    };
  }

  /**
   * 已开工任务的换发认领：T3.1 claim() 的 DECLARED 门不放行 ACTIVE/
   * CHANGES_REQUESTED，故在此以同一口径重建（prepareWorkspace + workerStart
   * retry-of + setWritable → 认领 ACTIVE），任务状态不动。
   */
  async function dispatchReplacementClaim(
    taskId: string,
    session: string,
    retryOf: string | null,
  ): Promise<{
    readonly claimId: string;
    readonly dispatchId: string;
    readonly terminalHandle: string | null;
    readonly executorToken: string;
    readonly executorCapabilityId: string;
  }> {
    const task = db.prepare('SELECT orca_task_id FROM tasks WHERE task_id = ?').get(taskId);
    if (task === undefined || task.orca_task_id === null) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `任务尚未完成 Orca 登记: ${taskId}`);
    }
    const attemptsBefore = countWorkerStartAttempts(db, taskId);
    if (attemptsBefore >= WORKER_START_RETRY_LIMIT) {
      throw new GovError(
        'E_CLAIM_RETRY_EXHAUSTED',
        `同任务 worker 启动尝试已达上限 ${WORKER_START_RETRY_LIMIT}，转人工: ${taskId}`,
      );
    }
    const spec = loadDeclaredSpec(db, taskId, deps.config);
    const repo = deps.config.repos.find((r) => r.repoId === spec.repoId);
    if (repo === undefined) {
      throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在配置中: ${spec.repoId}`);
    }

    const claimId = CLAIM_ID_PREFIX + randomBytes(12).toString('base64url');
    const now = new Date().toISOString();
    db.prepare('INSERT INTO claims (claim_id, task_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
      claimId,
      taskId,
      'PREPARING',
      now,
      now,
    );
    const ledger = createStepLedger(db, claimId);

    let prepared: PreparedWorkspace | undefined;
    try {
      prepared = await prepareWorkspace(
        { db, jj: deps.jj, env: deps.env, config: deps.config, trustProvision, ledger },
        { claimId, spec, repoHostPath: repo.hostPath },
      );
    } catch (err) {
      if (err instanceof GovError && err.code === 'E_CLAIM_UNCERTAIN') {
        applyClaimTransition(db, claimId, 'UNCERTAIN');
        recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.uncertain, session, { claimId, stage: 'replace_prepare' });
        throw err;
      }
      const rollbackErrors: string[] = [];
      if (prepared !== undefined) {
        await prepared.cleanup(rollbackErrors);
      }
      recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.released, session, { claimId, stage: 'replace_prepare', rollbackErrors });
      db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId);
      throw err;
    }

    const attempt = attemptsBefore + 1;
    const wsOp = ledger.begin('worker-start', {
      task: String(task.orca_task_id),
      worktree: `path:${prepared.hostPath}`,
      retryOf,
      attempt,
    });
    let receipt: WorkerStartReceipt;
    try {
      const started = await withStepTimeout(
        deps.orca.workerStart({
          task: String(task.orca_task_id),
          worktree: `path:${prepared.hostPath}`,
          agent: spec.agentPolicy.executor,
          ...(retryOf !== null ? { retryOf } : {}),
        }),
        stepTimeoutMs,
        'replace_worker_start',
      );
      receipt = started.raw;
    } catch (err) {
      const code = err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED';
      const message = errorMessage(err);
      recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.workerStartAttempt, session, {
        claimId,
        attempt,
        dispatchId: null,
        state: 'error',
        failedStage: null,
        retryOf,
        errorCode: code,
      });
      if (isUncertainOutcome(err)) {
        ledger.uncertain(wsOp, 'worker_start', message);
        applyClaimTransition(db, claimId, 'UNCERTAIN');
        recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.uncertain, session, { claimId, stage: 'replace_worker_start' });
        throw new GovError('E_CLAIM_UNCERTAIN', `换发 worker 启动结果不确定: ${message}`);
      }
      ledger.fail(wsOp, 'worker_start', code, message);
      const rollbackErrors: string[] = [];
      await prepared.cleanup(rollbackErrors);
      recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.released, session, { claimId, stage: 'replace_worker_start', rollbackErrors });
      db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId);
      throw new GovError('E_CLAIM_PREP_FAILED', `换发 worker 启动失败(已回滚): ${message}`);
    }
    recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.workerStartAttempt, session, {
      claimId,
      attempt,
      dispatchId: receipt.dispatchId,
      state: receipt.state,
      failedStage: receipt.failedStage ?? null,
      retryOf,
    });
    if (!isWorkerStartReady(receipt)) {
      const note = `state=${receipt.state}${receipt.failedStage !== undefined ? ` failedStage=${receipt.failedStage}` : ''}`;
      ledger.fail(wsOp, 'worker_start', 'E_CLAIM_PREP_FAILED', `换发 worker 启动失败(${note})`);
      const rollbackErrors: string[] = [];
      await prepared.cleanup(rollbackErrors);
      recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.released, session, { claimId, stage: 'replace_worker_start', rollbackErrors });
      db.prepare('DELETE FROM claims WHERE claim_id = ?').run(claimId);
      if (isTrustGateFailure(receipt)) {
        db.prepare('UPDATE tasks SET blocked_reason = ?, updated_at = ? WHERE task_id = ?').run(
          'trust_gate',
          new Date().toISOString(),
          taskId,
        );
      }
      throw new GovError('E_CLAIM_PREP_FAILED', `换发 worker 启动失败(${note}，已回滚，可再次替换)`);
    }
    ledger.confirm(wsOp, 'worker-start', {
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      state: receipt.state,
    });

    const issued = withTransaction(db, (tx) => {
      applyClaimTransition(tx, claimId, 'DISPATCHED');
      const token = issueToken(tx, {
        role: 'executor',
        taskId,
        claimId,
        ttlSeconds: spec.budget.maxWallSeconds,
      });
      tx.prepare(
        'UPDATE claims SET dispatch_id = ?, terminal_handle = ?, claimer_session = ?, token_hash = ?, workspace_id = ?, updated_at = ? WHERE claim_id = ?',
      ).run(receipt.dispatchId, receipt.terminalHandle ?? null, session, sha256Hex(token.token), prepared.workspaceId, new Date().toISOString(), claimId);
      tx.prepare('UPDATE tasks SET current_claim_id = ?, updated_at = ? WHERE task_id = ?').run(claimId, new Date().toISOString(), taskId);
      return token;
    });

    // 已开工任务的换发认领直达 ACTIVE（accept 的 DECLARED 门不可用，等价补完）。
    const stage = `accept-writable:${countAcceptWritableSteps(db, claimId) + 1}`;
    const acceptOp = ledger.begin(stage, { claimId, envInstanceId: prepared.envInstanceId, replaced: true });
    try {
      await withStepTimeout(deps.env.setWritable(prepared.envInstanceId), stepTimeoutMs, stage);
    } catch (err) {
      const message = errorMessage(err);
      if (isUncertainOutcome(err)) {
        ledger.uncertain(acceptOp, stage, message);
        applyClaimTransition(db, claimId, 'UNCERTAIN');
        recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.uncertain, session, { claimId, stage });
        throw new GovError('E_CLAIM_UNCERTAIN', `换发切可写结果不确定: ${message}`);
      }
      ledger.fail(acceptOp, stage, 'E_ENV_SWITCH_FAILED', message);
      applyClaimTransition(db, claimId, 'UNCERTAIN');
      recordTaskEvent(db, taskId, CLAIM_EVENT_TYPES.uncertain, session, { claimId, stage });
      throw new GovError('E_ENV_SWITCH_FAILED', `换发切可写失败(认领已置 UNCERTAIN 转人工): ${message}`);
    }
    ledger.confirm(acceptOp, stage, { envInstanceId: prepared.envInstanceId });
    applyClaimTransition(db, claimId, 'ACTIVE');

    return {
      claimId,
      dispatchId: receipt.dispatchId,
      terminalHandle: receipt.terminalHandle ?? null,
      executorToken: issued.token,
      executorCapabilityId: issued.capabilityId,
    };
  }

  // -------------------------------------------------------------------------
  // supersedeTask
  // -------------------------------------------------------------------------

  async function supersedeTask(input: {
    readonly taskId: string;
    readonly newSpec: unknown;
    readonly session: string;
  }): Promise<SupersedeTaskResult> {
    const task = db.prepare('SELECT status, current_claim_id FROM tasks WHERE task_id = ?').get(input.taskId);
    if (task === undefined) {
      throw new GovError('E_NOT_FOUND', `任务不存在: ${input.taskId}`);
    }
    const status = String(task.status);
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'].includes(status)) {
      throw new GovError('E_RECOVERY_STATE_INVALID', `任务已处终态 ${status}，无替代对象: ${input.taskId}`);
    }
    if (status === 'WAITING_CHILD') {
      // 状态机无 WAITING_CHILD→SUPERSEDED 出边（父子任务归 T4.2），先回 ACTIVE 再替代。
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `WAITING_CHILD 的替代归父子任务收口(T4.2)，当前不可直接替代: ${input.taskId}`,
      );
    }
    if (status === 'APPROVED' || status === 'MERGED') {
      throw new GovError(
        'E_RECOVERY_STATE_INVALID',
        `任务状态 ${status} 已过签核/合并面，走正常完成或 cancel，不走替代: ${input.taskId}`,
      );
    }

    // 新任务版本经 declare（全量校验 + Orca 登记）；范围变化即新版本，不原地改。
    const newSpecPeek = input.newSpec as { taskId?: unknown } | null;
    if (newSpecPeek !== null && typeof newSpecPeek === 'object' && newSpecPeek.taskId === input.taskId) {
      throw new GovError('E_REQUEST_INVALID', `新任务版本必须使用新 taskId(与旧任务同 id): ${input.taskId}`);
    }
    const { declareTask } = await import('./tasks.ts');
    const declared = await declareTask({ db, config: deps.config, orca: deps.orca }, {
      spec: input.newSpec,
      session: input.session,
    });
    if (declared.taskId === input.taskId) {
      throw new GovError('E_REQUEST_INVALID', `新任务版本必须使用新 taskId(与旧任务同 id): ${input.taskId}`);
    }

    // REVIEW_REQUESTED / IN_REVIEW：先取消并结算评审，再迁移。
    let reviewCancelled: SupersedeTaskResult['reviewCancelled'] = null;
    if (status === 'REVIEW_REQUESTED' || status === 'IN_REVIEW') {
      reviewCancelled = await cancelOpenReview(input.taskId, input.session, 'task_superseded');
    }

    // 旧 writer 结算 + 认领 FENCED + 令牌吊销（替代后不得留活写入者）。
    const claimId = task.current_claim_id === null ? null : String(task.current_claim_id);
    let claimFenced: string | null = null;
    if (claimId !== null) {
      const claim = db.prepare('SELECT status, dispatch_id FROM claims WHERE claim_id = ?').get(claimId);
      const claimStatus = claim === undefined ? null : String(claim.status);
      if (claimStatus !== null && ['DISPATCHED', 'ACTIVE', 'UNCERTAIN'].includes(claimStatus)) {
        const dispatchId = claim?.dispatch_id === null || claim?.dispatch_id === undefined ? null : String(claim.dispatch_id);
        if (dispatchId !== null) {
          await assertWriterNotAlive(input.taskId, dispatchId);
          await settleDispatchWithEvidence(input.taskId, dispatchId, input.session);
        }
        if (claimStatus === 'PREPARING') {
          applyClaimTransition(db, claimId, 'UNCERTAIN');
        }
        applyClaimTransition(db, claimId, 'FENCED');
        db.prepare('UPDATE capabilities SET revoked_at = ? WHERE claim_id = ? AND revoked_at IS NULL').run(
          new Date().toISOString(),
          claimId,
        );
        claimFenced = claimId;
      }
    }

    applyTaskTransition(db, input.taskId, 'supersede', {
      actor: input.session,
      payload: { newTaskId: declared.taskId, reviewCancelled: reviewCancelled?.reviewId ?? null, claimFenced },
    });
    recordCleanupIntent(db, input.taskId, input.session, { reason: 'task_superseded' });
    const scheduled = scheduleCleanup(cleanupDeps(), input.taskId, { kind: 'full' }, input.session);
    return {
      oldTaskId: input.taskId,
      newTaskId: declared.taskId,
      newSpecHash: declared.specHash,
      newOrcaTaskId: declared.orcaTaskId,
      oldTaskStatus: 'SUPERSEDED',
      reviewCancelled,
      claimFenced,
      scheduledCleanupItems: scheduled.newlyRegistered.length,
    };
  }

  // -------------------------------------------------------------------------
  // recoverCoordinator
  // -------------------------------------------------------------------------

  async function recoverCoordinator(input: {
    readonly runId: string;
    readonly session: string;
  }): Promise<RecoverCoordinatorResult> {
    // 协调会话无状态：只重绑 Run 并回报事实，gov 数据一律不动（不落事件）。
    const bound = await withStepTimeout(deps.orca.runUse(input.runId), stepTimeoutMs, 'recovery_run_use');
    return {
      runId: bound.raw.run.id,
      objective: bound.raw.run.objective,
      coordinatorHandle: bound.raw.run.coordinator_handle,
      govDataUntouched: true,
    };
  }

  return { operationShow, operationResume, replaceExecutor, supersedeTask, recoverCoordinator };
}

// ---------------------------------------------------------------------------
// api.ts 接线（operation-show / operation-resume；operator 令牌动作）
// ---------------------------------------------------------------------------

const operationShowPayloadSchema = z.strictObject({
  requestId: z.string().min(1),
});

const operationResumePayloadSchema = z.strictObject({
  operationId: z.string().min(1),
  action: z.enum(['verify-external', 'confirm-done', 'mark-failed-retryable']),
  verificationRef: z.string().min(1).optional(),
});

export interface RecoveryHandlersDeps {
  readonly config: GovConfig;
  readonly orca: OrcaSettlementPort & OrcaFactsPort;
  readonly jj: JjMergePort & JjFactsPort;
  readonly env: EnvLifecyclePort;
  readonly envFacts?: EnvFactsPort | undefined;
  readonly runId?: string | undefined;
  readonly trustProvision?: TrustProvision | undefined;
  readonly stepTimeoutMs?: number | undefined;
}

function buildService(deps: RecoveryHandlersDeps, ctx: ActionContext) {
  return createRecoveryService({
    db: ctx.db,
    config: deps.config,
    orca: deps.orca,
    jj: deps.jj,
    env: deps.env,
    ...(deps.envFacts !== undefined ? { envFacts: deps.envFacts } : {}),
    ...(deps.runId !== undefined ? { runId: deps.runId } : {}),
    ...(deps.trustProvision !== undefined ? { trustProvision: deps.trustProvision } : {}),
    ...(deps.stepTimeoutMs !== undefined ? { stepTimeoutMs: deps.stepTimeoutMs } : {}),
  });
}

export function createOperationShowHandler(deps: RecoveryHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = operationShowPayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(operation-show): ${formatZodIssues(parsed.error)}`);
    }
    return buildService(deps, ctx).operationShow({ requestId: parsed.data.requestId });
  };
}

export function createOperationResumeHandler(deps: RecoveryHandlersDeps): ActionHandler {
  return async (ctx: ActionContext) => {
    const parsed = operationResumePayloadSchema.safeParse(ctx.payload);
    if (!parsed.success) {
      throw new GovError('E_REQUEST_INVALID', `payload 校验失败(operation-resume): ${formatZodIssues(parsed.error)}`);
    }
    return buildService(deps, ctx).operationResume({
      operationId: parsed.data.operationId,
      action: parsed.data.action,
      ...(parsed.data.verificationRef !== undefined ? { verificationRef: parsed.data.verificationRef } : {}),
      session: ctx.token.capabilityId,
    });
  };
}
