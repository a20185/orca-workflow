/**
 * Orca CLI 适配层（T2.1）：gov 内唯一允许派生子进程的模块。
 *
 * 进程边界：一律 execFile(orcaPath, args[], { timeout, maxBuffer })，args 逐字
 * 构造、绝不字符串拼接、绝不 shell。executable 路径在适配器创建时锁定，
 * 同一 Run 会话内复用同一实例即复用同一路径。
 *
 * 回执契约：每个动词返回 { ok: true, raw, …字段 }；失败抛 OrcaAdapterError，
 * detail 携带 failedStage / residualResources（存在时）与 exitCode，stdout/stderr
 * 原文截断到 4 KiB（适配器不向 CLI 传递任何环境变量或凭据，原文本身不含敏感值）。
 * worker-start 的失败/不确定结局是「回执」而非异常：CLI 以 ok:true + state:failed
 * 返回 failedStage 与 residualResources，由调用方按回执处置。
 * 注意（2026-11-14 实测）：桌面 11-10 更新（1.4.255）已不再遵守该形态——运行期失败
 * 改为 ok:false + result 载荷（无 error 对象，exit 1），本适配器按信封规则抛
 * E_ORCA_CALL_FAILED；是否恢复「失败即回执」契约属未裁决的语义分叉，见
 * execution/adapter-drift-fix-report.md。
 */
import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { z } from 'zod';
import { formatZodIssues, GovError } from '../domain/errors.ts';

const execFileAsync = promisify(execFile);

/** 探针实测口径 1：Orca CLI 固定路径（Orca.app 1.4.238）。 */
export const DEFAULT_ORCA_PATH = '/Applications/Orca.app/Contents/Resources/bin/orca';

/** 错误原文进 detail 前的截断上限。 */
const OUTPUT_DETAIL_LIMIT_BYTES = 4 * 1024;

/** 受限读取默认与上限：搜索命中默认 20 条封顶，终端/worker 读取默认 200 行封顶（只可下调）。 */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 20;
export const TERMINAL_DEFAULT_LINES = 200;
export const TERMINAL_MAX_LINES = 200;
export const WORKER_READ_DEFAULT_LINES = 200;
export const WORKER_READ_MAX_LINES = 200;
export const WORKER_LIST_MAX_LIMIT = 100;

/** 协调者车道定向消息类型白名单；worker 车道消息（worker_done/heartbeat 等）属 T5.1。 */
export const SEND_TYPE_WHITELIST = ['status', 'merge_ready', 'question'] as const;
export type SendType = (typeof SEND_TYPE_WHITELIST)[number];

const nonEmpty = z.string().min(1);

/**
 * 动词白名单：适配器允许派生的 CLI 动词全集（含集成测试断言基线所需的
 * worktree list）。名单之外一律 E_ORCA_FORBIDDEN_VERB，绝不派生进程——
 * 特别是 task-update（正常路径禁用）、dispatch --inject（绕开监督）与
 * orchestration reset（无 run 范围会清空全部消息，2026-11-07 实证）。
 */
const VERB_WHITELIST: readonly (readonly string[])[] = [
  ['status'],
  ['orchestration', 'run-create'],
  ['orchestration', 'run-use'],
  ['orchestration', 'run-current'],
  ['orchestration', 'task-create'],
  ['orchestration', 'worker-start'],
  ['orchestration', 'worker-show'],
  ['orchestration', 'worker-list'],
  ['orchestration', 'worker-read'],
  ['orchestration', 'worker-stop'],
  ['orchestration', 'worker-abandon'],
  ['orchestration', 'worker-release'],
  ['orchestration', 'send'],
  ['orchestration', 'reply'],
  ['orchestration', 'check'],
  ['search'],
  ['terminal', 'read'],
  ['worktree', 'list'],
  ['worktree', 'rm'],
  ['repo', 'add'],
  ['repo', 'show'],
  ['project', 'setup-delete'],
];

/** 被点名禁用的动词（即使未来白名单扩张也不得进入）。 */
const FORBIDDEN_VERBS: readonly (readonly string[])[] = [
  ['orchestration', 'task-update'],
  ['orchestration', 'dispatch'],
  ['orchestration', 'reset'],
];

/**
 * 单点动词门卫：白名单层断言，不派生任何进程。导出供测试直接验证
 * task-update / dispatch --inject / orchestration reset 在本层即被拒绝。
 */
