/**
 * 本地 Docker SSH-mode 环境适配层（T2.3）：每任务一个一次性容器。
 *
 * 机制（控制器裁定，与 T0.4 探针实证一致；实测口径见各条注记）：
 * 1. 双层挂载：容器内 /work = 工作区根（只读）；/work/<taskDirRel> = 任务可写区
 *    （读写）；/work/.jj 与 /work/.git 上叠空只读 tmpfs 遮蔽——读保护只能靠遮蔽
 *    （Docker Desktop macOS 架空宿主 DAC，fakeowner 让 uid1000 总以属主位面出现）。
 * 2. accept 前只读 → 可写 = 宿主侧 chmod 0000↔0777 切换（挂载共享 inode；0 权限
 *    在任何所有权映射下拒所有人，fakeowner 架不空——2026-11-07 本机实测生效且
 *    无 attr cache 竞态）。切换后以容器内 uid1000 试写探针验证；写失败回退 0000
 *    并抛 E_ENV_SWITCH_FAILED，由上层转人工。不重建容器（会杀死 Orca 的 SSH 终端）。
 * 3. suspend/resume = docker pause / docker unpause：进程全冻结天然满足「暂停后
 *    不能写入」；resume 不重建容器，SSH 会话与终端保持（实测 TCP 与新登录均可）。
 *    paused 容器上 docker exec 被 daemon 直接拒绝（"unpause the container before
 *    exec"，docker CLI 以 exit 1 返回），不挂起。
 * 4. destroy = docker rm -f + 幂等（容器已不存在视为成功）；rm 真失败保留
 *    resourceId 供查明。
 * 5. recipe 字段名对齐官方 docker-ssh 参考（orca-per-workspace-env）：destroy 消费
 *    userData.resourceId（简报原文为 userData.containerId，官方优先——create 输出
 *    同时携带 containerId 作同值别名）。connection 携带官方 SSH 形态的
 *    identityFile / identitiesOnly。
 *
 * 进程边界：一律 execFile + args 数组，绝不 shell；docker exec 仅允许探针白名单
 * （固定命令模板 + 受限字符集路径），不开放任意命令。容器绝不 privileged、绝不挂
 * docker socket、一律 -u 1000:1000。
 */
