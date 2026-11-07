/**
 * T3.1 服务层端口：声明/认领/接受服务只依赖这些接口。真实 Orca/jj/Docker
 * 适配器（T2.x）结构上满足同形签名，单测注入假适配器逐段伪造与断言；真实
 * 适配器的注入与全链集成归 T6.x。
 *
 * 服务层（services/）禁止 import node:child_process：一切外部动作——CLI、
 * 容器生命周期、宿主信任表——都只经这里的端口发生。这是「外部副作用可在
 * 单测中按阶段中断」的前提，也是错误分类（确定失败 vs 结果不确定）的契约面。
 */
import type {
  createOrcaAdapter,
  TaskReceipt,
  WorkerSettleReceipt,
  WorkerShowReceipt,
  WorkerStartReceipt,
} from '../adapters/orca.ts';
import type { createJjAdapter } from '../adapters/jj.ts';
import type {
  createEnvironmentAdapter,
  CreateReceipt,
  DestroyReceipt,
  ResumeReceipt,
  SuspendReceipt,
  SwitchReceipt,
} from '../adapters/environment.ts';
import { GovError } from '../domain/errors.ts';

/** Orca 端口：declare 登记 Orca 任务，claim 启动 worker（重派带 retryOf）。 */
export interface OrcaPort {
  taskCreate(input: {
    readonly spec: string;
    readonly taskTitle?: string | undefined;
    readonly deps?: readonly string[] | undefined;
    readonly parent?: string | undefined;
  }): Promise<{ ok: true; raw: TaskReceipt }>;
  workerStart(input: {
    readonly task: string;
    readonly worktree: string;
    readonly agent?: string | undefined;
    readonly terminal?: string | undefined;
    readonly retryOf?: string | undefined;
    readonly repo?: string | undefined;
    readonly name?: string | undefined;
  }): Promise<{ ok: true; raw: WorkerStartReceipt }>;
}

/** jj 端口：claim 建 workspace；失败清理 forget（目录由服务层删除）。 */
export interface JjPort {
  workspaceAdd(input: {
    readonly name: string;
    readonly path: string;
    readonly rev?: string | undefined;
  }): Promise<{ ok: true; name: string; path: string; opIds: string[] }>;
  workspaceForget(name: string): Promise<{ ok: true; name: string; opIds: string[] }>;
}

/** 环境端口：claim 建/销一次性容器，accept 切可写/只读。 */
export interface EnvPort {
  create(input: {
    readonly workspaceHostPath: string;
    readonly taskDirRel: string;
  }): Promise<CreateReceipt>;
  setWritable(envId: string): Promise<SwitchReceipt>;
  setReadonly(envId: string): Promise<SwitchReceipt>;
  destroy(envId: string): Promise<DestroyReceipt>;
}

/** 工作区信任预置句柄：cleanup 尽力撤销本次预置写入的增量（幂等）。 */
export interface TrustHandle {
  cleanup(): Promise<void>;
}

/** 向宿主 Claude 配置写入工作区信任条目；已信任则不写盘（幂等）。 */
export type TrustProvision = (workspaceRealPath: string) => Promise<TrustHandle>;

/** worker-start 成功态（T2.1 实测：ready 回执带 terminalHandle、无残留资源）。 */
export function isWorkerStartReady(receipt: WorkerStartReceipt): boolean {
  return receipt.state === 'ready';
}

/**
 * 信任门首死：Orca 回执 state=failed 且 failedStage 落在 agent 就绪/信任阶段。
 * 恢复路径固定为「UI 信任一次 + retryOf 重派」，不允许盲目重试（探针口径）。
 */
export function isTrustGateFailure(receipt: WorkerStartReceipt): boolean {
  const stage = receipt.failedStage;
  return (
    receipt.state === 'failed' &&
    stage !== undefined &&
    (stage === 'agent_readiness' || stage.includes('trust'))
  );
}

/**
 * 结果不确定的外部结局：宿主处理超时（E_TIMEOUT），或适配器子进程被 exec
 * 超时杀死（detail.exitCode='TIMEOUT'——进程可能已在远端产生副作用，调用方
 * 无法判定）。此类错误绝不走回滚路径，只能置 UNCERTAIN 转人工。
 */
export function isUncertainOutcome(err: unknown): boolean {
  if (err instanceof GovError && err.code === 'E_TIMEOUT') {
    return true;
  }
  const detail = (err as { detail?: { exitCode?: unknown } } | null)?.detail;
  return detail !== undefined && detail.exitCode === 'TIMEOUT';
}

// 编译期同形守卫（无运行时作用）：真实 T2.x 适配器必须可直接赋给端口；适配器
// 签名漂移而端口未同步时，typecheck 在此即报错，而不是等到 T6.x 注入现场。
const _orcaAdapterIsPortable: OrcaPort = undefined as unknown as ReturnType<
  typeof createOrcaAdapter
>;
const _jjAdapterIsPortable: JjPort = undefined as unknown as ReturnType<
  typeof createJjAdapter
