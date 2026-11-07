/**
 * jj 0.41.0 适配层（T2.2）：gov 独占的版本操作面——workspace、版本锚定、
 * 含重命名的路径 diff、rebase 冲突、bookmark 快进与 op log 回执。
 *
 * 进程边界与 Orca 适配层同规：一律 execFile(jjPath, args[], { cwd, timeout,
 * maxBuffer })，args 逐字构造、绝不 shell。revset 经 args 传递没有 shell 注入面，
 * 但拼进 revset 的 bookmark 名仍先过白名单校验，防引号逃逸 revset 语法。
 *
 * jj 0.41.0 实测口径（与简报字段级偏差，语义未改，见阶段报告）：
 * - `jj log -r 'bm::new'` 区间输出新提交在前（newest-first）：快进判定不用
 *   「首行等于现值」，改用「区间输出包含 bookmark 现值」——`bm::new` 非空当且仅当
 *   bm 是 new 的祖先，此时现值必然在区间内，语义等价。
 * - `jj bookmark move` 自身不做快进约束（实测可随意移动）：适配器的 revset 预检
 *   是唯一闸门，预检不过绝不调用 move。
 * - `jj doctor` 子命令在 0.41 不存在（unrecognized subcommand）：doctor 改为
 *   `jj --version`（钉 0.41.x）+ 仓库可读探针。
 * - `jj workspace list` 默认模板不含路径：用 name/root/target.commit_id 自定义模板。
 * - `jj diff --summary` 重命名行折叠公共目录前缀（`R pkg/{a => b}`）：双侧路径
 *   按前缀重建；`jj diff --types` 行同构，第二字符为目标侧类型（L=符号链接）。
 * - 工作副本 stale 的成因是「该 workspace 的提交在别处被改写/隐藏」（如同文件
 *   分叉后跨 workspace rebase/abandon），他人改文件本身不产生 stale。
 * - `jj resolve --list` 在无冲突时 exit 2 "No conflicts found at this revision"：
 *   视为合法空结果。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { GovConfig } from '../config.ts';
import { GovError } from '../domain/errors.ts';

const execFileAsync = promisify(execFile);

/** 本机常见 jj 安装路径（测试进程 PATH 可能不含 Homebrew，先探测绝对路径）。 */
export const DEFAULT_JJ_CANDIDATES = ['/opt/homebrew/bin/jj', '/usr/local/bin/jj'] as const;

/** 错误原文进 detail 前的截断上限（简报裁定 8：4 KiB）。 */
const OUTPUT_DETAIL_LIMIT_BYTES = 4 * 1024;

const COMMIT_ID_RE = /^[0-9a-f]{40}$/;
const CHANGE_ID_RE = /^[0-9a-z]{32}$/;
const OP_ID_RE = /^[0-9a-f]{48,}$/;
/** bookmark 名白名单：字母数字开头，允许 . _ / -；引号与空白被排除，拼入 revset 安全。 */
const BOOKMARK_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const WORKSPACE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** 契约钉死 jj 0.41.0 语义；升版必须重新过本适配层全部集成测试。 */
const EXPECTED_JJ_VERSION_PREFIX = 'jj 0.41.';

export type JjErrorCode =
  | 'E_JJ_CALL_FAILED'
  | 'E_JJ_CONFLICT'
  | 'E_JJ_NOT_FAST_FORWARD'
  | 'E_JJ_TARGET_MOVED'
  | 'E_JJ_PATH_OUT_OF_SCOPE'
  | 'E_JJ_STALE'
  | 'E_JJ_SCHEMA'
  | 'E_REPO_NOT_CONFIGURED';

/** 失败 detail：只放安全字段与截断原文（stdout/stderr 不含凭据）。 */
export interface JjErrorDetail {
  readonly verb: string;
  readonly exitCode?: number | string;
  readonly output?: string;
  readonly args?: readonly string[];
  readonly current?: string;
  readonly expected?: string;
  readonly offendingPaths?: readonly string[];
  readonly symlinkPath?: string;
  readonly symlinkTarget?: string;
}

export class JjAdapterError extends GovError {
  readonly detail: JjErrorDetail;

