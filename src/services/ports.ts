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
  WorkerStartReceipt,
} from '../adapters/orca.ts';
import type { createJjAdapter } from '../adapters/jj.ts';
import type {
  createEnvironmentAdapter,
  CreateReceipt,
  DestroyReceipt,
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