export function assertOrcaVerbAllowed(args: readonly string[]): void {
  for (const forbidden of FORBIDDEN_VERBS) {
    if (prefixMatches(args, forbidden)) {
      throw new OrcaAdapterError(
        'E_ORCA_FORBIDDEN_VERB',
        `禁用动词: ${forbidden.join(' ')}`,
        { verb: forbidden.join(' '), args: args.slice(0, 8) },
      );
    }
  }
  if (!VERB_WHITELIST.some((allowed) => prefixMatches(args, allowed))) {
    throw new OrcaAdapterError('E_ORCA_FORBIDDEN_VERB', `动词不在适配器白名单: ${args.join(' ')}`, {
      verb: args.slice(0, 2).join(' '),
      args: args.slice(0, 8),
    });
  }
}

function prefixMatches(args: readonly string[], prefix: readonly string[]): boolean {
  return prefix.every((token, i) => args[i] === token);
}

/** 失败 detail：只放安全字段与截断原文，不携带环境变量与凭据。 */
export interface OrcaErrorDetail {
  readonly verb: string;
  readonly orcaErrorCode?: string;
  readonly exitCode?: number | string;
  readonly failedStage?: string;
  readonly residualResources?: readonly unknown[];
  readonly output?: string;
  readonly args?: readonly string[];
}

export class OrcaAdapterError extends GovError {
  readonly detail: OrcaErrorDetail;