  constructor(code: JjErrorCode, message: string, detail: JjErrorDetail) {
    super(code, message);
    this.name = 'JjAdapterError';
    this.detail = detail;
  }
}

export interface JjAdapterOptions {
  /** 治理仓根；realpath 归一后必须等于 GovConfig 某个 repo 的 hostPath。 */
  readonly repoRoot: string;
  readonly config: GovConfig;
  readonly jjPath?: string;
  readonly execTimeoutMs?: number;
  readonly maxBufferBytes?: number;
}

export interface WorkspaceEntry {
  readonly name: string;
  readonly path: string;
  readonly commitId: string;
}

export function resolveDefaultJjPath(): string {
  for (const candidate of DEFAULT_JJ_CANDIDATES) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return 'jj';
}

/**
 * realpath 到「最深存在的祖先」为止再拼回不存在的尾部：仓库路径在 initColocated
 * 之前尚不存在，锁路径比较仍需与配置 hostPath 在同一归一形态下进行。
 */
function normalizeBestEffort(p: string): string {
  const tails: string[] = [];
  let dir = p;
  while (!existsSync(dir)) {
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    tails.unshift(basename(dir));
    dir = parent;
  }
  try {
    dir = realpathSync(dir);
  } catch {
    // 竞态下目录消失：保留原样，让后续真实调用去报错。
  }
  return tails.length > 0 ? join(dir, ...tails) : dir;
}

function truncateToDetailLimit(text: string): string {
  return text.length > OUTPUT_DETAIL_LIMIT_BYTES ? `${text.slice(0, OUTPUT_DETAIL_LIMIT_BYTES)}…[truncated]` : text;
}

/** 重命名/拷贝显示行（`pkg/{a => b}`）重建为双侧完整路径。 */
function expandRenameExpr(expr: string): { old: string; new: string } | undefined {
  const m = expr.match(/^(.*)\{(.*) => (.*)\}$/);
  if (m === null || m[1] === undefined || m[2] === undefined || m[3] === undefined) {
    return undefined;
  }
  return { old: `${m[1]}${m[2]}`, new: `${m[1]}${m[3]}` };
}

