/**
 * T4.1 恢复层集成测试共享夹具（test/integration/recovery/）。
 *
 * 真实面与 lifecycle 夹具同规：真实 jj / Docker / Orca CLI + 临时 gov 库；在其上
 * 追加三类恢复层专用件：
 * 1. SimulatedExit + withFaults——进程中途退出模拟（detail.exitCode='TIMEOUT'
 *    命中 isUncertainOutcome 的「进程可能已产生副作用」口径）。before=副作用
 *    未发生即抛；after=真实执行成功后抛（做了但没回执）。只用于测试夹具。
 * 2. DockerEnvFacts——只读容器事实（docker ps/inspect，无任何写动作）。
 * 3. 恢复层端口拼装——DispatchOrcaShim/CountingJj 补齐 facts 面（runUse/
 *    workerList/workspaceList 走真实适配器；jj 适配器实例经原型链委托取回）。
 *
 * CLAUDE_CONFIG_DIR 指向临时目录：claim 链用真实 createDefaultTrustProvision
 * （trust 阶段的外部事实可查明），Orca 工作树信任种子与 gov 信任互不污染。
 *
 * 环境红线（run3 实证后废除上法）：绝不改写 CLAUDE_CONFIG_DIR 等进程级环境
 * 变量——execFile 默认继承本进程环境，Orca CLI 会把请求侧环境带给其派生的
 * agent；重定向 claude 配置目录会让 agent 以空配置（无凭证）启动，实测即
 * worker-start 信任门 agent_readiness 全灭。gov 信任预置与查明因此直接用默认
 * ~/.claude.json（种子键由 removeClaudeWorkspaceTrustSeeds 按临时路径前缀清除）。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import { createDefaultTrustProvision } from '../../../src/services/workspaces.ts';
import { createClaimService, type ClaimResult } from '../../../src/services/claims.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createRecoveryService, type RecoveryService } from '../../../src/services/recovery.ts';
import type { JjAdapter } from '../../../src/adapters/jj.ts';
import type { OrcaAdapter } from '../../../src/adapters/orca.ts';
import type {
  EnvFactsPort,
  JjFactsPort,
  JjMergePort,
  OrcaFactsPort,
  OrcaSettlementPort,
  TrustProvision,
} from '../../../src/services/ports.ts';
import {
  COORD_SESSION,
  createSharedContext,
  DECLARER_SESSION,
  dockerBin,
  dockerPsNames,
  EXEC_SESSION,
  type Rail,
  type SharedContext,
} from '../lifecycle/fixture.ts';

const execFileAsync = promisify(execFile);

export const OPERATOR_RECOVERY_SESSION = 'gov-t41r-op';
export { createSharedContext, COORD_SESSION, DECLARER_SESSION, EXEC_SESSION, dockerPsNames };
export type { Rail, SharedContext };

/**
 * 本目录专用 rail 构建：在 lifecycle buildRail 之上把 repo hostPath 归一到
 * realpath（/tmp → /private/tmp）。lifecycle 的 /tmp 形态会让 reviews.ts/
 * workspaces.ts 回滚删除的 startsWith(wsRoot) 守卫永不命中（hostPath 是
 * realpath、wsRoot 是 /tmp 串）——评审链「撞名回滚后重建」需要目录真被删掉。
 */
export async function buildRail(shared: SharedContext, scenario: string): Promise<Rail> {
  const { buildRail: lifecycleBuildRail } = await import('../lifecycle/fixture.ts');
  const rail = await lifecycleBuildRail(shared, scenario);
  const repo = rail.config.repos[0];
  if (repo !== undefined) {
    repo.hostPath = rail.repoDirReal;
  }
  return rail;
}

// ---------------------------------------------------------------------------
// 故障注入：SimulatedExit + withFaults（仅测试夹具；生产面不存在）
// ---------------------------------------------------------------------------

/** 进程中途退出模拟：exitCode='TIMEOUT' → isUncertainOutcome 判真（可能已产生副作用）。 */
export class SimulatedExit extends Error {
  readonly detail: { readonly exitCode: 'TIMEOUT' };

  constructor(message: string) {
    super(message);
    this.name = 'SimulatedExit';
    this.detail = { exitCode: 'TIMEOUT' };
  }
}