  constructor(code: 'E_ORCA_RUNTIME_DOWN' | 'E_ORCA_CALL_FAILED' | 'E_ORCA_SCHEMA' | 'E_ORCA_FORBIDDEN_VERB', message: string, detail: OrcaErrorDetail) {
    super(code, message);
    this.name = 'OrcaAdapterError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// JSON 结构校验：每个动词只对「消费的字段」建 schema，passthrough 容忍
// Orca 新增字段；必填字段缺失或类型不符 → E_ORCA_SCHEMA 并保留原文引用。
// ---------------------------------------------------------------------------

// 桌面 11-10 更新起 run/task 系动词的信封不再携带顶层 id（status 仍带）；
// id 降为可选（双形态宽容），ok/result/error 结构维持 strict。
const envelopeSchema = z
  .object({
    id: z.string().optional(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        data: z.unknown().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const runtimeShape = z
  .object({
    state: z.string(),
    reachable: z.boolean(),
    appVersion: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .passthrough();

const statusResultSchema = z
  .object({
    app: z.object({ running: z.boolean() }).passthrough(),
    runtime: runtimeShape,
  })
  .passthrough();

// run 系回执双形态（桌面 11-10 更新漂移，探针实测 2026-11-13）：
//   旧（≤1.4.238）：result.run 嵌套 {id, objective, coordinator_handle}
//   新（1.4.255）：result 顶层扁平 {runId, objective}，coordinator_handle 已消失
// union 优先匹配新形态，归一为消费侧规范位 result.run.{id, objective}，
// coordinator_handle 仅旧形态提供 → 可选。多余字段维持 passthrough。
const runShape = z
  .object({
    id: nonEmpty,
    objective: z.string(),
    coordinator_handle: z.string().optional(),
  })
  .passthrough();

const runObjectResult = z.object({ run: runShape }).passthrough();

const runResultSchema = z.union([
  z
    .object({ runId: nonEmpty, objective: z.string() })
    .passthrough()
    .transform((d): z.infer<typeof runObjectResult> => ({ run: { id: d.runId, objective: d.objective } })),
  z
    .object({
      run: z.object({ id: nonEmpty, objective: z.string(), coordinator_handle: z.string() }).passthrough(),
    })
    .passthrough()
    .transform((d): z.infer<typeof runObjectResult> => ({ run: d.run })),
]);

// task-create 回执双形态（同次更新漂移）：
//   旧：result.task 嵌套 {id, run_id, status}
//   新：result 顶层扁平 {taskId, status}，run_id 已消失（任务归属由当前 coordinator 绑定隐含）
// 归一为消费侧规范位 result.task.{id, status}，run_id 仅旧形态提供 → 可选。
const taskShape = z
  .object({
    id: nonEmpty,
    run_id: nonEmpty.optional(),
    status: z.string(),
  })
  .passthrough();

const taskObjectResult = z.object({ task: taskShape }).passthrough();

const taskResultSchema = z.union([
  z
    .object({ taskId: nonEmpty, status: z.string() })
    .passthrough()
    .transform((d): z.infer<typeof taskObjectResult> => ({ task: { id: d.taskId, status: d.status } })),
  z
    .object({
      task: z.object({ id: nonEmpty, run_id: nonEmpty, status: z.string() }).passthrough(),
    })
    .passthrough()
    .transform((d): z.infer<typeof taskObjectResult> => ({ task: d.task })),
]);

const resourceEffectSchema = z
  .object({
    kind: z.string(),
    id: z.string().optional(),
    role: z.string().optional(),
  })
  .passthrough();

const workerStartResultSchema = z
  .object({
    runId: nonEmpty,
    taskId: nonEmpty,
    dispatchId: nonEmpty,
    state: z.string(),
    stage: z.string().optional(),
    failedStage: z.string().optional(),
    lastError: z.string().optional(),
    effects: z.array(resourceEffectSchema).optional(),
    residualResources: z.array(resourceEffectSchema).optional(),
    recovery: z.string().optional(),
  })
  .passthrough();

// worker-show 回执双形态（桌面 11-10 更新漂移）：
//   旧：{dispatch:{id,taskId,status}, worker:{dispatchId,state}} 嵌套
//   新：{dispatchId, taskId, runId?, state, stage?, liveness?, attention?, waitingOnHuman?, lastError?} 扁平
// 归一为消费侧规范位 worker.state（消费方只读 worker.state/dispatch.id）；新形态无
// dispatch.status → 可选。多余字段（stage/liveness/attention 等）维持 passthrough。
const workerShowCanonical = z
  .object({
    dispatch: z
      .object({
        id: nonEmpty,
        taskId: nonEmpty,
        status: z.string().optional(),
      })
      .passthrough(),
    worker: z
      .object({
        dispatchId: nonEmpty,
        state: z.string(),
      })
      .passthrough(),
  })
  .passthrough();

const workerShowResultSchema = z.union([
  z
    .object({
      dispatchId: nonEmpty,
      taskId: nonEmpty,
      state: z.string(),
      stage: z.string().optional(),
      lastError: z.string().optional(),
    })
    .passthrough()
    .transform((d): z.infer<typeof workerShowCanonical> => ({
      dispatch: { id: d.dispatchId, taskId: d.taskId },
      worker: {
        dispatchId: d.dispatchId,
        state: d.state,
        ...(d.stage !== undefined ? { stage: d.stage } : {}),
        ...(d.lastError !== undefined ? { lastError: d.lastError } : {}),
      },
    })),
  workerShowCanonical,
]);

// worker-list 行双形态（桌面 11-10 更新漂移）：
//   旧行：{dispatchId, taskId, workerState, dispatchStatus, agentTerminalHandle?}
//   新行：{dispatchId, taskId, state, liveness, host, attention[]}（dispatchStatus 消失）
// 归一为消费侧规范位 workerState（新行的 state 重命名而来），dispatchStatus 仅旧形态提供 → 可选。
const workerRowCanonical = z
  .object({
    dispatchId: nonEmpty,
    taskId: nonEmpty,
    workerState: z.string(),
    dispatchStatus: z.string().optional(),
    agentTerminalHandle: z.string().nullable().optional(),
  })
  .passthrough();

const workerRowSchema = z.union([
  z
    .object({ dispatchId: nonEmpty, taskId: nonEmpty, state: nonEmpty })
    .passthrough()
    .transform((d): z.infer<typeof workerRowCanonical> => ({ ...d, workerState: d.state })),
  z
    .object({
      dispatchId: nonEmpty,
      taskId: nonEmpty,
      workerState: z.string(),
      dispatchStatus: z.string(),
      agentTerminalHandle: z.string().nullable().optional(),
    })
    .passthrough(),
]);

const workerListResultSchema = z
  .object({
    workers: z.array(workerRowSchema).optional(),
    counts: z.record(z.string(), z.number()).optional(),
  })
  .passthrough();

const workerReadResultSchema = z
  .object({
    dispatchId: nonEmpty,
    source: z.string(),
    terminal: z
      .object({
        handle: z.string().optional(),
        tail: z.array(z.string()).optional(),
        nextCursor: z.string().optional(),
      })
      .passthrough()
      .optional(),
    cursor: z.string().optional(),
  })
  .passthrough();

const workerSettleResultSchema = z
  .object({
    dispatchId: nonEmpty,
    state: z.string(),
    alreadySettled: z.boolean().optional(),
    processAction: z.string().optional(),
  })
  .passthrough();

const messageShape = z
  .object({
    id: nonEmpty,
    run_id: nonEmpty,
    type: z.string(),
    from_handle: z.string(),
    to_handle: z.string(),
    subject: z.string().optional(),
    payload: z.string().nullable().optional(),
  })
  .passthrough();

const messageResultSchema = z.object({ message: messageShape }).passthrough();

// check 回执双形态（桌面 11-10 更新漂移）：旧形态每批带 deliveryId/count 且需
// 下次 --ack 确认；新形态默认「返回即标记已处理」，空/超时批不带 deliveryId/count
//（--ack 仅作为对旧版 Orca 未标记批的兼容口）。两者均宽容为可选，messages 仍必填。
const checkResultSchema = z
  .object({
    runId: z.string().optional(),
    deliveryId: z.string().nullable().optional(),
    messages: z.array(messageShape),
    count: z.number().int().optional(),
    acknowledged: z.string().nullable().optional(),
    timedOut: z.boolean().optional(),
  })
  .passthrough();

const searchResultSchema = z
  .object({
    kind: z.string(),
    hits: z.array(z.object({ agent: z.string(), sessionId: z.string() }).passthrough()),
    page: z.object({ cursor: z.string().optional(), hasMore: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const terminalReadResultSchema = z
  .object({
    terminal: z
      .object({
        handle: nonEmpty,
        tail: z.array(z.string()),
        nextCursor: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const worktreeListResultSchema = z
  .object({
    worktrees: z.array(z.object({ path: nonEmpty, isMainWorktree: z.boolean().optional() }).passthrough()),
  })
  .passthrough();

const worktreeRmResultSchema = z.object({ removed: z.boolean() }).passthrough();

const repoResultSchema = z
  .object({
    repo: z
      .object({
        id: nonEmpty,
        path: nonEmpty,
        displayName: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const setupDeleteResultSchema = z.object({}).passthrough();

// ---------------------------------------------------------------------------
// 回执类型（schema 推断 + 少量适配器计算字段）
// ---------------------------------------------------------------------------

export type StatusReceipt = z.infer<typeof statusResultSchema>;
export type RunReceipt = z.infer<typeof runResultSchema>;
export type TaskReceipt = z.infer<typeof taskResultSchema>;
export type WorkerStartReceipt = z.infer<typeof workerStartResultSchema> & { terminalHandle?: string };
export type WorkerShowReceipt = z.infer<typeof workerShowResultSchema>;
export type WorkerListReceipt = z.infer<typeof workerListResultSchema>;
export type WorkerReadReceipt = z.infer<typeof workerReadResultSchema>;
export type WorkerSettleReceipt = z.infer<typeof workerSettleResultSchema>;
export type MessageReceipt = z.infer<typeof messageResultSchema>;
export type CheckReceipt = z.infer<typeof checkResultSchema>;
export type SearchReceipt = z.infer<typeof searchResultSchema>;
export type TerminalReadReceipt = z.infer<typeof terminalReadResultSchema>;
export type WorktreeListReceipt = z.infer<typeof worktreeListResultSchema>;
export type WorktreeRmReceipt = z.infer<typeof worktreeRmResultSchema>;
export type RepoReceipt = z.infer<typeof repoResultSchema>;

export interface DoctorReceipt {
  readonly ok: true;
  readonly executable: string;
  readonly runtimeState: string;
  readonly appVersion?: string;
  readonly capabilities: readonly string[];
}

export interface OrcaAdapterOptions {
  /** Orca CLI 路径，默认固定路径；创建时锁定。 */
  readonly orcaPath?: string;
  /** 单次 CLI 调用 wall-clock 上限（默认 120 秒；check --wait 等长阻塞调用按需放宽）。 */
  readonly execTimeoutMs?: number;
  readonly maxBufferBytes?: number;
}

interface ExecOptions {
  readonly timeoutMs?: number;
}

export function createOrcaAdapter(options: OrcaAdapterOptions = {}) {
  const orcaPath = options.orcaPath ?? DEFAULT_ORCA_PATH;
  const defaultTimeoutMs = options.execTimeoutMs ?? 120_000;
  const maxBuffer = options.maxBufferBytes ?? 16 * 1024 * 1024;
  let runtimeVerified = false;

  /** 派生 Orca CLI 进程的唯一出口；白名单门卫在派生前执行。 */
  async function runOrca(args: readonly string[], exec: ExecOptions = {}): Promise<{ envelope: z.infer<typeof envelopeSchema>; stdout: string }> {
    assertOrcaVerbAllowed(args);
    let stdout = '';
    let stderr = '';
    let exitCode: number | string | undefined;
    let failureMessage: string | undefined;
    try {
      const out = await execFileAsync(orcaPath, [...args], {
        timeout: exec.timeoutMs ?? defaultTimeoutMs,
        maxBuffer,
        encoding: 'utf8',
      });
      stdout = out.stdout;
      exitCode = 0;
    } catch (err) {
      const e = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string };
      if (e.code === 'ENOENT') {
        throw new OrcaAdapterError('E_ORCA_RUNTIME_DOWN', `Orca CLI 不可达: ${orcaPath}`, { verb: args.join(' ') });
      }
      stdout = typeof e.stdout === 'string' ? e.stdout : '';
      stderr = typeof e.stderr === 'string' ? e.stderr : '';
      exitCode = typeof e.code === 'number' ? e.code : e.killed ? 'TIMEOUT' : 'UNKNOWN';
      failureMessage = e.message ?? String(err);
    }

    let json: unknown;
    try {
      json = JSON.parse(stdout);
    } catch {
      // CLI 非零退出且 stdout 非信封（如 help 文案、崩溃输出）：调用失败而非结构问题。
      if (failureMessage !== undefined) {
        throw new OrcaAdapterError('E_ORCA_CALL_FAILED', `Orca 调用失败 (${args.join(' ')}): ${failureMessage}`, {
          verb: args.slice(0, 2).join(' '),
          exitCode,
          output: truncateToDetailLimit(`${stdout}\n${stderr}`.trim()),
        });
      }
      throw new OrcaAdapterError('E_ORCA_SCHEMA', `Orca 输出不是合法信封 JSON (${args.join(' ')})`, {
        verb: args.slice(0, 2).join(' '),
        exitCode,
        output: truncateToDetailLimit(stdout),
      });
    }
    const parsed = envelopeSchema.safeParse(json);
    if (!parsed.success) {
      throw new OrcaAdapterError('E_ORCA_SCHEMA', `Orca 信封结构校验失败 (${args.join(' ')}): ${formatZodIssues(parsed.error)}`, {
        verb: args.slice(0, 2).join(' '),
        exitCode,
        output: truncateToDetailLimit(stdout),
      });
    }
    if (parsed.data.ok !== true) {
      const orcaError = parsed.data.error;
      const detail: { verb: string; output: string; exitCode?: number | string; orcaErrorCode?: string } = {
        verb: args.slice(0, 2).join(' '),
        output: truncateToDetailLimit(stdout),
      };
      if (exitCode !== undefined) {
        detail.exitCode = exitCode;
      }
      if (orcaError?.code !== undefined) {
        detail.orcaErrorCode = orcaError.code;
      }
      throw new OrcaAdapterError(
        'E_ORCA_CALL_FAILED',
        `Orca 报错 (${args.join(' ')}): ${orcaError?.code ?? 'unknown'} ${orcaError?.message ?? ''}`.trim(),
        detail,
      );
    }
    return { envelope: parsed.data, stdout };
  }

  /** 按动词 schema 校验 result；失败保留原文引用。 */
  function validateResult<T>(schema: z.ZodType<T>, result: unknown, verb: string, stdout: string): T {
    const parsed = schema.safeParse(result);
    if (!parsed.success) {
      throw new OrcaAdapterError('E_ORCA_SCHEMA', `Orca 回执结构校验失败 (${verb}): ${formatZodIssues(parsed.error)}`, {
        verb,
        output: truncateToDetailLimit(stdout),
      });
    }
    return parsed.data;
  }

  /** 探针口径 1：首个动词调用前确认 runtime.state=ready，不可达/未就绪 → E_ORCA_RUNTIME_DOWN。 */
  async function ensureRuntimeReady(): Promise<void> {
    if (runtimeVerified) {
      return;
    }
    const { envelope, stdout } = await runOrca(['status', '--json']);
    const status = validateResult(statusResultSchema, envelope.result, 'status', stdout);
    if (!status.runtime.reachable || status.runtime.state !== 'ready') {
      throw new OrcaAdapterError('E_ORCA_RUNTIME_DOWN', `Orca runtime 未就绪: state=${status.runtime.state} reachable=${status.runtime.reachable}`, {
        verb: 'status',
      });
    }
    runtimeVerified = true;
  }

  function requireString(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
      throw new GovError('E_REQUEST_INVALID', `缺少必填参数: ${name}`);
    }
    return value;
  }

  function clampLimit(limit: number | undefined, max: number, dflt: number, name: string): number {
    if (limit === undefined) {
      return dflt;
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > max) {
      throw new GovError('E_REQUEST_INVALID', `${name} 必须是 1..${max} 的整数（可下调不可上调）`);
    }
    return limit;
  }

  /** 探针口径 2：路径型选择器先 realpathSync（/tmp ↔ /private/tmp），失败则原样交给 Orca 报错。 */
  function normalizePathSelector(selector: string): string {
    try {
      return realpathSync(selector);
    } catch {
      return selector;
    }
  }

  async function callJson<T>(args: readonly string[], schema: z.ZodType<T>, verb: string, exec?: ExecOptions): Promise<{ ok: true; raw: T }> {
    await ensureRuntimeReady();
    const { envelope, stdout } = await runOrca(args, exec);
    const raw = validateResult(schema, envelope.result, verb, stdout);
    return { ok: true, raw };
  }

  return {
    /** 适配器锁定的 executable 路径（同一 Run 会话复用同一实例）。 */
    executable: orcaPath,

    async status(): Promise<{ ok: true; raw: StatusReceipt }> {
      return callJson(['status', '--json'], statusResultSchema, 'status');
    },

    /** 适配器自检：executable + runtime 就绪 + 版本与能力面（Orca CLI 无独立 doctor 动词）。 */
    async doctor(): Promise<DoctorReceipt> {
      const { envelope, stdout } = await runOrca(['status', '--json'], { timeoutMs: Math.min(defaultTimeoutMs, 30_000) });
      const status = validateResult(statusResultSchema, envelope.result, 'status', stdout);
      if (!status.runtime.reachable || status.runtime.state !== 'ready') {
        throw new OrcaAdapterError('E_ORCA_RUNTIME_DOWN', `Orca runtime 未就绪: state=${status.runtime.state} reachable=${status.runtime.reachable}`, {
          verb: 'doctor',
        });
      }
      runtimeVerified = true;
      return {
        ok: true,
        executable: orcaPath,
        runtimeState: status.runtime.state,
        ...(status.runtime.appVersion !== undefined ? { appVersion: status.runtime.appVersion } : {}),
        capabilities: status.runtime.capabilities ?? [],
      };
    },

    async runCreate(objective: string): Promise<{ ok: true; raw: RunReceipt }> {
      requireString(objective, 'objective');
      return callJson(['orchestration', 'run-create', '--objective', objective, '--json'], runResultSchema, 'run-create');
    },

    async runUse(runId: string): Promise<{ ok: true; raw: RunReceipt }> {
      requireString(runId, 'runId');
      return callJson(['orchestration', 'run-use', '--id', runId, '--json'], runResultSchema, 'run-use');
    },

    async runCurrent(): Promise<{ ok: true; raw: RunReceipt }> {
      return callJson(['orchestration', 'run-current', '--json'], runResultSchema, 'run-current');
    },

    async taskCreate(input: {
      readonly spec: string;
      readonly taskTitle?: string;
      readonly deps?: readonly string[];
      readonly parent?: string;
    }): Promise<{ ok: true; raw: TaskReceipt }> {
      requireString(input.spec, 'spec');
      const args = ['orchestration', 'task-create', '--spec', input.spec];
      if (input.taskTitle !== undefined) {
        args.push('--task-title', input.taskTitle);
      }
      if (input.deps !== undefined && input.deps.length > 0) {
        args.push('--deps', JSON.stringify(input.deps));
      }
      if (input.parent !== undefined) {
        args.push('--parent', input.parent);
      }
      args.push('--json');
      return callJson(args, taskResultSchema, 'task-create');
    },

    /**
     * worker-start：新工作树必须给 --name 与精确 --repo（CLI 强制）；重试必须同时
     * 给 --task 与 --retry-of。失败/不确定结局以回执返回（state=failed + failedStage
     * + residualResources + recovery），不抛异常；ok:false（如 task_not_startable、
     * terminal_worktree_mismatch）才抛 E_ORCA_CALL_FAILED。
     */
    async workerStart(input: {
      readonly task: string;
      readonly worktree: string;
      readonly agent?: string;
      readonly terminal?: string;
      readonly retryOf?: string;
      readonly repo?: string;
      readonly name?: string;
    }): Promise<{ ok: true; raw: WorkerStartReceipt }> {
      requireString(input.task, 'task');
      requireString(input.worktree, 'worktree');
      if ((input.agent === undefined) === (input.terminal === undefined)) {
        throw new GovError('E_REQUEST_INVALID', 'agent 与 terminal 必须二选一（CLI 不允许并存）');
      }
      const args = ['orchestration', 'worker-start', '--task', input.task];
      if (input.retryOf !== undefined) {
        args.push('--retry-of', input.retryOf);
      }
      if (input.agent !== undefined) {
        args.push('--agent', input.agent);
      } else if (input.terminal !== undefined) {
        args.push('--terminal', input.terminal);
      }
      args.push('--worktree', input.worktree);
      if (input.repo !== undefined) {
        args.push('--repo', normalizePathSelector(input.repo));
      }
      if (input.name !== undefined) {
        args.push('--name', input.name);
      }
      args.push('--json');
      const receipt = await callJson(args, workerStartResultSchema, 'worker-start');
      const terminalEffect = receipt.raw.effects?.find((e) => e.kind === 'terminal' && e.role === 'agent' && typeof e.id === 'string');
      const raw: WorkerStartReceipt = { ...receipt.raw };
      if (terminalEffect?.id !== undefined) {
        raw.terminalHandle = terminalEffect.id;
      }
      return { ok: true, raw };
    },

    async workerShow(dispatch: string): Promise<{ ok: true; raw: WorkerShowReceipt }> {
      requireString(dispatch, 'dispatch');
      return callJson(['orchestration', 'worker-show', '--dispatch', dispatch, '--json'], workerShowResultSchema, 'worker-show');
    },

    async workerList(input: { readonly run?: string; readonly limit?: number } = {}): Promise<{ ok: true; raw: WorkerListReceipt }> {
      const args = ['orchestration', 'worker-list'];
      if (input.run !== undefined) {
        args.push('--run', input.run);
      }
      if (input.limit !== undefined) {
        args.push('--limit', String(clampLimit(input.limit, WORKER_LIST_MAX_LIMIT, 100, 'limit')));
      }
      args.push('--json');
      return callJson(args, workerListResultSchema, 'worker-list');
    },

    async workerRead(input: { readonly dispatch: string; readonly limit?: number }): Promise<{ ok: true; raw: WorkerReadReceipt }> {
      requireString(input.dispatch, 'dispatch');
      const limit = clampLimit(input.limit, WORKER_READ_MAX_LINES, WORKER_READ_DEFAULT_LINES, 'limit');
      return callJson(
        ['orchestration', 'worker-read', '--dispatch', input.dispatch, '--limit', String(limit), '--json'],
        workerReadResultSchema,
        'worker-read',
      );
    },

    async workerStop(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
      requireString(dispatch, 'dispatch');
      return callJson(['orchestration', 'worker-stop', '--dispatch', dispatch, '--json'], workerSettleResultSchema, 'worker-stop');
    },

    async workerAbandon(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
      requireString(dispatch, 'dispatch');
      return callJson(['orchestration', 'worker-abandon', '--dispatch', dispatch, '--json'], workerSettleResultSchema, 'worker-abandon');
    },

    async workerRelease(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
      requireString(dispatch, 'dispatch');
      return callJson(['orchestration', 'worker-release', '--dispatch', dispatch, '--json'], workerSettleResultSchema, 'worker-release');
    },

    /**
     * 协调者车道定向消息：只允许 status/merge_ready/question，只发 dispatch:<id>，
     * 绝不 --from 他人身份、绝不组地址（@all/@idle）。worker_done 等 worker 车道
     * 类型属 T5.1 启动器，不在此面。
     */
    async sendToDispatch(input: {
      readonly dispatch: string;
      readonly type: SendType;
      readonly subject: string;
      readonly body: string;
      readonly filesModified?: readonly string[];
    }): Promise<{ ok: true; raw: MessageReceipt }> {
      requireString(input.dispatch, 'dispatch');
      requireString(input.subject, 'subject');
      requireString(input.body, 'body');
      if (!SEND_TYPE_WHITELIST.includes(input.type)) {
        throw new GovError('E_REQUEST_INVALID', `type 必须是 ${SEND_TYPE_WHITELIST.join('|')} 之一: ${String(input.type)}`);
      }
      const args = [
        'orchestration',
        'send',
        '--to',
        `dispatch:${input.dispatch}`,
        '--type',
        input.type,
        '--subject',
        input.subject,
        '--body',
        input.body,
      ];
      if (input.filesModified !== undefined && input.filesModified.length > 0) {
        args.push('--files-modified', input.filesModified.join(','));
      }
      args.push('--json');
      return callJson(args, messageResultSchema, 'send');
    },

    async reply(input: { readonly messageId: string; readonly body: string }): Promise<{ ok: true; raw: MessageReceipt }> {
      requireString(input.messageId, 'messageId');
      requireString(input.body, 'body');
      return callJson(['orchestration', 'reply', '--id', input.messageId, '--body', input.body, '--json'], messageResultSchema, 'reply');
    },

    /** 消费式 check：默认返回最旧未确认 FIFO 批；ackDeliveryId 先确认上一批再查/等。 */
    async checkRun(input: {
      readonly runId: string;
      readonly types?: readonly string[];
      readonly wait?: boolean;
      readonly timeoutMs?: number;
      readonly ackDeliveryId?: string;
    }): Promise<{ ok: true; raw: CheckReceipt }> {
      requireString(input.runId, 'runId');
      const args = ['orchestration', 'check', '--run', input.runId];
      if (input.ackDeliveryId !== undefined) {
        args.push('--ack', input.ackDeliveryId);
      }
      if (input.types !== undefined && input.types.length > 0) {
        args.push('--types', input.types.join(','));
      }
      if (input.wait === true) {
        args.push('--wait');
      }
      if (input.timeoutMs !== undefined) {
        if (!Number.isInteger(input.timeoutMs) || input.timeoutMs < 1 || input.timeoutMs > 600_000) {
          throw new GovError('E_REQUEST_INVALID', 'timeoutMs 必须是 1..600000 的整数（毫秒）');
        }
        args.push('--timeout-ms', String(input.timeoutMs));
      }
      args.push('--json');
      if (input.wait === true) {
        // CLI 的 --timeout-ms 先到点（信封返回 timedOut），exec 上限留 30 秒余量。
        const execTimeout = input.timeoutMs !== undefined ? input.timeoutMs + 30_000 : 600_000;
        return callJson(args, checkResultSchema, 'check', { timeoutMs: execTimeout });
      }
      return callJson(args, checkResultSchema, 'check');
    },

    async searchSessions(input: { readonly query: string; readonly limit?: number }): Promise<{ ok: true; raw: SearchReceipt }> {
      requireString(input.query, 'query');
      const limit = clampLimit(input.limit, SEARCH_MAX_LIMIT, SEARCH_DEFAULT_LIMIT, 'limit');
      return callJson(['search', input.query, '--limit', String(limit), '--json'], searchResultSchema, 'search');
    },

    async terminalRead(input: { readonly terminal: string; readonly cursor?: string; readonly limit?: number }): Promise<{ ok: true; raw: TerminalReadReceipt }> {
      requireString(input.terminal, 'terminal');
      const limit = clampLimit(input.limit, TERMINAL_MAX_LINES, TERMINAL_DEFAULT_LINES, 'limit');
      const args = ['terminal', 'read', '--terminal', input.terminal, '--limit', String(limit)];
      if (input.cursor !== undefined) {
        args.push('--cursor', input.cursor);
      }
      args.push('--json');
      return callJson(args, terminalReadResultSchema, 'terminal read');
    },

    /** 仅用于 Orca 自建工作树；对注册仓根 CLI 会报 protected（探针口径 3）。 */
    async worktreeRm(selector: string): Promise<{ ok: true; raw: WorktreeRmReceipt }> {
      requireString(selector, 'selector');
      const normalized = selector.startsWith('/') ? normalizePathSelector(selector) : selector;
      return callJson(['worktree', 'rm', '--worktree', normalized, '--force', '--json'], worktreeRmResultSchema, 'worktree rm');
    },

    async worktreeList(input: { readonly repo?: string } = {}): Promise<{ ok: true; raw: WorktreeListReceipt }> {
      const args = ['worktree', 'list'];
      if (input.repo !== undefined) {
        args.push('--repo', normalizePathSelector(input.repo));
      }
      args.push('--json');
      return callJson(args, worktreeListResultSchema, 'worktree list');
    },

    async repoAdd(path: string): Promise<{ ok: true; raw: RepoReceipt }> {
      requireString(path, 'path');
      return callJson(['repo', 'add', '--path', normalizePathSelector(path), '--json'], repoResultSchema, 'repo add');
    },

    async repoShow(selector: string): Promise<{ ok: true; raw: RepoReceipt }> {
      requireString(selector, 'selector');
      const normalized = selector.startsWith('/') ? normalizePathSelector(selector) : selector;
      return callJson(['repo', 'show', '--repo', normalized, '--json'], repoResultSchema, 'repo show');
    },

    /** 注册仓根注销：--setup 传 repoId，--force 覆盖「有开启终端/工作区详情」的拒绝。 */
    async projectSetupDelete(repoId: string): Promise<{ ok: true; raw: Record<string, unknown> }> {
      requireString(repoId, 'repoId');
      return callJson(['project', 'setup-delete', '--setup', repoId, '--force', '--json'], setupDeleteResultSchema, 'project setup-delete');
    },
  };
}

export type OrcaAdapter = ReturnType<typeof createOrcaAdapter>;

/** 预测 Orca 为 new-child 工作树分配的路径（默认工作区根 ~/orca/workspaces/<repoDisplay>/<name>）。 */
export function predictWorktreePath(repoDisplayName: string, name: string): string {
  return `${homedir()}/orca/workspaces/${repoDisplayName}/${name}`;
}

function truncateToDetailLimit(text: string): string {
  return text.length > OUTPUT_DETAIL_LIMIT_BYTES ? `${text.slice(0, OUTPUT_DETAIL_LIMIT_BYTES)}…[truncated]` : text;
}