>;
const _envAdapterIsPortable: EnvPort = undefined as unknown as ReturnType<
  typeof createEnvironmentAdapter
>;
void _orcaAdapterIsPortable;
void _jjAdapterIsPortable;
void _envAdapterIsPortable;

// ---------------------------------------------------------------------------
// T3.2 扩展端口：提交/评审/rebase 服务额外依赖的版本操作、环境暂停恢复与
// 定向消息面。以「extends 基础端口」的方式新增，而不是改基础端口——T3.1 的
// 假适配器（test/unit/claims）只需满足基础端口即可继续编译。
// ---------------------------------------------------------------------------

/**
 * jj 版本操作端口（T2.2 适配器子集）：提交锚定与路径核验（snapshot/diffPaths/
 * conflictList/bookmarkCurrent）与 rebase。签名与真实适配器逐字同形。
 */
export interface JjVersionPort extends JjPort {
  snapshot(dir?: string | undefined): Promise<{
    ok: true;
    commitId: string;
    treeId: string;
    opIds: string[];
  }>;
  diffPaths(
    rev: string,
    ownedPaths: readonly string[],
  ): Promise<{ ok: true; paths: string[] }>;
  conflictList(rev: string): Promise<{ ok: true; conflicts: string[] }>;
  bookmarkCurrent(bookmark: string): Promise<{ ok: true; commitId: string }>;
  rebase(input: {
    readonly rev: string;
    readonly newBase: string;
  }): Promise<{ ok: true; newCommitId: string; conflicts: string[]; opIds: string[] }>;
}

/** 环境生命周期扩展端口：开发环境暂停（进评审）/恢复（退回继续开发）。 */
export interface EnvLifecyclePort extends EnvPort {
  suspend(envId: string): Promise<SuspendReceipt>;
  resume(envId: string): Promise<ResumeReceipt>;
}

/**
 * Orca 消息与结算扩展端口：workerStop 用于评审者换人时停掉被拒候选的派工；
 * sendToDispatch 用于退回意见定向送达执行者。type 白名单在适配器侧强制。
 */
export interface OrcaMessagingPort extends OrcaPort {
  workerStop(dispatch: string): Promise<{ ok: true; raw: unknown }>;
  sendToDispatch(input: {
    readonly dispatch: string;
    readonly type: 'status' | 'merge_ready' | 'question';
    readonly subject: string;
    readonly body: string;
    readonly filesModified?: readonly string[] | undefined;
  }): Promise<{ ok: true; raw: unknown }>;
}

const _jjVersionAdapterIsPortable: JjVersionPort = undefined as unknown as ReturnType<
  typeof createJjAdapter
>;
const _envLifecycleAdapterIsPortable: EnvLifecyclePort = undefined as unknown as ReturnType<
  typeof createEnvironmentAdapter
>;
const _orcaMessagingAdapterIsPortable: OrcaMessagingPort = undefined as unknown as ReturnType<
  typeof createOrcaAdapter
>;
void _jjVersionAdapterIsPortable;
void _envLifecycleAdapterIsPortable;
void _orcaMessagingAdapterIsPortable;

// ---------------------------------------------------------------------------
// T3.3 扩展端口：快进合并（bookmark 移动 + op log 回执）与 Orca 结算面
// （workerShow/workerAbandon/workerRelease）。同样以 extends 追加，不改既有端口。
// ---------------------------------------------------------------------------

/** jj 合并端口（T2.2 适配器子集）：快进移动 bookmark 与 op log 回执。 */
export interface JjMergePort extends JjVersionPort {
  moveBookmarkFF(input: {
    readonly bookmark: string;
    readonly toCommit: string;
    readonly expectedCurrent: string;
  }): Promise<{ ok: true; from: string; to: string; opIds: string[] }>;
  opLogReceipt(n?: number | undefined): Promise<{ ok: true; opIds: string[] }>;
}

/**
 * Orca 结算扩展端口：合并收尾与清理需要读取派工事实（workerShow）、
 * workerAbandon（仅在取得正面退出证据后）与 workerRelease（清理台账的
 * dispatch 项动作）。T2.1 适配器逐字同形。
 */
export interface OrcaSettlementPort extends OrcaMessagingPort {
  /** 收窄基端口的 unknown 回执：合并/清理消费 state/alreadySettled/processAction。 */
  workerStop(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }>;
  workerShow(dispatch: string): Promise<{ ok: true; raw: WorkerShowReceipt }>;
  workerAbandon(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }>;
  workerRelease(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }>;
}

const _jjMergeAdapterIsPortable: JjMergePort = undefined as unknown as ReturnType<
  typeof createJjAdapter
>;
const _orcaSettlementAdapterIsPortable: OrcaSettlementPort = undefined as unknown as ReturnType<
  typeof createOrcaAdapter
>;
void _jjMergeAdapterIsPortable;
void _orcaSettlementAdapterIsPortable;