import { execFile } from 'node:child_process';
import { accessSync, chmodSync, constants as fsConstants, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { formatZodIssues, GovError } from '../domain/errors.ts';
import { DEFAULT_JJ_CANDIDATES } from './jj.ts';
import { DEFAULT_ORCA_PATH } from './orca.ts';

const execFileAsync = promisify(execFile);

/** 本机常见 docker 安装路径（测试进程 PATH 可能缺 /usr/local/bin，先探测绝对路径）。 */
export const DEFAULT_DOCKER_CANDIDATES = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'] as const;

/** recipe id：orca.yaml environmentRecipes 与 vm recipe doctor 使用同一标识。 */
export const VM_RECIPE_ID = 'gov-local-docker';

/** SSH 密钥根目录（与 create.sh / destroy.sh 的 GOV_VM_KEYROOT 默认值一致；临时资源只在 /tmp）。 */
export const DEFAULT_VM_KEY_ROOT = '/tmp/gov-vm-keys';

/** 错误原文进 detail 前的截断上限（与 Orca/jj 适配层同规：4 KiB）。 */
const OUTPUT_DETAIL_LIMIT_BYTES = 4 * 1024;

/** 可写子目录相对路径：多段 [A-Za-z0-9._-]+，不含空段 / . / ..。 */
const TASK_DIR_REL_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;

/** 探针路径：/work 下的绝对路径，段字符集排除引号与 shell 元字符。 */
const PROBE_PATH_RE = /^\/work(?:\/[A-Za-z0-9._-]+)*$/;

export type EnvErrorCode =
  | 'E_ENV_CREATE_FAILED'
  | 'E_ENV_SWITCH_FAILED'
  | 'E_ENV_LIFECYCLE_FAILED'
  | 'E_ENV_NOT_FOUND'
  | 'E_ENV_SCHEMA';

/** 失败 detail：只放安全字段与截断原文（脚本 stdout/stderr 不含凭据）。 */
export interface EnvErrorDetail {
  readonly operation: string;
  readonly resourceId?: string;
  readonly stage?: string;
  readonly exitCode?: number | string;
  readonly output?: string;
  readonly target?: 'writable' | 'readonly';
  readonly reverted?: boolean;
  readonly hostDir?: string;
}

export class EnvAdapterError extends GovError {
  readonly detail: EnvErrorDetail;

  constructor(code: EnvErrorCode, message: string, detail: EnvErrorDetail) {
    super(code, message);
    this.name = 'EnvAdapterError';
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// recipe 输出结构：只对「消费的字段」建 schema，passthrough 容忍新增字段。
// 字段名对齐官方 docker-ssh 参考（userData.resourceId）。
// ---------------------------------------------------------------------------

export const envConnectionSchema = z
  .object({
    type: z.literal('ssh'),
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535),
    username: z.string().min(1),
    identityFile: z.string().optional(),
    identitiesOnly: z.boolean().optional(),
    projectRoot: z.string().min(1),
  })
  .passthrough();

export const envRecipeSchema = z
  .object({
    schemaVersion: z.literal(1),
    connection: envConnectionSchema,
    userData: z
      .object({
        resourceId: z.string().min(1),
        containerId: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

/** create/resume 失败时脚本发的单行失败信封（ok:false + 保留 resourceId）。 */
const scriptFailureSchema = z
  .object({
    schemaVersion: z.literal(1).optional(),
    ok: z.literal(false),
    stage: z.string().optional(),
    resourceId: z.string().optional(),
    message: z.string().optional(),
  })
  .passthrough();

const suspendResultSchema = z
  .object({
    suspended: z.boolean(),
    resourceId: z.string(),
    existed: z.boolean(),
    already: z.boolean().optional(),
    state: z.string().optional(),
  })
  .passthrough();

const destroyResultSchema = z
  .object({
    destroyed: z.boolean(),
    resourceId: z.string(),
    existed: z.boolean(),
  })
  .passthrough();

/** vm recipe doctor 输出（实测形态：顶层 ok + checks[]，非 Orca 标准信封）。 */
const vmRecipeDoctorSchema = z
  .object({
    ok: z.boolean(),
    checks: z
      .array(
        z
          .object({
            id: z.string(),
            status: z.string(),
            message: z.string().optional(),
            remediation: z.string().optional(),
          })
          .passthrough(),
      )
      .min(1),
  })
  .passthrough();

const orcaStatusForDoctorSchema = z
  .object({
    ok: z.boolean(),
    result: z
      .object({
        runtime: z
          .object({
            state: z.string(),
            reachable: z.boolean(),
            appVersion: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const dockerVersionSchema = z
  .object({
    Client: z.object({ Version: z.string() }).passthrough(),
    Server: z.object({ Version: z.string() }).passthrough().optional(),
  })
  .passthrough();

export type EnvConnectionReceipt = z.infer<typeof envConnectionSchema>;
export type EnvRecipeReceipt = z.infer<typeof envRecipeSchema>;
export type VmRecipeDoctorReceipt = z.infer<typeof vmRecipeDoctorSchema>;

// ---------------------------------------------------------------------------
// 回执类型（schema 推断 + 少量适配器计算字段）
// ---------------------------------------------------------------------------

export type ProbeKind = 'write-file' | 'list-dir';

export interface ProbeSpec {
  readonly kind: ProbeKind;
  readonly path: string;
}

export interface ProbeReceipt {
  /** exit 0 才为 true；非零退出码是探针结论（如写被拒），不是异常。 */
  readonly ok: boolean;
  readonly kind: ProbeKind;
  readonly path: string;
  readonly exitCode: number | string;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CreateReceipt {
  readonly ok: true;
  readonly envInstanceId: string;
  readonly connection: EnvConnectionReceipt;
  readonly raw: EnvRecipeReceipt;
}

export interface SuspendReceipt {
  readonly ok: true;
  readonly suspended: boolean;
  readonly resourceId: string;
  readonly existed: boolean;
}

export interface ResumeReceipt {
  readonly ok: true;
  readonly resourceId: string;
  readonly connection: EnvConnectionReceipt;
}

export interface DestroyReceipt {
  readonly ok: true;
  readonly destroyed: boolean;
  readonly resourceId: string;
  readonly existed: boolean;
  readonly hostModeRestored?: boolean;
}

export interface SwitchReceipt {
  readonly ok: true;
  readonly target: 'writable' | 'readonly';
  readonly hostDir: string;
  readonly verified: true;
}

interface ToolCheck {
  readonly ok: boolean;
  readonly version?: string;
  readonly error?: string;
}

export interface EnvironmentDoctorReceipt {
  readonly ok: boolean;
  readonly node: { readonly ok: true; readonly version: string };
  readonly orca: ToolCheck & { readonly runtimeState?: string };
  readonly jj: ToolCheck;
  readonly docker: ToolCheck;
  readonly dirs: {
    readonly ok: boolean;
    readonly repoRoot: { readonly path: string; readonly exists: boolean };
    readonly orcaYaml: { readonly path: string; readonly exists: boolean };
    readonly scripts: Record<'create' | 'suspend' | 'resume' | 'destroy', { readonly path: string; readonly executable: boolean }>;
    readonly keyRoot: { readonly path: string; readonly writable: boolean; readonly error?: string };
  };
  readonly versions: {
    readonly node: string;
    readonly orca?: string;
    readonly jj?: string;
    readonly docker?: string;
  };
}

export interface StaticDoctorReceipt {
  readonly ok: boolean;
  readonly orcaYaml: { readonly path: string; readonly exists: boolean };
  readonly scripts: Record<'create' | 'suspend' | 'resume' | 'destroy', { readonly path: string; readonly executable: boolean }>;
  readonly vmRecipeDoctor: {
    readonly ran: boolean;
    readonly ok: boolean;
    readonly allPass: boolean;
    readonly checks: readonly z.infer<typeof vmRecipeDoctorSchema>['checks'][number][];
    readonly error?: string;
  };
}

export interface EnvironmentAdapterOptions {
  /** docker 可执行路径（默认按常见绝对路径探测，回退 PATH 上的 docker）。 */
  readonly dockerPath?: string;
  /** Orca CLI 路径（默认与 Orca 适配层同源的固定路径）。 */
  readonly orcaPath?: string;
  /** jj 可执行路径（默认按 T2.2 候选路径探测）。 */
  readonly jjPath?: string;
  /** gov 仓库根（orca.yaml 与 scripts/orca-vm 所在），默认 process.cwd()。 */
  readonly repoRoot?: string;
  /** 生命周期脚本目录，默认 <repoRoot>/scripts/orca-vm。 */
  readonly scriptsDir?: string;
  /** 预构建镜像名（透传 create.sh 的 GOV_VM_IMAGE；缺省本地构建）。 */
  readonly imageName?: string;
  /** 单次脚本/docker 调用 wall-clock 上限（默认 120 秒；create 固定放宽到 ≥300 秒容纳首次镜像构建）。 */
  readonly execTimeoutMs?: number;
}

/** create 时登记的宿主侧关联：chmod 切换与 destroy 后目录恢复用（持久化由上层 operations 记）。 */
interface EnvRecord {
  readonly hostWritableDir: string;
  readonly containerRel: string;
  readonly containerId?: string;
}

interface ScriptResult {
  readonly success: boolean;
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | string;
  readonly message?: string;
}

function resolveExecutable(candidates: readonly string[], fallback: string): string {
  for (const candidate of candidates) {
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // 继续探测下一个候选路径。
    }
  }
  return fallback;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function truncateToDetailLimit(text: string): string {
  return text.length > OUTPUT_DETAIL_LIMIT_BYTES ? `${text.slice(0, OUTPUT_DETAIL_LIMIT_BYTES)}…[truncated]` : text;
}

function parseJson(text: string, what: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new EnvAdapterError('E_ENV_SCHEMA', `${what} 输出不是合法 JSON`, {
      operation: what,
      output: truncateToDetailLimit(text),
    });
  }
}

function parseWith<T>(schema: z.ZodType<T>, data: unknown, what: string, output?: string): T {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new EnvAdapterError('E_ENV_SCHEMA', `${what} 结构校验失败: ${formatZodIssues(parsed.error)}`, {
      operation: what,
      ...(output !== undefined ? { output: truncateToDetailLimit(output) } : {}),
    });
  }
  return parsed.data;
}

export function createEnvironmentAdapter(options: EnvironmentAdapterOptions = {}) {
  const dockerPath = options.dockerPath ?? resolveExecutable(DEFAULT_DOCKER_CANDIDATES, 'docker');
  const orcaPath = options.orcaPath ?? DEFAULT_ORCA_PATH;
  const jjPath = options.jjPath ?? resolveExecutable(DEFAULT_JJ_CANDIDATES, 'jj');
  const repoRoot = options.repoRoot ?? process.cwd();
  const scriptsDir = options.scriptsDir ?? join(repoRoot, 'scripts', 'orca-vm');
  const defaultTimeoutMs = options.execTimeoutMs ?? 120_000;

  const scriptPaths = {
    create: join(scriptsDir, 'create.sh'),
    suspend: join(scriptsDir, 'suspend.sh'),
    resume: join(scriptsDir, 'resume.sh'),
    destroy: join(scriptsDir, 'destroy.sh'),
  } as const;

  /** envInstanceId（容器名）→ 宿主可写目录等关联。 */
  const registry = new Map<string, EnvRecord>();

  /** 脚本子进程环境：确保 docker / ssh-keygen / nc 可被脚本解析（测试进程 PATH 可能很瘦）。 */
  function scriptEnv(): NodeJS.ProcessEnv {
    const extra = [dirname(dockerPath), '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', process.env['PATH'] ?? '']
      .filter((p) => p.length > 0)
      .join(':');
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: extra };
    if (options.imageName !== undefined && options.imageName.length > 0) {
      env['GOV_VM_IMAGE'] = options.imageName;
    }
    return env;
  }

  /** 跑配方脚本（execFile + args 数组）；stdin 传生命周期 JSON；写入端 EPIPE 容忍（脚本失败早退时未读 stdin）。 */
  function runScript(script: string, args: readonly string[], stdin: string | null, timeoutMs: number): Promise<ScriptResult> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (r: ScriptResult) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const child = execFile(
        script,
        [...args],
        { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: scriptEnv() },
        (err, stdout, stderr) => {
          if (err === null) {
            finish({ success: true, stdout, stderr, exitCode: 0 });
          } else {
            const e = err as { code?: unknown; killed?: boolean; message?: string };
            const exitCode = typeof e.code === 'number' ? e.code : e.killed ? 'TIMEOUT' : 'SPAWN_FAILED';
            finish({ success: false, stdout: stdout ?? '', stderr: stderr ?? '', exitCode, ...(e.message !== undefined ? { message: e.message } : {}) });
          }
        },
      );
      child.stdin?.on('error', () => {
        // 脚本在 read stdin 前退出：EPIPE 是预期路径，结果由 callback 报告。
      });
      child.stdin?.end(stdin);
    });
  }

  /** docker exec 探针执行（execFile 直调 docker 二进制，仍无 shell）。 */
  function runDockerExec(args: readonly string[]): Promise<ScriptResult> {
    return new Promise((resolve) => {
      execFile(dockerPath, [...args], { timeout: 15_000, maxBuffer: 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
        if (err === null) {
          resolve({ success: true, stdout, stderr, exitCode: 0 });
        } else {
          const e = err as { code?: unknown; killed?: boolean; message?: string };
          resolve({
            success: false,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            exitCode: typeof e.code === 'number' ? e.code : e.killed ? 'TIMEOUT' : 'SPAWN_FAILED',
            ...(e.message !== undefined ? { message: e.message } : {}),
          });
        }
      });
    });
  }

  function requireString(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
      throw new GovError('E_REQUEST_INVALID', `缺少必填参数: ${name}`);
    }
    return value;
  }

  function validateProbe(probe: ProbeSpec): void {
    if (probe.kind !== 'write-file' && probe.kind !== 'list-dir') {
      throw new GovError('E_REQUEST_INVALID', `probe.kind 必须是 write-file|list-dir: ${String(probe.kind)}`);
    }
    if (!PROBE_PATH_RE.test(probe.path)) {
      throw new GovError('E_REQUEST_INVALID', `probe.path 必须是 /work 下、段字符集 [A-Za-z0-9._-] 的绝对路径: ${probe.path}`);
    }
    for (const seg of probe.path.split('/').slice(2)) {
      if (seg === '.' || seg === '..') {
        throw new GovError('E_REQUEST_INVALID', `probe.path 不允许 . / .. 段: ${probe.path}`);
      }
    }
  }

  /** 固定探针命令模板：路径已过白名单校验，单引号内无元字符。 */
  function buildProbeCommand(probe: ProbeSpec): string {
    if (probe.kind === 'write-file') {
      return `p='${probe.path}'; if touch "$p" 2>/dev/null; then rm -f "$p"; exit 0; fi; exit 13`;
    }
    return `ls -A '${probe.path}'`;
  }

  /** 脚本失败时：解析失败信封保留 resourceId 与 stage；解析不出也保留原文。 */
  function throwScriptFailure(operation: string, result: ScriptResult): never {
    let stage: string | undefined;
    let resourceId: string | undefined;
    let message = result.message ?? '脚本执行失败';
    try {
      const raw: unknown = JSON.parse(result.stdout);
      const parsed = scriptFailureSchema.safeParse(raw);
      if (parsed.success) {
        stage = parsed.data.stage;
        resourceId = parsed.data.resourceId;
        if (parsed.data.message !== undefined) {
          message = parsed.data.message;
        }
      }
    } catch {
      // stdout 非失败信封（如空输出）：保持原始 message/stderr。
    }
    const detail: { operation: string; exitCode: number | string; output: string; stage?: string; resourceId?: string } = {
      operation,
      exitCode: result.exitCode,
      output: truncateToDetailLimit(`${result.stdout}\n${result.stderr}`.trim()),
    };
    if (stage !== undefined) detail.stage = stage;
    if (resourceId !== undefined) detail.resourceId = resourceId;
    if (operation === 'create') {
      throw new EnvAdapterError('E_ENV_CREATE_FAILED', `环境创建失败 (${stage ?? result.exitCode}): ${message}`, detail);
    }
    if (stage === 'not-found') {
      throw new EnvAdapterError('E_ENV_NOT_FOUND', `环境不存在: ${resourceId ?? '(unknown)'}`, detail);
    }
    throw new EnvAdapterError('E_ENV_LIFECYCLE_FAILED', `环境生命周期操作失败 (${operation}${stage !== undefined ? `/${stage}` : ''}): ${message}`, detail);
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function probeWriteAllowed(envId: string, containerRel: string): Promise<boolean> {
    const receipt = await execProbeInternal(envId, { kind: 'write-file', path: `/work/${containerRel}/.gov-switch-probe` });
    return receipt.ok;
  }

  /**
   * 切换后验证（3×400ms 重试吸收 virtiofs 属性缓存；2026-11-07 实测无竞态，重试仅
   * 为鲁棒）。expectWriteAllowed=true 要求试写成功；false 要求试写被拒。
   */
  async function verifySwitch(envId: string, containerRel: string, expectWriteAllowed: boolean): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const wrote = await probeWriteAllowed(envId, containerRel);
      if (wrote === expectWriteAllowed) {
        return true;
      }
      await sleep(400);
    }
    return false;
  }

  async function execProbeInternal(envId: string, probe: ProbeSpec): Promise<ProbeReceipt> {
    const args = ['exec', '-u', '1000:1000', envId, 'sh', '-c', buildProbeCommand(probe)];
    const result = await runDockerExec(args);
    return {
      ok: result.success,
      kind: probe.kind,
      path: probe.path,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  return {
    /** 适配器锁定的可执行路径与目录。 */
    dockerExecutable: dockerPath,
    orcaExecutable: orcaPath,
    jjExecutable: jjPath,
    repoRoot: repoRoot,
    scriptPaths: scriptPaths,
    vmRecipeId: VM_RECIPE_ID,

    /**
     * 综合 doctor：六项（node / orca / jj / docker / 目录 / 版本聚合）。
     * docker 走 `docker version --format`（要求服务端可达）；orca 走 `status --json`。
     */
    async doctor(): Promise<EnvironmentDoctorReceipt> {
      const node: EnvironmentDoctorReceipt['node'] = { ok: true, version: process.versions.node };

      let orca: EnvironmentDoctorReceipt['orca'] = { ok: false };
      try {
        const { stdout } = await execFileAsync(orcaPath, ['status', '--json'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
        const parsed = parseWith(orcaStatusForDoctorSchema, JSON.parse(stdout), 'orca status (doctor)');
        const runtime = parsed.result.runtime;
        orca = {
          ok: parsed.ok && runtime.reachable && runtime.state === 'ready',
          ...(runtime.appVersion !== undefined ? { version: runtime.appVersion } : {}),
          runtimeState: runtime.state,
        };
      } catch (err) {
        orca = { ok: false, error: (err as Error).message };
      }

      let jj: EnvironmentDoctorReceipt['jj'] = { ok: false };
      try {
        const { stdout } = await execFileAsync(jjPath, ['--version'], { timeout: 15_000, encoding: 'utf8' });
        jj = { ok: true, version: stdout.trim() };
      } catch (err) {
        jj = { ok: false, error: (err as Error).message };
      }

      let docker: EnvironmentDoctorReceipt['docker'] = { ok: false };
      try {
        const { stdout } = await execFileAsync(dockerPath, ['version', '--format', '{{json .}}'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' });
        const parsed = parseWith(dockerVersionSchema, JSON.parse(stdout), 'docker version (doctor)');
        docker = {
          ok: parsed.Server !== undefined,
          ...(parsed.Server !== undefined ? { version: parsed.Server.Version } : { version: parsed.Client.Version }),
        };
      } catch (err) {
        docker = { ok: false, error: (err as Error).message };
      }

      const scriptChecks = {
        create: { path: scriptPaths.create, executable: isExecutable(scriptPaths.create) },
        suspend: { path: scriptPaths.suspend, executable: isExecutable(scriptPaths.suspend) },
        resume: { path: scriptPaths.resume, executable: isExecutable(scriptPaths.resume) },
        destroy: { path: scriptPaths.destroy, executable: isExecutable(scriptPaths.destroy) },
      } as const;
      let keyRoot: EnvironmentDoctorReceipt['dirs']['keyRoot'] = { path: DEFAULT_VM_KEY_ROOT, writable: false };
      try {
        mkdirSync(DEFAULT_VM_KEY_ROOT, { recursive: true });
        accessSync(DEFAULT_VM_KEY_ROOT, fsConstants.W_OK);
        keyRoot = { path: DEFAULT_VM_KEY_ROOT, writable: true };
      } catch (err) {
        keyRoot = { path: DEFAULT_VM_KEY_ROOT, writable: false, error: (err as Error).message };
      }
      const repoRootExists = existsSync(repoRoot);
      const yamlPath = join(repoRoot, 'orca.yaml');
      const yamlExists = existsSync(yamlPath);
      const allScriptsExecutable = (Object.values(scriptChecks) as Array<{ executable: boolean }>).every((s) => s.executable);
      const dirsOk = repoRootExists && yamlExists && allScriptsExecutable && keyRoot.writable;
      const dirs = {
        ok: dirsOk,
        repoRoot: { path: repoRoot, exists: repoRootExists },
        orcaYaml: { path: yamlPath, exists: yamlExists },
        scripts: scriptChecks,
        keyRoot,
      };

      const versions: EnvironmentDoctorReceipt['versions'] = {
        node: process.versions.node,
        ...(orca.version !== undefined ? { orca: orca.version } : {}),
        ...(jj.version !== undefined ? { jj: jj.version } : {}),
        ...(docker.version !== undefined ? { docker: docker.version } : {}),
      };

      return { ok: node.ok && orca.ok && jj.ok && docker.ok && dirsOk, node, orca, jj, docker, dirs, versions };
    },

    /**
     * 免费静态检查：orca.yaml 存在、四脚本可执行、
     * `vm recipe doctor gov-local-docker --repo-path <repo> --json` 无 fail 且无
     * warn（warn 也算不过，简报口径）。Orca CLI 不可达时 ran:false 一并判不过。
     */
    async staticDoctor(): Promise<StaticDoctorReceipt> {
      const scripts = {
        create: { path: scriptPaths.create, executable: isExecutable(scriptPaths.create) },
        suspend: { path: scriptPaths.suspend, executable: isExecutable(scriptPaths.suspend) },
        resume: { path: scriptPaths.resume, executable: isExecutable(scriptPaths.resume) },
        destroy: { path: scriptPaths.destroy, executable: isExecutable(scriptPaths.destroy) },
      } as const;
      const yamlPath = join(repoRoot, 'orca.yaml');
      const yamlExists = existsSync(yamlPath);
      const allExecutable = (Object.values(scripts) as Array<{ executable: boolean }>).every((s) => s.executable);

      let vmRecipeDoctor: StaticDoctorReceipt['vmRecipeDoctor'] = {
        ran: false,
        ok: false,
        allPass: false,
        checks: [],
        error: 'orca.yaml 缺失或脚本不可执行，跳过 vm recipe doctor',
      };
      if (yamlExists && allExecutable) {
        try {
          const { stdout } = await execFileAsync(
            orcaPath,
            ['vm', 'recipe', 'doctor', VM_RECIPE_ID, '--repo-path', repoRoot, '--json'],
            { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
          );
          const parsed = parseWith(vmRecipeDoctorSchema, parseJson(stdout, 'vm recipe doctor'), 'vm recipe doctor', stdout);
          const allPass = parsed.ok && parsed.checks.every((c) => c.status === 'pass');
          vmRecipeDoctor = { ran: true, ok: parsed.ok, allPass, checks: parsed.checks };
        } catch (err) {
          vmRecipeDoctor = { ran: true, ok: false, allPass: false, checks: [], error: (err as Error).message };
        }
      }

      return {
        ok: yamlExists && allExecutable && vmRecipeDoctor.ran && vmRecipeDoctor.allPass,
        orcaYaml: { path: yamlPath, exists: yamlExists },
        scripts,
        vmRecipeDoctor,
      };
    },

    /**
     * 起一次性容器（SSH-mode）：双层挂载 + tmpfs 遮蔽 + 可写区 0000。
     * 成功返回 envInstanceId（=userData.resourceId，容器名）与 connection。
     * 失败抛 E_ENV_CREATE_FAILED；docker run 成功后的失败保留容器（resourceId 在
     * detail 中）供查明。zod 只校验消费子集。
     */
    async create(input: { readonly workspaceHostPath: string; readonly taskDirRel: string }): Promise<CreateReceipt> {
      const ws = requireString(input.workspaceHostPath, 'workspaceHostPath');
      const rel = requireString(input.taskDirRel, 'taskDirRel');
      if (!isAbsolute(ws)) {
        throw new GovError('E_REQUEST_INVALID', `workspaceHostPath 必须是绝对路径: ${ws}`);
      }
      if (!TASK_DIR_REL_RE.test(rel) || rel.split('/').some((seg) => seg === '.' || seg === '..')) {
        throw new GovError('E_REQUEST_INVALID', `taskDirRel 非法（须为多段 [A-Za-z0-9._-] 的相对子路径）: ${rel}`);
      }
      if (!existsSync(ws) || !statSync(ws).isDirectory()) {
        throw new GovError('E_REQUEST_INVALID', `workspaceHostPath 不是目录: ${ws}`);
      }
      const hostWritableDir = join(ws, rel);
      if (!existsSync(hostWritableDir)) {
        throw new GovError('E_REQUEST_INVALID', `可写子目录不存在: ${hostWritableDir}`);
      }

      // create 固定放宽超时：首次运行需要本地构建镜像。
      const result = await runScript(scriptPaths.create, [ws, rel], null, Math.max(defaultTimeoutMs, 300_000));
      if (!result.success) {
        throwScriptFailure('create', result);
      }
      const raw = parseWith(envRecipeSchema, parseJson(result.stdout, 'create'), 'create', result.stdout);
      registry.set(raw.userData.resourceId, {
        hostWritableDir,
        containerRel: rel,
        ...(raw.userData.containerId !== undefined ? { containerId: raw.userData.containerId } : {}),
      });
      return { ok: true, envInstanceId: raw.userData.resourceId, connection: raw.connection, raw };
    },

    /**
     * accept 成功后切可写：宿主 chmod 0777 + 容器内 uid1000 试写验证。
     * 验证失败回退 0000 并抛 E_ENV_SWITCH_FAILED（上层转人工）。
     * hostDir/probeRel 缺省取 create 登记；适配器实例重启后需显式传入。
     */
    async setWritable(envId: string, opts: { readonly hostDir?: string; readonly probeRel?: string } = {}): Promise<SwitchReceipt> {
      const record = registry.get(envId);
      const hostDir = opts.hostDir ?? record?.hostWritableDir;
      const probeRel = opts.probeRel ?? record?.containerRel;
      if (hostDir === undefined || probeRel === undefined) {
        throw new EnvAdapterError('E_ENV_NOT_FOUND', `环境未登记且未显式提供 hostDir/probeRel: ${envId}`, {
          operation: 'setWritable',
          resourceId: envId,
        });
      }
      chmodSync(hostDir, 0o777);
      const verified = await verifySwitch(envId, probeRel, true);
      if (!verified) {
        chmodSync(hostDir, 0o000);
        throw new EnvAdapterError('E_ENV_SWITCH_FAILED', `切可写后容器内 uid1000 试写仍被拒，已回退 0000: ${hostDir}`, {
          operation: 'setWritable',
          resourceId: envId,
          target: 'writable',
          reverted: true,
          hostDir,
        });
      }
      return { ok: true, target: 'writable', hostDir, verified: true };
    },

    /**
     * 拒绝/回收路径切只读：宿主 chmod 0000 + 验证容器内试写被拒。
     * 试写意外仍成功（DAC 疑似被架空）时抛 E_ENV_SWITCH_FAILED——目录已在 0000，
     * 无更强回退，交上层处置。
     */
    async setReadonly(envId: string, opts: { readonly hostDir?: string; readonly probeRel?: string } = {}): Promise<SwitchReceipt> {
      const record = registry.get(envId);
      const hostDir = opts.hostDir ?? record?.hostWritableDir;
      const probeRel = opts.probeRel ?? record?.containerRel;
      if (hostDir === undefined || probeRel === undefined) {
        throw new EnvAdapterError('E_ENV_NOT_FOUND', `环境未登记且未显式提供 hostDir/probeRel: ${envId}`, {
          operation: 'setReadonly',
          resourceId: envId,
        });
      }
      chmodSync(hostDir, 0o000);
      const verified = await verifySwitch(envId, probeRel, false);
      if (!verified) {
        throw new EnvAdapterError('E_ENV_SWITCH_FAILED', `切只读后容器内 uid1000 仍可写，目录保持 0000: ${hostDir}`, {
          operation: 'setReadonly',
          resourceId: envId,
          target: 'readonly',
          reverted: false,
          hostDir,
        });
      }
      return { ok: true, target: 'readonly', hostDir, verified: true };
    },

    /** docker pause：进程全冻结；容器不存在视为已挂起（existed:false 交调用方判断）。 */
    async suspend(envId: string): Promise<SuspendReceipt> {
      requireString(envId, 'envId');
      const result = await runScript(
        scriptPaths.suspend,
        [],
        `${JSON.stringify({ schemaVersion: 1, userData: { resourceId: envId } })}\n`,
        defaultTimeoutMs,
      );
      if (!result.success) {
        throwScriptFailure('suspend', result);
      }
      const raw = parseWith(suspendResultSchema, parseJson(result.stdout, 'suspend'), 'suspend', result.stdout);
      return { ok: true, suspended: raw.suspended, resourceId: raw.resourceId, existed: raw.existed };
    },

    /** docker unpause（必要时 start）：不重建容器，SSH 终端与 Session 保持；重发 recipe。 */
    async resume(envId: string): Promise<ResumeReceipt> {
      requireString(envId, 'envId');
      const result = await runScript(
        scriptPaths.resume,
        [],
        `${JSON.stringify({ schemaVersion: 1, userData: { resourceId: envId } })}\n`,
        Math.max(defaultTimeoutMs, 120_000),
      );
      if (!result.success) {
        throwScriptFailure('resume', result);
      }
      const raw = parseWith(envRecipeSchema, parseJson(result.stdout, 'resume'), 'resume', result.stdout);
      return { ok: true, resourceId: raw.userData.resourceId, connection: raw.connection };
    },

    /**
     * docker rm -f，幂等：容器已不存在视为成功（existed:false）。
     * 成功后尽力恢复宿主可写区 0755（避免遗留 0000/0777 目录）；恢复失败不阻断
     * destroy 回执，以 hostModeRestored:false 暴露。rm 真失败抛
     * E_ENV_LIFECYCLE_FAILED 且保留 resourceId。
     */
    async destroy(envId: string): Promise<DestroyReceipt> {
      requireString(envId, 'envId');
      const result = await runScript(
        scriptPaths.destroy,
        [],
        `${JSON.stringify({ schemaVersion: 1, userData: { resourceId: envId } })}\n`,
        defaultTimeoutMs,
      );
      if (!result.success) {
        throwScriptFailure('destroy', result);
      }
      const raw = parseWith(destroyResultSchema, parseJson(result.stdout, 'destroy'), 'destroy', result.stdout);
      const record = registry.get(envId);
      let hostModeRestored: boolean | undefined;
      if (record !== undefined) {
        try {
          chmodSync(record.hostWritableDir, 0o755);
          hostModeRestored = true;
        } catch {
          hostModeRestored = false;
        }
        registry.delete(envId);
      }
      return {
        ok: true,
        destroyed: raw.destroyed,
        resourceId: raw.resourceId,
        existed: raw.existed,
        ...(hostModeRestored !== undefined ? { hostModeRestored } : {}),
      };
    },

    /**
     * 容器内固定探针（唯一 docker exec 面）：uid1000 跑固定命令模板
     * （write-file = touch+rm 探针文件；list-dir = ls -A），路径受限字符集，
     * 不开放任意命令。paused 容器上 daemon 拒绝 exec（实测 "unpause the
     * container before exec"，docker CLI exit 1），探针如实返回非零。非零
     * 退出码是探针结论而非异常，调用方按 ok 字段断言。
     */
    async execProbe(envId: string, probe: ProbeSpec, options: { readonly asUser?: boolean } = {}): Promise<ProbeReceipt> {
      requireString(envId, 'envId');
      validateProbe(probe);
      if (options.asUser === false) {
        throw new GovError('E_REQUEST_INVALID', 'execProbe 只允许 asUser:true（容器内 uid1000）');
      }
      return execProbeInternal(envId, probe);
    },
  };
}

export type EnvironmentAdapter = ReturnType<typeof createEnvironmentAdapter>;