export function createJjAdapter(options: JjAdapterOptions) {
  const jjPath = options.jjPath ?? resolveDefaultJjPath();
  const realRepoRoot = normalizeBestEffort(options.repoRoot);
  const allowedRoots = options.config.repos.map((repo) => normalizeBestEffort(repo.hostPath));
  if (!allowedRoots.includes(realRepoRoot)) {
    throw new JjAdapterError(
      'E_REPO_NOT_CONFIGURED',
      `repoRoot 不在 GovConfig 仓库清单内: ${options.repoRoot}`,
      { verb: 'createJjAdapter', args: [options.repoRoot] },
    );
  }
  const defaultTimeoutMs = options.execTimeoutMs ?? 120_000;
  const maxBuffer = options.maxBufferBytes ?? 16 * 1024 * 1024;

  interface ExecOptions {
    /** 省略时在 realRepoRoot 执行；显式传 workspace 路径即切换工作副本。 */
    readonly cwd?: string;
    /** 置 true 时在宿主进程 cwd 执行（仓库尚未 init 时 realRepoRoot 不存在）。 */
    readonly atProcessCwd?: boolean;
    readonly timeoutMs?: number;
    /** 非零退出但 stderr 命中该模式时按成功空输出处理（conflict --list 的合法空态）。 */
    readonly emptyWhen?: RegExp;
  }

  /** 派生 jj 进程的唯一出口。 */
  async function runJj(args: readonly string[], exec: ExecOptions = {}): Promise<{ stdout: string; stderr: string }> {
    const cwd = exec.atProcessCwd === true ? undefined : exec.cwd ?? realRepoRoot;
    let stdout = '';
    let stderr = '';
    let exitCode: number | string | undefined;
    let failureMessage: string | undefined;
    try {
      const out = await execFileAsync(jjPath, [...args], {
        cwd,
        timeout: exec.timeoutMs ?? defaultTimeoutMs,
        maxBuffer,
        encoding: 'utf8',
      });
      return { stdout: out.stdout, stderr: out.stderr };
    } catch (err) {
      const e = err as { code?: unknown; killed?: boolean; stdout?: string; stderr?: string; message?: string };
      stdout = typeof e.stdout === 'string' ? e.stdout : '';
      stderr = typeof e.stderr === 'string' ? e.stderr : '';
      exitCode = typeof e.code === 'number' ? e.code : e.killed ? 'TIMEOUT' : 'UNKNOWN';
      failureMessage = e.message ?? String(err);
      if (e.code === 'ENOENT') {
        if (cwd !== undefined && !existsSync(cwd)) {
          throw new JjAdapterError('E_JJ_CALL_FAILED', `jj 工作目录不存在: ${cwd}`, {
            verb: args.slice(0, 2).join(' '),
            exitCode,
          });
        }
        throw new JjAdapterError('E_JJ_CALL_FAILED', `jj 可执行文件不可达: ${jjPath}`, {
          verb: args.slice(0, 2).join(' '),
          exitCode,
        });
      }
      const combined = `${stdout}\n${stderr}`.trim();
      if (exec.emptyWhen !== undefined && exec.emptyWhen.test(combined)) {
        return { stdout: '', stderr: '' };
      }
      throw mapFailure(args, exitCode, stdout, stderr, failureMessage);
    }
  }

  /** 非零退出的关键词映射（简报裁定 8）：stale → 冲突 → 兜底 CALL_FAILED 带截断原文。 */
  function mapFailure(
    args: readonly string[],
    exitCode: number | string,
    stdout: string,
    stderr: string,
    failureMessage: string,
  ): JjAdapterError {
    const verb = args.slice(0, 2).join(' ');
    const text = `${stderr}\n${stdout}`.trim();
    if (/working copy is stale/i.test(text)) {
      return new JjAdapterError('E_JJ_STALE', `jj 工作副本已过期（需 update-stale）: ${verb}`, {
        verb,
        exitCode,
        output: truncateToDetailLimit(text),
      });
    }
    if (/conflict/i.test(stderr)) {
      return new JjAdapterError('E_JJ_CONFLICT', `jj 调用因冲突失败: ${verb}`, {
        verb,
        exitCode,
        output: truncateToDetailLimit(text),
      });
    }
    return new JjAdapterError('E_JJ_CALL_FAILED', `jj 调用失败 (${verb}): ${failureMessage}`, {
      verb,
      exitCode,
      output: truncateToDetailLimit(text),
    });
  }

  /** `jj log -r <revset> -T <template>` 的逐行输出（去空行）。 */
  async function logLines(revset: string, template: string, dir?: string): Promise<string[]> {
    const { stdout } = await runJj(['log', '-r', revset, '--no-graph', '-T', template], dir !== undefined ? { cwd: dir } : {});
    return stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  }

  /** 要求 revset 恰好解析到一个 commit id；空/多个都是结构级失败。 */
  async function singleCommitId(revset: string, verb: string, dir?: string): Promise<string> {
    const lines = await logLines(revset, 'commit_id ++ "\\n"', dir);
    const id = lines[0];
    if (lines.length === 0) {
      throw new JjAdapterError('E_JJ_CALL_FAILED', `${verb}: revset 未解析到任何提交: ${revset}`, { verb });
    }
    if (lines.length > 1 || id === undefined || !COMMIT_ID_RE.test(id)) {
      throw new JjAdapterError('E_JJ_SCHEMA', `${verb}: revset 应恰有一个 commit id，实得 ${lines.length} 行`, {
        verb,
        output: truncateToDetailLimit(lines.join('\n')),
      });
    }
    return id;
  }

  /**
   * treeId = 该 rev 文件清单指纹：`jj file list -r <rev>` 输出排序后按 '\n' 连接取
   * sha256（简报裁定 2，作为 manifest 指纹而非底层 tree 对象哈希）。
   */
  async function treeFingerprint(rev: string, dir?: string): Promise<string> {
    const { stdout } = await runJj(['file', 'list', '-r', rev], dir !== undefined ? { cwd: dir } : {});
    const lines = stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
    return createHash('sha256').update([...lines].sort().join('\n')).digest('hex');
  }

  /** op log 回执（简报裁定 7）：写动词后取最近 n 个 op id。 */
  async function opLogReceiptAt(n: number, dir?: string): Promise<string[]> {
    const { stdout } = await runJj(['op', 'log', '-n', String(n), '--no-graph', '-T', 'id ++ "\\n"'], dir !== undefined ? { cwd: dir } : {});
    const ids = stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const id of ids) {
      if (!OP_ID_RE.test(id)) {
        throw new JjAdapterError('E_JJ_SCHEMA', 'op log 输出不是合法 op id', {
          verb: 'op log',
          output: truncateToDetailLimit(stdout),
        });
      }
    }
    return ids;
  }

  function requireNonEmpty(value: string | undefined, name: string): string {
    if (value === undefined || value.length === 0) {
      throw new GovError('E_REQUEST_INVALID', `缺少必填参数: ${name}`);
    }
    return value;
  }

  function requireCommitId(value: string, name: string): string {
    if (!COMMIT_ID_RE.test(value)) {
      throw new GovError('E_REQUEST_INVALID', `${name} 必须是 40 位十六进制 commitId: ${value}`);
    }
    return value;
  }

  function requireBookmarkName(name: string): string {
    if (!BOOKMARK_NAME_RE.test(name)) {
      throw new GovError('E_REQUEST_INVALID', `bookmark 名含非法字符: ${name}`);
    }
    return name;
  }

  /** ownedPaths 覆盖判定：`a/b` owned 覆盖 `a/b` 自身与 `a/b/c...`（简报裁定 5）。 */
  function isCoveredBy(path: string, ownedPaths: readonly string[]): boolean {
    return ownedPaths.some((owned) => path === owned || path.startsWith(owned.endsWith('/') ? owned : `${owned}/`));
  }

  function validateOwnedPaths(ownedPaths: readonly string[]): void {
    for (const p of ownedPaths) {
      if (p.length === 0 || p.startsWith('/') || p.split('/').includes('..')) {
        throw new GovError('E_REQUEST_INVALID', `ownedPaths 条目必须是仓库内相对路径: ${p}`);
      }
    }
  }

  /** 从 `jj diff --git` 输出取指定符号链接路径在目标侧的链接目标原文。 */
  function parseSymlinkTarget(gitDiff: string, linkPath: string): string {
    const blocks = gitDiff.split(/^diff --git /m).slice(1);
    const headerSuffix = ` b/${linkPath}`;
    for (const block of blocks) {
      const headerEnd = block.indexOf('\n');
      const header = headerEnd === -1 ? block : block.slice(0, headerEnd);
      if (!header.endsWith(headerSuffix)) {
        continue;
      }
      const targetLines: string[] = [];
      for (const raw of block.split('\n')) {
        if (raw.startsWith('+++') || !raw.startsWith('+')) {
          continue;
        }
        targetLines.push(raw.slice(1));
      }
      if (targetLines.length === 0) {
        break;
      }
      return targetLines.join('\n');
    }
    throw new JjAdapterError('E_JJ_SCHEMA', `无法从 diff --git 解析符号链接目标: ${linkPath}`, {
      verb: 'diffPaths',
      symlinkPath: linkPath,
      output: truncateToDetailLimit(gitDiff),
    });
  }

  /** 符号链接目标（绝对或相对链接文件所在目录）解析后必须仍在仓库根内。 */
  function symlinkTargetInRepo(linkPath: string, target: string): boolean {
    const linkDir = dirname(linkPath);
    const absolute = isAbsolute(target) ? resolve(target) : resolve(realRepoRoot, linkDir, target);
    return absolute === realRepoRoot || absolute.startsWith(`${realRepoRoot}/`);
  }

  async function bookmarkCurrentCommitId(bookmark: string): Promise<string> {
    const lines = await logLines(`bookmarks("${bookmark}")`, 'commit_id ++ "\\n"');
    const id = lines[0];
    if (lines.length === 0) {
      throw new JjAdapterError('E_JJ_CALL_FAILED', `bookmark 不存在: ${bookmark}`, { verb: 'bookmarkCurrent' });
    }
    if (lines.length > 1 || id === undefined || !COMMIT_ID_RE.test(id)) {
      throw new JjAdapterError('E_JJ_SCHEMA', `bookmark 应恰指向一个提交: ${bookmark}`, {
        verb: 'bookmarkCurrent',
        output: truncateToDetailLimit(lines.join('\n')),
      });
    }
    return id;
  }

  async function conflictLines(rev: string): Promise<string[]> {
    // 无冲突时 jj exit 2 + "No conflicts found at this revision"：合法空态，
    // 必须先于关键词映射兜住，否则会被 /conflict/i 误判成 E_JJ_CONFLICT。
    const { stdout } = await runJj(['resolve', '--list', '-r', rev], { emptyWhen: /No conflicts found/i });
    return stdout
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0);
  }

  return {
    /** 适配器锁定的 jj executable 与归一后的仓库根。 */
    executable: jjPath,
    repoRoot: realRepoRoot,

    /**
     * 自检：`jj --version`（钉 0.41.x，升版需重过集成测试）+ 仓库可读探针。
     * 0.41 无 `jj doctor` 子命令，此即 doctor 语义。
     */
    async doctor(): Promise<{ ok: true; executable: string; version: string }> {
      const { stdout } = await runJj(['--version'], { atProcessCwd: true });
      const version = stdout.trim();
      if (!version.startsWith(EXPECTED_JJ_VERSION_PREFIX)) {
        throw new JjAdapterError('E_JJ_CALL_FAILED', `jj 版本不符（契约钉 ${EXPECTED_JJ_VERSION_PREFIX}x）: ${version}`, {
          verb: '--version',
        });
      }
      await singleCommitId('@', 'doctor');
      return { ok: true, executable: jjPath, version };
    },

    /**
     * 初始化 colocated 仓（.jj + .git 并存）。目标目录必须是适配器锁定的仓库根，
     * 且此刻可以尚不存在（jj git init 自建目录）。
     */
    async initColocated(dir?: string): Promise<{ ok: true; dir: string; opIds: string[] }> {
      const target = dir ?? options.repoRoot;
      if (normalizeBestEffort(target) !== realRepoRoot) {
        throw new JjAdapterError('E_REPO_NOT_CONFIGURED', `initColocated 目标不是锁定的仓库根: ${target}`, {
          verb: 'git init',
          args: [target],
        });
      }
      await runJj(['git', 'init', '--colocate', realRepoRoot], { atProcessCwd: true });
      if (!existsSync(join(realRepoRoot, '.jj')) || !existsSync(join(realRepoRoot, '.git'))) {
        throw new JjAdapterError('E_JJ_SCHEMA', '初始化后未形成 colocated 形态（.jj/.git 缺失）', {
          verb: 'git init',
          args: [realRepoRoot],
        });
      }
      const opIds = await opLogReceiptAt(3, realRepoRoot);
      return { ok: true, dir: realRepoRoot, opIds };
    },

    /**
     * base 解析：bookmark 只是解析入口，返回值一律用 commitId（bookmark 不能替代
     * base；后续漂移判定全部落在 commitId 上）。
     */
    async resolveBase(bookmark: string): Promise<{ ok: true; commitId: string; treeId: string }> {
      requireNonEmpty(bookmark, 'bookmark');
      requireBookmarkName(bookmark);
      const commitId = await bookmarkCurrentCommitId(bookmark);
      await runJj(['st']);
      const treeId = await treeFingerprint(commitId);
      return { ok: true, commitId, treeId };
    },

    /** 创建 workspace（参数顺序按 `jj workspace add [OPTIONS] <DESTINATION>` 实测）。 */
    async workspaceAdd(input: {
      readonly name: string;
      readonly path: string;
      readonly rev?: string;
    }): Promise<{ ok: true; name: string; path: string; opIds: string[] }> {
      requireNonEmpty(input.name, 'name');
      requireNonEmpty(input.path, 'path');
      if (!WORKSPACE_NAME_RE.test(input.name)) {
        throw new GovError('E_REQUEST_INVALID', `workspace 名含非法字符: ${input.name}`);
      }
      const args = ['workspace', 'add', resolve(input.path), '--name', input.name];
      if (input.rev !== undefined && input.rev.length > 0) {
        args.push('-r', input.rev);
      }
      await runJj(args);
      const opIds = await opLogReceiptAt(3);
      return { ok: true, name: input.name, path: resolve(input.path), opIds };
    },

    /** workspace 清单（自定义模板补齐默认模板缺失的路径与工作副本提交）。 */
    async workspaceList(): Promise<{ ok: true; workspaces: WorkspaceEntry[] }> {
      const { stdout } = await runJj(['workspace', 'list', '-T', 'name ++ "\\t" ++ root ++ "\\t" ++ target.commit_id() ++ "\\n"']);
      const workspaces: WorkspaceEntry[] = [];
      for (const line of stdout.split('\n')) {
        if (line.trim().length === 0) {
          continue;
        }
        const cols = line.split('\t');
        const name = cols[0];
        const path = cols[1];
        const commitId = cols[2]?.trimEnd();
        if (name === undefined || path === undefined || commitId === undefined || !COMMIT_ID_RE.test(commitId)) {
          throw new JjAdapterError('E_JJ_SCHEMA', 'workspace list 输出结构不符', {
            verb: 'workspace list',
            output: truncateToDetailLimit(stdout),
          });
        }
        workspaces.push({ name, path, commitId });
      }
      return { ok: true, workspaces };
    },

    /** 注销 workspace；其目录保留，由调用方删除（简报裁定 6）。 */
    async workspaceForget(name: string): Promise<{ ok: true; name: string; opIds: string[] }> {
      requireNonEmpty(name, 'name');
      if (!WORKSPACE_NAME_RE.test(name)) {
        throw new GovError('E_REQUEST_INVALID', `workspace 名含非法字符: ${name}`);
      }
      await runJj(['workspace', 'forget', name]);
      const opIds = await opLogReceiptAt(3);
      return { ok: true, name, opIds };
    },

    /** 在指定（从属）workspace 内修复过期工作副本；返回修复后的工作副本提交。 */
    async workspaceUpdateStale(workspacePath: string): Promise<{
      ok: true;
      commitId: string;
      staleRecovered: boolean;
      opIds: string[];
    }> {
      requireNonEmpty(workspacePath, 'workspacePath');
      const { stdout, stderr } = await runJj(['workspace', 'update-stale'], { cwd: workspacePath });
      // 健康工作副本上 update-stale 也会 exit 0，仅提示 "not stale"：作为回执字段区分。
      const staleRecovered = !/not stale/i.test(`${stdout}\n${stderr}`);
      const commitId = await singleCommitId('@', 'workspace update-stale', workspacePath);
      const opIds = await opLogReceiptAt(3, workspacePath);
      return { ok: true, commitId, staleRecovered, opIds };
    },

    /**
     * 触发快照并读取工作副本锚：先 `jj st`（脏工作副本由本次命令快照），
     * 返回新 commitId + treeId；工作副本过期时抛 E_JJ_STALE。
     */
    async snapshot(dir?: string): Promise<{ ok: true; commitId: string; treeId: string; opIds: string[] }> {
      const cwd = dir ?? realRepoRoot;
      await runJj(['st'], { cwd });
      const commitId = await singleCommitId('@', 'snapshot', cwd);
      const treeId = await treeFingerprint('@', cwd);
      const opIds = await opLogReceiptAt(3, cwd);
      return { ok: true, commitId, treeId, opIds };
    },

    /** 读任意 rev 的锚（读前先 `jj st` 触发快照，简报裁定 2）。 */
    async readCommit(rev: string, dir?: string): Promise<{ ok: true; commitId: string; treeId: string }> {
      requireNonEmpty(rev, 'rev');
      const cwd = dir ?? realRepoRoot;
      await runJj(['st'], { cwd });
      const commitId = await singleCommitId(rev, 'readCommit', cwd);
      const treeId = await treeFingerprint(rev, cwd);
      return { ok: true, commitId, treeId };
    },

    /**
     * 路径 diff（含重命名双侧）。路径集合必须 ⊆ ownedPaths（前缀匹配），否则
     * E_JJ_PATH_OUT_OF_SCOPE；新增/变更符号链接的目标解析后不在仓库内 → 同码拒绝
     * 并记录目标原文。
     */
    async diffPaths(rev: string, ownedPaths: readonly string[]): Promise<{ ok: true; paths: string[] }> {
      requireNonEmpty(rev, 'rev');
      validateOwnedPaths(ownedPaths);

      const summary = await runJj(['diff', '--summary', '-r', rev]);
      const paths: string[] = [];
      const summaryLines = summary.stdout
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0);
      for (const line of summaryLines) {
        const kind = line[0];
        const rest = line.slice(2);
        if (kind === undefined) {
          continue;
        }
        if (kind === 'R' || kind === 'C') {
          const expanded = expandRenameExpr(rest);
          if (expanded === undefined) {
            throw new JjAdapterError('E_JJ_SCHEMA', `无法解析重命名行: ${line}`, {
              verb: 'diffPaths',
              output: truncateToDetailLimit(summary.stdout),
            });
          }
          paths.push(expanded.old, expanded.new);
        } else if (kind === 'A' || kind === 'M' || kind === 'D') {
          paths.push(rest);
        } else {
          throw new JjAdapterError('E_JJ_SCHEMA', `无法解析 diff summary 行: ${line}`, {
            verb: 'diffPaths',
            output: truncateToDetailLimit(summary.stdout),
          });
        }
      }

      const offending = paths.filter((p) => !isCoveredBy(p, ownedPaths));
      if (offending.length > 0) {
        throw new JjAdapterError('E_JJ_PATH_OUT_OF_SCOPE', `diff 路径超出任务 ownedPaths: ${offending.join(', ')}`, {
          verb: 'diffPaths',
          offendingPaths: offending,
        });
      }

      // 目标侧类型为 L 的行是符号链接；重命名行在 --types 中同构折叠，取新侧路径。
      const types = await runJj(['diff', '--types', '-r', rev]);
      const symlinkPaths: string[] = [];
      for (const line of types.stdout
        .split('\n')
        .map((l) => l.trimEnd())
        .filter((l) => l.length > 0)) {
        const m = line.match(/^(\S\S) (.+)$/);
        const typeChars = m?.[1];
        const expr = m?.[2];
        if (typeChars === undefined || expr === undefined) {
          throw new JjAdapterError('E_JJ_SCHEMA', `无法解析 diff types 行: ${line}`, {
            verb: 'diffPaths',
            output: truncateToDetailLimit(types.stdout),
          });
        }
        const dstType = typeChars[1];
        if (dstType !== 'L') {
          continue;
        }
        // 重命名/拷贝行折叠成 brace 形态时取新侧路径；旧侧在该 rev 已不存在，无从读目标。
        const expanded = expandRenameExpr(expr);
        symlinkPaths.push(expanded === undefined ? expr : expanded.new);
      }

      if (symlinkPaths.length > 0) {
        const gitDiff = await runJj(['diff', '--git', '-r', rev]);
        for (const linkPath of symlinkPaths) {
          const target = parseSymlinkTarget(gitDiff.stdout, linkPath);
          if (!symlinkTargetInRepo(linkPath, target)) {
            throw new JjAdapterError('E_JJ_PATH_OUT_OF_SCOPE', `符号链接目标越出仓库: ${linkPath} -> ${target}`, {
              verb: 'diffPaths',
              symlinkPath: linkPath,
              symlinkTarget: target,
            });
          }
        }
      }

      return { ok: true, paths: [...new Set(paths)] };
    },

    /**
     * rebase：jj 在冲突时也成功返回（冲突记录在 commit 里）。新提交按 change_id 在
     * newBase 后代中定位（rebase 保留 change id）；冲突清单随后查 resolve --list。
     */
    async rebase(input: { readonly rev: string; readonly newBase: string }): Promise<{
      ok: true;
      newCommitId: string;
      conflicts: string[];
      opIds: string[];
    }> {
      requireNonEmpty(input.rev, 'rev');
      requireNonEmpty(input.newBase, 'newBase');
      const changeLines = await logLines(input.rev, 'change_id ++ "\\n"');
      const changeId = changeLines[0];
      if (changeLines.length !== 1 || changeId === undefined || !CHANGE_ID_RE.test(changeId)) {
        throw new JjAdapterError('E_JJ_SCHEMA', `rev 应恰有一个 change id: ${input.rev}`, {
          verb: 'rebase',
          output: truncateToDetailLimit(changeLines.join('\n')),
        });
      }
      await runJj(['rebase', '-r', input.rev, '-d', input.newBase]);
      const newCommitId = await singleCommitId(
        `heads(${input.newBase}:: & change_id("${changeId}"))`,
        'rebase',
      );
      const conflicts = await conflictLines(newCommitId);
      const opIds = await opLogReceiptAt(3);
      return { ok: true, newCommitId, conflicts, opIds };
    },

    /** 未解决冲突清单（rev 下每个冲突文件一行：路径 + 冲突描述）。 */
    async conflictList(rev: string): Promise<{ ok: true; conflicts: string[] }> {
      requireNonEmpty(rev, 'rev');
      const conflicts = await conflictLines(rev);
      return { ok: true, conflicts };
    },

    /**
     * 快进移动 bookmark：expectedCurrent 不符 → E_JJ_TARGET_MOVED（双保险）；
     * `<new> 的祖先不含 bookmark 现值` → E_JJ_NOT_FAST_FORWARD。不 push 不 fetch。
     */
    async moveBookmarkFF(input: {
      readonly bookmark: string;
      readonly toCommit: string;
      readonly expectedCurrent: string;
    }): Promise<{ ok: true; from: string; to: string; opIds: string[] }> {
      requireNonEmpty(input.bookmark, 'bookmark');
      requireBookmarkName(input.bookmark);
      requireCommitId(input.toCommit, 'toCommit');
      requireCommitId(input.expectedCurrent, 'expectedCurrent');

      const current = await bookmarkCurrentCommitId(input.bookmark);
      if (current !== input.expectedCurrent) {
        throw new JjAdapterError(
          'E_JJ_TARGET_MOVED',
          `bookmark 已被外部移动: ${input.bookmark} 现值 ${current}，调用方预期 ${input.expectedCurrent}`,
          { verb: 'bookmark move', current, expected: input.expectedCurrent },
        );
      }

      // `bm::new` 非空 ⟺ bm 是 new 的祖先；此时区间必含 bm 现值（见文件头实测口径）。
      const rangeLines = await logLines(
        `bookmarks("${input.bookmark}")::${input.toCommit}`,
        'commit_id ++ "\\n"',
      );
      if (!rangeLines.includes(current)) {
        throw new JjAdapterError(
          'E_JJ_NOT_FAST_FORWARD',
          `目标不是 bookmark 的快进后代: ${input.bookmark} 在 ${current}，目标 ${input.toCommit}`,
          { verb: 'bookmark move', current, expected: input.toCommit },
        );
      }

      await runJj(['bookmark', 'move', input.bookmark, '--to', input.toCommit]);
      const opIds = await opLogReceiptAt(3);
      return { ok: true, from: current, to: input.toCommit, opIds };
    },

    /** bookmark 现值（一律返回 commitId；bookmark 不存在 → E_JJ_CALL_FAILED）。 */
    async bookmarkCurrent(bookmark: string): Promise<{ ok: true; commitId: string }> {
      requireNonEmpty(bookmark, 'bookmark');
      requireBookmarkName(bookmark);
      const commitId = await bookmarkCurrentCommitId(bookmark);
      return { ok: true, commitId };
    },

    /** op log 回执（默认最近 3 条）。 */
    async opLogReceipt(n = 3): Promise<{ ok: true; opIds: string[] }> {
      if (!Number.isInteger(n) || n < 1 || n > 100) {
        throw new GovError('E_REQUEST_INVALID', 'n 必须是 1..100 的整数');
      }
      const opIds = await opLogReceiptAt(n);
      return { ok: true, opIds };
    },
  };
}

export type JjAdapter = ReturnType<typeof createJjAdapter>;