export interface FaultSpec {
  readonly method: string;
  readonly when: 'before' | 'after';
}

/**
 * 单方法一次性故障包装：原型链委托保留其余方法与内部状态；armed 只放一枪，
 * 之后的调用（恢复/重走）落到真实实现——注入只造一次不确定，不污染续跑。
 */
export function withFaults<T extends object>(target: T, spec: FaultSpec): T {
  const wrapper: T = Object.create(target);
  const original = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[spec.method];
  if (typeof original !== 'function') {
    throw new Error(`withFaults: 目标无方法 ${spec.method}`);
  }
  let armed = true;
  (wrapper as unknown as Record<string, unknown>)[spec.method] = async (...args: unknown[]) => {
    if (armed) {
      armed = false;
      if (spec.when === 'before') {
        throw new SimulatedExit(`SIMULATED_EXIT(before) ${spec.method}`);
      }
      await original.apply(target, args);
      throw new SimulatedExit(`SIMULATED_EXIT(after) ${spec.method}`);
    }
    return original.apply(target, args);
  };
  return wrapper;
}

/** trustProvision 是函数不是对象：同语义的一次性故障包装。 */
export function faultedTrustProvision(when: 'before' | 'after'): TrustProvision {
  const inner = createDefaultTrustProvision();
  let armed = true;
  return async (workspaceRealPath: string) => {
    if (armed) {
      armed = false;
      if (when === 'before') {
        throw new SimulatedExit(`SIMULATED_EXIT(before) trustProvision`);
      }
      await inner(workspaceRealPath);
      throw new SimulatedExit(`SIMULATED_EXIT(after) trustProvision`);
    }
    return inner(workspaceRealPath);
  };
}

// ---------------------------------------------------------------------------
// 只读容器事实（docker ps/inspect；无任何写动作）
// ---------------------------------------------------------------------------

