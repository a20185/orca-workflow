/**
 * test/unit/claims 共用测试设施：真实迁移库 + 临时仓根 + 三个假适配器端口
 * （Orca/jj/环境）与假信任预置。假适配器按 T2.x 回执形状逐段可脚本化
 * （成功/确定失败/回执失败/信任门/抛错/挂起），供「各准备阶段中断」断言。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import type { GovConfig } from '../../../src/config.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { OrcaAdapterError } from '../../../src/adapters/orca.ts';
import type { WorkerStartReceipt } from '../../../src/adapters/orca.ts';
import type {
  EnvPort,
  JjPort,
  OrcaPort,
  TrustHandle,
  TrustProvision,
} from '../../../src/services/ports.ts';
import type { ClaimHandlersDeps } from '../../../src/services/claims.ts';

export interface FakeHost {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly deps: ClaimHandlersDeps;
  readonly orca: FakeOrca;
  readonly jj: FakeJj;
  readonly env: FakeEnv;
  readonly trust: FakeTrust;
  /** 删除临时仓根与假工作区目录。 */
  dispose(): void;
}

export function openClaimsTestDb(): DatabaseSync {
  const db = openDatabase(':memory:');
  migrate(db);
  return db;
}

export function sampleSpec(overrides: { readonly taskId?: string } = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: overrides.taskId ?? 'gt-unit-claim',
    problem: '为单位测试实现的示例任务',
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不引入新框架'],
    ownedPaths: ['src/a'],
    repoId: 'demo',
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: '1'.repeat(40),
    acceptanceCriteria: [
      {
        type: 'command',
        criterionId: 'cmd-1',
        config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
      },
      {
        type: 'manual',
        criterionId: 'man-1',
        config: { description: '人工核验收尾' },
      },
    ],
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 2, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
  };
}