function realpathOrNull(p: string): string | null {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

export class DockerEnvFacts implements EnvFactsPort {
  async exists(envId: string): Promise<boolean> {
    return (await dockerPsNames(envId)).length > 0;
  }

  /** 按挂载源反查容器名：/work 与 /work/<rel> 两个挂载的 Source 都指向工作区路径。 */
  async findByWorkspace(workspaceHostPath: string, taskDirRel: string): Promise<string | null> {
    const real = realpathOrNull(workspaceHostPath) ?? workspaceHostPath;
    const names = await dockerPsNames('gov-vm-');
    for (const name of names) {
      let mounts: unknown;
      try {
        const { stdout } = await execFileAsync(
          dockerBin(),
          ['inspect', '--format', '{{json .Mounts}}', name],
          { timeout: 30_000, encoding: 'utf8' },
        );
        mounts = JSON.parse(stdout);
      } catch {
        continue;
      }
      if (!Array.isArray(mounts)) {
        continue;
      }
      const hit = mounts.some((m) => {
        const source = (m as { Source?: unknown }).Source;
        if (typeof source !== 'string') {
          return false;
        }
        return (
          source === workspaceHostPath ||
          source === real ||
          source === join(workspaceHostPath, taskDirRel) ||
          source === join(real, taskDirRel)
        );
      });
      if (hit) {
        return name;
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 恢复层端口拼装：Shim/Counting 包装器补齐 facts 面
// ---------------------------------------------------------------------------

/**
 * DispatchOrcaShim 只有派工/结算面；Run 会话与 worker 清单走真实适配器
 * （真实执行派工都在共享 Run 内，workerList 按 run+task 过滤可唯一发现）。
 */
export class RecoveryOrca implements OrcaSettlementPort, OrcaFactsPort {
  private readonly shim: Rail['orca'];
  private readonly real: OrcaAdapter;

  constructor(shim: Rail['orca'], real: OrcaAdapter) {
    this.shim = shim;
    this.real = real;
  }

  taskCreate(input: Parameters<Rail['orca']['taskCreate']>[0]) {
    return this.shim.taskCreate(input);
  }
  workerStart(input: Parameters<Rail['orca']['workerStart']>[0]) {
    return this.shim.workerStart(input);
  }
  workerStop(dispatch: string) {
    return this.shim.workerStop(dispatch);
  }
  workerShow(dispatch: string) {
    return this.shim.workerShow(dispatch);
  }
  workerAbandon(dispatch: string) {
    return this.shim.workerAbandon(dispatch);
  }
  workerRelease(dispatch: string) {
    return this.shim.workerRelease(dispatch);
  }
  sendToDispatch(input: Parameters<Rail['orca']['sendToDispatch']>[0]) {
    return this.shim.sendToDispatch(input);
  }
  runUse(runId: string) {
    return this.real.runUse(runId);
  }
  runCurrent() {
    return this.real.runCurrent();
  }
  workerList(input?: { readonly run?: string; readonly limit?: number }) {
    return this.real.workerList(input);
  }
}

/** CountingJj 无 workspaceList：原型链委托回真实 jj 适配器（测试夹具内取回私引）。 */
export function recoveryJj(rail: Rail): JjMergePort & JjFactsPort {
  const real = (rail.jj as unknown as { real: JjAdapter }).real;
  const wrapper: JjMergePort & JjFactsPort = Object.create(rail.jj);
  (wrapper as unknown as Record<string, unknown>).workspaceList = () => real.workspaceList();
  return wrapper;
}

export interface RecoveryRailDeps {
  readonly recovery: RecoveryService;
  readonly envFacts: DockerEnvFacts;
}

export function recoveryFor(rail: Rail, shared: SharedContext): RecoveryService {
  return createRecoveryService({
    db: shared.db,
    config: rail.config,
    orca: new RecoveryOrca(rail.orca, shared.orcaReal),
    jj: recoveryJj(rail),
    env: shared.env,
    envFacts: new DockerEnvFacts(),
    runId: shared.runId,
    stepTimeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// 认领链驱动（真实 trust 预置 + 可选故障端口）
// ---------------------------------------------------------------------------

export interface ClaimFaults {
  readonly jj?: object | undefined;
  readonly env?: object | undefined;
  readonly orca?: object | undefined;
  readonly trust?: TrustProvision | undefined;
}

/** C 系列用：declare → claim（真实 trust，外部事实可查明）；faults 为故障注入端口。 */
export async function driveClaimed(
  rail: Rail,
  shared: SharedContext,
  faults: ClaimFaults = {},
): Promise<ClaimResult> {
  await declareTask({ db: shared.db, config: rail.config, orca: rail.orca }, { spec: rail.spec, session: DECLARER_SESSION });
  return claimServiceFor(rail, shared, faults).claim(COORD_SESSION, { taskId: rail.taskId });
}

/** 直接取 claim 服务（接受与续用同一构建口径）。 */
export function claimServiceFor(
  rail: Rail,
  shared: SharedContext,
  faults: ClaimFaults = {},
) {
  return createClaimService({
    db: shared.db,
    config: rail.config,
    orca: (faults.orca as Rail['orca']) ?? rail.orca,
    jj: (faults.jj as Rail['jj']) ?? rail.jj,
    env: (faults.env as SharedContext['env']) ?? shared.env,
    trustProvision: faults.trust ?? createDefaultTrustProvision(),
    stepTimeoutMs: 120_000,
  });
}

// ---------------------------------------------------------------------------
// 查询/断言助手
// ---------------------------------------------------------------------------

export function opRow(db: DatabaseSync, requestId: string): { operationId: string; status: string } {
  const row = db
    .prepare('SELECT operation_id, status FROM operations WHERE request_id = ?')
    .get(requestId);
  if (row === undefined) {
    throw new Error(`操作行缺失: ${requestId}`);
  }
  return { operationId: String(row.operation_id), status: String(row.status) };
}

export async function verifyExternal(
  recovery: RecoveryService,
  operationId: string,
): Promise<{ readonly verificationId: string; readonly classification: string; readonly reason: string }> {
  const result = await recovery.operationResume({
    operationId,
    action: 'verify-external',
    session: OPERATOR_RECOVERY_SESSION,
  });
  if (result.action !== 'verify-external') {
    throw new Error(`预期 verify-external 结果，实际 ${result.action}`);
  }
  return { verificationId: result.verificationId, classification: result.classification, reason: result.reason };
}