/** 假宿主：临时仓根（realpath 归一，macOS /tmp 符号链接不干扰清理守卫）+ 全套假端口。 */
export function createFakeHost(options: { readonly stepTimeoutMs?: number } = {}): FakeHost {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-claims-test-'));
  const repoRoot = fs.realpathSync(rawRoot);
  const config: GovConfig = {
    schemaVersion: 1,
    repos: [{ repoId: 'demo', hostPath: path.join(repoRoot, 'repo'), targets: ['main'] }],
  };
  const db = openClaimsTestDb();
  const orca = new FakeOrca();
  const jj = new FakeJj();
  const env = new FakeEnv();
  const trust = new FakeTrust();
  const deps: ClaimHandlersDeps = {
    config,
    orca,
    jj,
    env,
    trustProvision: trust.provision,
    stepTimeoutMs: options.stepTimeoutMs ?? 50,
  };
  return {
    db,
    config,
    deps,
    orca,
    jj,
    env,
    trust,
    dispose() {
      db.close();
      for (const dir of jj.createdDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.rmSync(rawRoot, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// 假 Orca 端口
// ---------------------------------------------------------------------------

export type WorkerStartScriptEntry =
  | { readonly kind: 'ready'; readonly dispatchId?: string; readonly terminalHandle?: string }
  | {
      readonly kind: 'receipt-failed';
      readonly dispatchId?: string;
      readonly failedStage?: string;
    }
  | { readonly kind: 'throw' }
  | { readonly kind: 'exec-timeout' }
  | { readonly kind: 'hang' };

export interface RecordedWorkerStart {
  readonly task: string;
  readonly worktree: string;
  readonly agent?: string;
  readonly retryOf?: string;
}

export class FakeOrca implements OrcaPort {
  readonly taskCreateCalls: Array<{ readonly spec: string; readonly taskTitle?: string }> = [];
  readonly workerStartCalls: RecordedWorkerStart[] = [];
  /** worker-start 剧本：每次调用消耗一项，耗尽后默认 ready。 */
  readonly script: WorkerStartScriptEntry[] = [];
  taskCreateError: Error | null = null;
  private nextDispatch = 1;

  failTaskCreate(err: Error | null): void {
    this.taskCreateError = err;
  }

  async taskCreate(input: {
    readonly spec: string;
    readonly taskTitle?: string;
  }): Promise<{ ok: true; raw: { task: { id: string; run_id: string; status: string } } }> {
    this.taskCreateCalls.push({ spec: input.spec, ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}) });
    if (this.taskCreateError !== null) {
      throw this.taskCreateError;
    }
    return { ok: true, raw: { task: { id: `ot-${this.nextDispatch++}`, run_id: 'run-1', status: 'ready' } } };
  }

  async workerStart(input: {
    readonly task: string;
    readonly worktree: string;
    readonly agent?: string;
    readonly terminal?: string;
    readonly retryOf?: string;
  }): Promise<{ ok: true; raw: WorkerStartReceipt }> {
    const recorded: RecordedWorkerStart = {
      task: input.task,
      worktree: input.worktree,
      ...(input.agent !== undefined ? { agent: input.agent } : {}),
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
    };
    this.workerStartCalls.push(recorded);
    const entry = this.script[this.workerStartCalls.length - 1] ?? { kind: 'ready' } as const;
    const dispatchId = entry.kind === 'ready' || entry.kind === 'receipt-failed'
      ? (entry.dispatchId ?? `disp-${this.nextDispatch++}`)
      : `disp-${this.nextDispatch++}`;
    if (entry.kind === 'ready') {
      const terminalHandle = entry.terminalHandle ?? `term-${dispatchId}`;
      return {
        ok: true,
        raw: {
          runId: 'run-1',
          taskId: input.task,
          dispatchId,
          state: 'ready',
          effects: [{ kind: 'terminal', role: 'agent', id: terminalHandle }],
          residualResources: [],
          terminalHandle,
        },
      };
    }
    if (entry.kind === 'receipt-failed') {
      return {
        ok: true,
        raw: {
          runId: 'run-1',
          taskId: input.task,
          dispatchId,
          state: 'failed',
          failedStage: entry.failedStage ?? 'worktree_create',
          lastError: '剧本注入的失败',
          residualResources: [],
        },
      };
    }
    if (entry.kind === 'throw') {
      throw new OrcaAdapterError('E_ORCA_CALL_FAILED', '剧本注入的确定失败', {
        verb: 'worker-start',
        exitCode: 1,
      });
    }
    if (entry.kind === 'exec-timeout') {
      // 适配器 exec 超时形态：进程被杀，exitCode=TIMEOUT（T2.1 口径）。
      throw new OrcaAdapterError('E_ORCA_CALL_FAILED', '剧本注入的 exec 超时', {
        verb: 'worker-start',
        exitCode: 'TIMEOUT',
      });
    }
    // hang：永不结算，交给服务层 step 超时判不确定。
    return new Promise<{ ok: true; raw: WorkerStartReceipt }>(() => {});
  }
}

// ---------------------------------------------------------------------------
// 假 jj 端口：workspaceAdd 真建临时目录（服务层 realpath/mkdir/rmSync 需要真实路径）
// ---------------------------------------------------------------------------

export class FakeJj implements JjPort {
  readonly workspaceAddCalls: Array<{ readonly name: string; readonly path: string; readonly rev?: string }> = [];
  readonly workspaceForgetCalls: string[] = [];
  /** 首个 workspaceAdd 可挂起的门闩（并发测试控制认领 A 停在 workspace 步）。 */
  firstAddGate: { readonly promise: Promise<void>; readonly release: () => void } | null = null;
  failNextAdd: Error | null = null;
  readonly createdDirs: string[] = [];

  async workspaceAdd(input: {
    readonly name: string;
    readonly path: string;
    readonly rev?: string;
  }): Promise<{ ok: true; name: string; path: string; opIds: string[] }> {
    this.workspaceAddCalls.push({
      name: input.name,
      path: input.path,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
    });
    if (this.workspaceAddCalls.length === 1 && this.firstAddGate !== null) {
      await this.firstAddGate.promise;
    }
    if (this.failNextAdd !== null) {
      const err = this.failNextAdd;
      this.failNextAdd = null;
      throw err;
    }
    const dir = fs.mkdtempSync(input.path);
    this.createdDirs.push(fs.realpathSync(dir));
    return { ok: true, name: input.name, path: dir, opIds: ['op-add-1'] };
  }

  async workspaceForget(name: string): Promise<{ ok: true; name: string; opIds: string[] }> {
    this.workspaceForgetCalls.push(name);
    return { ok: true, name, opIds: ['op-forget-1'] };
  }
}

// ---------------------------------------------------------------------------
// 假环境端口
// ---------------------------------------------------------------------------

export class FakeEnv implements EnvPort {
  readonly createCalls: Array<{ readonly workspaceHostPath: string; readonly taskDirRel: string }> = [];
  readonly setWritableCalls: string[] = [];
  readonly setReadonlyCalls: string[] = [];
  readonly destroyCalls: string[] = [];
  failNextCreate: Error | null = null;
  failSetWritable: Error | null = null;
  private nextEnv = 1;

  async create(input: {
    readonly workspaceHostPath: string;
    readonly taskDirRel: string;
  }): Promise<{
    ok: true;
    envInstanceId: string;
    connection: {
      type: 'ssh';
      host: string;
      port: number;
      username: string;
      projectRoot: string;
    };
    raw: {
      schemaVersion: 1;
      connection: {
        type: 'ssh';
        host: string;
        port: number;
        username: string;
        projectRoot: string;
      };
      userData: { resourceId: string };
    };
  }> {
    this.createCalls.push({ workspaceHostPath: input.workspaceHostPath, taskDirRel: input.taskDirRel });
    if (this.failNextCreate !== null) {
      const err = this.failNextCreate;
      this.failNextCreate = null;
      throw err;
    }
    const envInstanceId = `env-${this.nextEnv++}`;
    const connection = {
      type: 'ssh',
      host: '127.0.0.1',
      port: 2222,
      username: 'dev',
      projectRoot: '/work',
    } as const;
    return {
      ok: true,
      envInstanceId,
      connection,
      raw: { schemaVersion: 1, connection, userData: { resourceId: envInstanceId } },
    };
  }

  async setWritable(envId: string): Promise<{ ok: true; target: 'writable'; hostDir: string; verified: true }> {
    this.setWritableCalls.push(envId);
    if (this.failSetWritable !== null) {
      // T2.3 口径：验证失败适配器内部已回退 0000，再抛 E_ENV_SWITCH_FAILED。
      throw this.failSetWritable;
    }
    return { ok: true, target: 'writable', hostDir: `/fake/host/${envId}`, verified: true };
  }

  async setReadonly(envId: string): Promise<{ ok: true; target: 'readonly'; hostDir: string; verified: true }> {
    this.setReadonlyCalls.push(envId);
    return { ok: true, target: 'readonly', hostDir: `/fake/host/${envId}`, verified: true };
  }

  async destroy(envId: string): Promise<{
    ok: true;
    destroyed: boolean;
    resourceId: string;
    existed: boolean;
  }> {
    this.destroyCalls.push(envId);
    return { ok: true, destroyed: true, resourceId: envId, existed: true };
  }
}

// ---------------------------------------------------------------------------
// 假信任预置
// ---------------------------------------------------------------------------

export class FakeTrust {
  readonly provisionCalls: string[] = [];
  readonly cleanupCalls: string[] = [];
  failNextProvision: Error | null = null;

  readonly provision: TrustProvision = async (workspaceRealPath: string): Promise<TrustHandle> => {
    this.provisionCalls.push(workspaceRealPath);
    if (this.failNextProvision !== null) {
      const err = this.failNextProvision;
      this.failNextProvision = null;
      throw err;
    }
    const self = this;
    return {
      async cleanup(): Promise<void> {
        self.cleanupCalls.push(workspaceRealPath);
      },
    };
  };
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

export async function expectGovError(
  promise: Promise<unknown>,
  code: string,
  messageNeedle?: string,
): Promise<GovError> {
  let threw: unknown;
  try {
    await promise;
  } catch (err) {
    threw = err;
  }
  if (!(threw instanceof GovError)) {
    throw new Error(`预期 GovError(${code})，实际: ${String(threw)}`);
  }
  if (threw.code !== code) {
    throw new Error(`预期错误码 ${code}，实际 ${threw.code}: ${threw.message}`);
  }
  if (messageNeedle !== undefined && !threw.message.includes(messageNeedle)) {
    throw new Error(`错误 message 不含 "${messageNeedle}": ${threw.message}`);
  }
  return threw;
}

/** 走真实 declare 服务铺一个 DECLARED 任务（含 Orca 登记与声明事件）。 */
export async function declareSampleTask(
  host: FakeHost,
  spec: Record<string, unknown> = sampleSpec(),
): Promise<{ taskId: string; spec: Record<string, unknown> }> {
  const { declareTask } = await import('../../../src/services/tasks.ts');
  const result = await declareTask(
    { db: host.db, config: host.config, orca: host.orca },
    { spec, session: 'cap-decl' },
  );
  return { taskId: result.taskId, spec };
}
