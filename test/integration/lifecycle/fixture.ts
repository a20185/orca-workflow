/**
 * T3.3 生命周期集成测试共享夹具（test/integration/lifecycle/）。
 *
 * 真实面：真实 jj（0.41）/ 真实 Docker 环境 / 真实 Orca CLI；gov 库为临时文件库。
 * 工作文件由测试自己经 jj 写入（模拟 worker 开发改动，无需模型跑开发）。
 *
 * 与既有服务接口的三处夹具适配（按简报「以既有为准适配并记录」，探针实证）：
 * 1. claims.ts 的 workerStart 用 `path:<gov jj 工作区>` 选择器——真实 Orca 只接受
 *    已注册工作树（selector_not_found）。适配：Shim 把执行派工翻译为同仓
 *    new-child 工作树（真实 dispatch 载体）+ claude 代理（opencode 在本机
 *    agent_readiness 超时，探针实证；claude 为 T2.1 已验证路径）+ 信任种子。
 * 2. 评审者不真启 worker（简报裁定）：Shim 对评审 agent（claude/codex）返回
 *    脚本化 ready 回执（新身份不命中禁任）；其 stop/release 同样脚本化。
 * 3. jj workspace add --rev 把工作副本放在 rev 的新子提交上，而 T3.2 结审
 *    tree 检查要求评审工作副本 == 受审提交。适配：评审工作区创建后追加
 *    `jj edit -r <受审提交>`（探针实证：与开发工作副本共享该提交稳定、无
 *    stale、bookmark 不受影响）。一次性 arming，不影响认领侧 workspaceAdd。
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { GovConfig } from '../../../src/config.ts';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import { GovError } from '../../../src/domain/errors.ts';
import type { TaskReceipt, WorkerSettleReceipt, WorkerShowReceipt, WorkerStartReceipt } from '../../../src/adapters/orca.ts';
import { createJjAdapter, type JjAdapter } from '../../../src/adapters/jj.ts';
import {
  createEnvironmentAdapter,
  type CreateReceipt,
  type DestroyReceipt,
  type ResumeReceipt,
  type SuspendReceipt,
  type SwitchReceipt,
} from '../../../src/adapters/environment.ts';
import { createOrcaAdapter, predictWorktreePath, type OrcaAdapter } from '../../../src/adapters/orca.ts';
import type { EnvLifecyclePort, JjMergePort, OrcaSettlementPort, TrustHandle, TrustProvision } from '../../../src/services/ports.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { createSubmissionService, isSubmitAccepted } from '../../../src/services/submissions.ts';
import { createReviewService } from '../../../src/services/reviews.ts';
import { manualApprove } from '../../../src/services/evidence.ts';

const execFileAsync = promisify(execFile);

export const STAMP = `${Date.now()}`;
export const DECLARER_SESSION = 'gov-it-decl';
export const COORD_SESSION = 'gov-it-coord';
export const EXEC_SESSION = 'gov-it-exec';
export const OPERATOR_SESSION = 'gov-it-op';

export const CONTROLLED_WORKER_INSTRUCTION = [
  '受控执行指令（gov T3.3 生命周期集成测试）：立即按以下两步执行，不做任何其他事。',
  '第一步：原样执行注入 preamble 中给出的 check 命令一次（不改任何参数），输出读后即弃，不处理任何消息、不回复任何问题。',
  '第二步：立即按 preamble 中 worker_done 的说明，从本终端发送 worker_done，--outcome succeeded，正文写「gov T3.3 集成测试自然完成」。',
  '发送后立即结束本轮并保持空闲，不轮询、不开始新工作、不读文件、不写文件、不运行测试。',
  'Target: 无。Change: 无。Observable acceptance: 协调者收到 outcome=succeeded 的 worker_done。',
].join('\n');

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function jjBin(): string {
  for (const candidate of ['/opt/homebrew/bin/jj', '/usr/local/bin/jj']) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'jj';
}

export function execJj(dir: string, args: readonly string[]): Promise<{ stdout: string }> {
  return execFileAsync(jjBin(), [...args], { cwd: dir, encoding: 'utf8', timeout: 120_000 });
}

export async function rawCommitId(dir: string, revset: string): Promise<string> {
  const { stdout } = await execJj(dir, ['log', '-r', revset, '--no-graph', '-T', 'commit_id']);
  return stdout.trim();
}

export async function expectGovError(promise: Promise<unknown>, code: string, needle?: string): Promise<GovError> {
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
  if (needle !== undefined && !threw.message.includes(needle)) {
    throw new Error(`错误 message 不含 "${needle}": ${threw.message}`);
  }
  return threw;
}

// ---------------------------------------------------------------------------
// claude 工作区信任种子（T2.1 同款：worker claude 的 TUI 信任对话框预置）
// ---------------------------------------------------------------------------

const trustSeeds = new Map<string, string[]>();

export function seedClaudeWorkspaceTrust(paths: readonly string[]): void {
  const homes = new Set<string>([join(homedir(), '.claude.json')]);
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir.length > 0) {
    homes.add(join(configDir, '.claude.json'));
  }
  for (const file of homes) {
    let cfg: { projects?: Record<string, unknown> } = {};
    try {
      cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: Record<string, unknown> };
    } catch {
      cfg = {};
    }
    if (cfg.projects === undefined) {
      cfg.projects = {};
    }
    const added: string[] = [];
    for (const p of paths) {
      if (cfg.projects[p] === undefined) {
        cfg.projects[p] = { hasTrustDialogAccepted: true };
        added.push(p);
      }
    }
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    trustSeeds.set(file, [...(trustSeeds.get(file) ?? []), ...added]);
  }
}

export function removeClaudeWorkspaceTrustSeeds(prefixes: readonly string[]): void {
  const files = new Set<string>(trustSeeds.keys());
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir.length > 0) {
    files.add(join(configDir, '.claude.json'));
  }
  files.add(join(homedir(), '.claude.json'));
  for (const file of files) {
    try {
      const cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as { projects?: Record<string, unknown> };
      for (const key of Object.keys(cfg.projects ?? {})) {
        if (trustSeeds.get(file)?.includes(key) === true || prefixes.some((p) => key === p || key.startsWith(`${p}/`))) {
          delete cfg.projects?.[key];
        }
      }
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    } catch {
      // 尽力而为：种子键都在临时路径下，孤儿无害。
    }
  }
  trustSeeds.clear();
}

// ---------------------------------------------------------------------------
// jj 计数包装：评审工作区 edit arming + 合并后分叉注入（一次性钩子）
// ---------------------------------------------------------------------------

export class CountingJj implements JjMergePort {
  private readonly real: JjAdapter;
  /** 一次性：下一次带 rev 的 workspaceAdd 后执行 `jj edit -r <rev>`（评审工作区适配）。 */
  armEditOnNextRevAdd = false;
  /** 一次性：下一次对指定目录的 snapshot 前，向该目录写入杂散文件（合并后分叉注入）。 */
  divergeBeforeSnapshotAt: string | null = null;

  readonly workspaceAddCalls: Array<{ name: string; rev?: string }> = [];
  readonly workspaceForgetCalls: string[] = [];
  readonly snapshotCalls: string[] = [];
  readonly moveBookmarkFFCalls: unknown[] = [];
  readonly bookmarkCurrentCalls: string[] = [];

  constructor(real: JjAdapter) {
    this.real = real;
  }

  async workspaceAdd(input: {
    readonly name: string;
    readonly path: string;
    readonly rev?: string | undefined;
  }): Promise<{ ok: true; name: string; path: string; opIds: string[] }> {
    this.workspaceAddCalls.push({ name: input.name, ...(input.rev !== undefined ? { rev: input.rev } : {}) });
    const added = await this.real.workspaceAdd({
      name: input.name,
      path: input.path,
      ...(input.rev !== undefined ? { rev: input.rev } : {}),
    });
    // 夹具适配 4：T2.3 create.sh 对 /work/.jj 与 /work/.git 叠 tmpfs 遮蔽，而纯
    // jj workspace 无 .git——docker 无法在只读 bind 上创建挂载点（实测 OCI
    // "read-only file system"）。补空 .git 目录作挂载点（空目录不入快照、无副作用）。
    fs.mkdirSync(join(added.path, '.git'), { recursive: true });
    if (this.armEditOnNextRevAdd && input.rev !== undefined) {
      this.armEditOnNextRevAdd = false;
      await execJj(added.path, ['edit', '-r', input.rev]);
    }
    return added;
  }

  async workspaceForget(name: string): Promise<{ ok: true; name: string; opIds: string[] }> {
    this.workspaceForgetCalls.push(name);
    return this.real.workspaceForget(name);
  }

  async snapshot(dir?: string | undefined): Promise<{ ok: true; commitId: string; treeId: string; opIds: string[] }> {
    const key = dir ?? '(root)';
    if (this.divergeBeforeSnapshotAt !== null && key === this.divergeBeforeSnapshotAt) {
      this.divergeBeforeSnapshotAt = null;
      // 外部改动注入：写杂散文件（真实 jj 快照会把它并入工作副本 → 版本分叉）。
      fs.mkdirSync(join(key, 'src', 'a'), { recursive: true });
      fs.writeFileSync(join(key, 'src', 'a', 'stray-external.txt'), 'external edit after merge\n');
    }
    this.snapshotCalls.push(key);
    return this.real.snapshot(dir);
  }

  async diffPaths(rev: string, ownedPaths: readonly string[]): Promise<{ ok: true; paths: string[] }> {
    return this.real.diffPaths(rev, ownedPaths);
  }

  async conflictList(rev: string): Promise<{ ok: true; conflicts: string[] }> {
    return this.real.conflictList(rev);
  }

  async bookmarkCurrent(bookmark: string): Promise<{ ok: true; commitId: string }> {
    this.bookmarkCurrentCalls.push(bookmark);
    return this.real.bookmarkCurrent(bookmark);
  }

  async rebase(input: { readonly rev: string; readonly newBase: string }): Promise<{
    ok: true;
    newCommitId: string;
    conflicts: string[];
    opIds: string[];
  }> {
    return this.real.rebase(input);
  }

  async moveBookmarkFF(input: {
    readonly bookmark: string;
    readonly toCommit: string;
    readonly expectedCurrent: string;
  }): Promise<{ ok: true; from: string; to: string; opIds: string[] }> {
    this.moveBookmarkFFCalls.push({ ...input });
    return this.real.moveBookmarkFF(input);
  }

  async opLogReceipt(n?: number | undefined): Promise<{ ok: true; opIds: string[] }> {
    return this.real.opLogReceipt(n);
  }
}

// ---------------------------------------------------------------------------
// 环境注入包装：destroy 失败注入（单项 failed 可重试场景）
// ---------------------------------------------------------------------------

export class InjectingEnv implements EnvLifecyclePort {
  private readonly real: ReturnType<typeof createEnvironmentAdapter>;
  readonly failDestroyFor = new Set<string>();
  readonly createdEnvIds: string[] = [];
  readonly destroyCalls: string[] = [];
  readonly suspendCalls: string[] = [];
  readonly resumeCalls: string[] = [];

  constructor(real: ReturnType<typeof createEnvironmentAdapter>) {
    this.real = real;
  }

  async create(input: { readonly workspaceHostPath: string; readonly taskDirRel: string }): Promise<CreateReceipt> {
    const receipt = await this.real.create(input);
    this.createdEnvIds.push(receipt.envInstanceId);
    return receipt;
  }

  async setWritable(envId: string): Promise<SwitchReceipt> {
    return this.real.setWritable(envId);
  }

  async setReadonly(envId: string): Promise<SwitchReceipt> {
    return this.real.setReadonly(envId);
  }

  async destroy(envId: string): Promise<DestroyReceipt> {
    this.destroyCalls.push(envId);
    if (this.failDestroyFor.has(envId)) {
      throw new GovError('E_ENV_LIFECYCLE_FAILED', `注入的 destroy 失败(集成测试): ${envId}`);
    }
    return this.real.destroy(envId);
  }

  async suspend(envId: string): Promise<SuspendReceipt> {
    this.suspendCalls.push(envId);
    return this.real.suspend(envId);
  }

  async resume(envId: string): Promise<ResumeReceipt> {
    this.resumeCalls.push(envId);
    return this.real.resume(envId);
  }
}

// ---------------------------------------------------------------------------
// Orca 受控 Shim：执行派工真启（new-child + claude + 信任种子），评审派工脚本化
// ---------------------------------------------------------------------------

interface FabricatedReceipt {
  readonly dispatchId: string;
  readonly terminalHandle: string;
}

export class DispatchOrcaShim implements OrcaSettlementPort {
  readonly real: OrcaAdapter;
  private readonly repoDirReal: string;
  private readonly repoDisplayName: string;
  /** 脚本化评审派工（dispatchId → 回执事实）。 */
  private readonly fabricated = new Map<string, FabricatedReceipt>();
  private nextFabricated = 1;
  /** 真实执行派工（dispatchId → 预测工作树名），after() 收尾用。 */
  readonly realWorktreeNames: string[] = [];

  readonly taskCreateCalls: Array<{ spec: string }> = [];
  readonly realStarts: string[] = [];
  readonly stopCalls: Array<{ dispatch: string; alreadySettled: boolean | null }> = [];
  readonly releaseCalls: Array<{ dispatch: string; state: string }> = [];

  constructor(real: OrcaAdapter, repoDirReal: string, repoDisplayName: string) {
    this.real = real;
    this.repoDirReal = repoDirReal;
    this.repoDisplayName = repoDisplayName;
  }

  async taskCreate(input: {
    readonly spec: string;
    readonly taskTitle?: string | undefined;
    readonly deps?: readonly string[] | undefined;
    readonly parent?: string | undefined;
  }): Promise<{ ok: true; raw: TaskReceipt }> {
    this.taskCreateCalls.push({ spec: input.spec });
    // 任务书摘要追加受控执行指令：Orca 任务自足（check 一次 + worker_done）。
    return this.real.taskCreate({
      spec: `${input.spec}\n\n${CONTROLLED_WORKER_INSTRUCTION}`,
      ...(input.taskTitle !== undefined ? { taskTitle: input.taskTitle } : {}),
      ...(input.deps !== undefined ? { deps: input.deps } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
    });
  }

  async workerStart(input: {
    readonly task: string;
    readonly worktree: string;
    readonly agent?: string | undefined;
    readonly terminal?: string | undefined;
    readonly retryOf?: string | undefined;
    readonly repo?: string | undefined;
    readonly name?: string | undefined;
  }): Promise<{ ok: true; raw: WorkerStartReceipt }> {
    if (input.agent !== undefined && input.agent !== 'opencode') {
      // 评审派工：脚本化 ready 回执（简报裁定不真启评审员）；身份不命中禁任。
      const n = this.nextFabricated++;
      const dispatchId = `govshim-disp-${n}`;
      const terminalHandle = `govshim-term-${n}`;
      this.fabricated.set(dispatchId, { dispatchId, terminalHandle });
      return {
        ok: true,
        raw: {
          runId: 'govshim-run',
          taskId: input.task,
          dispatchId,
          state: 'ready',
          effects: [{ kind: 'terminal', role: 'agent', id: terminalHandle }],
          residualResources: [],
          terminalHandle,
          sessionId: `govshim-rev-${n}`,
        },
      };
    }
    // 执行派工：真实 new-child 工作树 + claude（适配记录见文件头）。
    const govName = input.worktree.split('/').at(-1) ?? 'govws';
    const name = `w-${govName.replace(/^gt-/, '').replace(/[^A-Za-z0-9._-]/g, '-')}`;
    this.realWorktreeNames.push(name);
    seedClaudeWorkspaceTrust([predictWorktreePath(this.repoDisplayName, name)]);
    const started = await this.real.workerStart({
      task: input.task,
      worktree: 'new-child',
      repo: this.repoDirReal,
      name,
      agent: 'claude',
      ...(input.retryOf !== undefined ? { retryOf: input.retryOf } : {}),
    });
    if (started.raw.state === 'ready') {
      this.realStarts.push(started.raw.dispatchId);
    }
    return started;
  }

  async workerStop(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    const fabricated = this.fabricated.get(dispatch);
    if (fabricated !== undefined) {
      return { ok: true, raw: { dispatchId: dispatch, state: 'stopped', alreadySettled: false, processAction: 'none' } };
    }
    const receipt = await this.real.workerStop(dispatch);
    this.stopCalls.push({ dispatch, alreadySettled: receipt.raw.alreadySettled ?? null });
    return receipt;
  }

  async workerShow(dispatch: string): Promise<{ ok: true; raw: WorkerShowReceipt }> {
    if (this.fabricated.has(dispatch)) {
      return {
        ok: true,
        raw: { dispatch: { id: dispatch, taskId: '', status: 'stopped' }, worker: { dispatchId: dispatch, state: 'stopped' } },
      };
    }
    return this.real.workerShow(dispatch);
  }

  async workerAbandon(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    if (this.fabricated.has(dispatch)) {
      return { ok: true, raw: { dispatchId: dispatch, state: 'abandoned', alreadySettled: true, processAction: 'none' } };
    }
    return this.real.workerAbandon(dispatch);
  }

  async workerRelease(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    if (this.fabricated.has(dispatch)) {
      return { ok: true, raw: { dispatchId: dispatch, state: 'released', alreadySettled: true, processAction: 'none' } };
    }
    const receipt = await this.real.workerRelease(dispatch);
    this.releaseCalls.push({ dispatch, state: receipt.raw.state });
    return receipt;
  }

  async sendToDispatch(input: {
    readonly dispatch: string;
    readonly type: 'status' | 'merge_ready' | 'question';
    readonly subject: string;
    readonly body: string;
    readonly filesModified?: readonly string[] | undefined;
  }): Promise<{ ok: true; raw: unknown }> {
    return this.real.sendToDispatch({
      dispatch: input.dispatch,
      type: input.type,
      subject: input.subject,
      body: input.body,
      ...(input.filesModified !== undefined ? { filesModified: input.filesModified } : {}),
    });
  }
}

// ---------------------------------------------------------------------------
// 轨道（rail）：一场景 = 一临时仓 + 一任务 + 一组服务依赖
// ---------------------------------------------------------------------------

export interface SharedContext {
  readonly stamp: string;
  readonly db: DatabaseSync;
  readonly envReal: ReturnType<typeof createEnvironmentAdapter>;
  readonly env: InjectingEnv;
  readonly orcaReal: OrcaAdapter;
  readonly runId: string;
  readonly rails: Rail[];
  readonly tmpRoots: string[];
}

export interface Rail {
  readonly scenario: string;
  readonly tmpRoot: string;
  readonly repoDir: string;
  readonly repoDirReal: string;
  readonly orcaRepoId: string;
  readonly repoDisplayName: string;
  readonly config: GovConfig;
  readonly jj: CountingJj;
  readonly orca: DispatchOrcaShim;
  readonly spec: Record<string, unknown>;
  readonly taskId: string;
  readonly baseCommit: string;
}

const noOpTrust: TrustProvision = async (): Promise<TrustHandle> => ({ cleanup: async () => {} });

export function lifecycleSpec(scenario: string, repoId: string, baseCommit: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: `gt-t33-${scenario}`,
    problem: `T3.3 生命周期集成场景 ${scenario}`,
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不引入新框架'],
    ownedPaths: ['src/a', 'out'],
    repoId,
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: baseCommit,
    acceptanceCriteria: [
      {
        type: 'command',
        criterionId: 'cmd-1',
        config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
      },
      {
        type: 'artifact',
        criterionId: 'art-1',
        config: { path: 'out/report.md', minBytes: 1, maxBytes: 1_048_576 },
      },
      { type: 'manual', criterionId: 'man-1', config: { description: '人工核验收尾' } },
    ],
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 2, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
  };
}

export async function createSharedContext(): Promise<SharedContext> {
  const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t33it-${STAMP}-shared-`));
  const db = openDatabase(join(tmpRoot, 'gov.db'));
  migrate(db);
  const envReal = createEnvironmentAdapter({ repoRoot: join(import.meta.dirname, '..', '..', '..') });
  const env = new InjectingEnv(envReal);
  const orcaReal = createOrcaAdapter();
  await orcaReal.doctor();
  const run = await orcaReal.runCreate(`gov-t33it-${STAMP} 生命周期集成`);
  return { stamp: STAMP, db, envReal, env, orcaReal, runId: run.raw.run.id, rails: [], tmpRoots: [tmpRoot] };
}

export async function buildRail(shared: SharedContext, scenario: string): Promise<Rail> {
  const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t33it-${STAMP}-${scenario}-`));
  const repoDir = join(tmpRoot, `repo${scenario}`);
  await execJj(tmpRoot, ['git', 'init', '--colocate', repoDir]);
  fs.mkdirSync(join(repoDir, 'src', 'a'), { recursive: true });
  fs.writeFileSync(join(repoDir, 'src', 'a', 'keep.txt'), 'base\n');
  await execJj(repoDir, ['commit', '-m', 'init']);
  const baseCommit = await rawCommitId(repoDir, '@-');
  await execJj(repoDir, ['bookmark', 'create', 'main', '-r', baseCommit]);

  const repoDirReal = fs.realpathSync(repoDir);
  const added = await shared.orcaReal.repoAdd(repoDir);
  const orcaRepoId = added.raw.repo.id;
  const repoDisplayName = added.raw.repo.displayName ?? `repo${scenario}`;

  const config: GovConfig = {
    schemaVersion: 1,
    repos: [{ repoId: `it-${scenario}`, hostPath: repoDir, targets: ['main'] }],
    archiveRoot: join(tmpRoot, 'archive'),
  };
  const jj = new CountingJj(createJjAdapter({ repoRoot: repoDir, config }));
  const orca = new DispatchOrcaShim(shared.orcaReal, repoDirReal, repoDisplayName);
  const rail: Rail = {
    scenario,
    tmpRoot,
    repoDir,
    repoDirReal,
    orcaRepoId,
    repoDisplayName,
    config,
    jj,
    orca,
    spec: lifecycleSpec(scenario, `it-${scenario}`, baseCommit),
    taskId: `gt-t33-${scenario}`,
    baseCommit,
  };
  shared.rails.push(rail);
  shared.tmpRoots.push(tmpRoot);
  return rail;
}

export interface ActiveState {
  readonly claimId: string;
  readonly dispatchId: string;
  readonly workspaceId: string;
  readonly devWsPath: string;
  readonly devEnvId: string;
}

/** 铺到 ACTIVE：declare → claim → gov 立即 workerStop 结算（worker 消失路径）→ accept。 */
export async function driveToActive(rail: Rail, shared: SharedContext): Promise<ActiveState> {
  await declareTask({ db: shared.db, config: rail.config, orca: rail.orca }, { spec: rail.spec, session: DECLARER_SESSION });
  const claims = createClaimService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    trustProvision: noOpTrust,
    stepTimeoutMs: 120_000,
  });
  const claim = await claims.claim(COORD_SESSION, { taskId: rail.taskId });
  // worker 消失路径：启动后立即被 gov workerStop 结算（幂等；后续合并再 stop 已 settled）。
  await rail.orca.workerStop(claim.dispatchId);
  await claims.accept({
    taskId: rail.taskId,
    claimId: claim.claimId,
    tokenClaimId: claim.claimId,
    session: EXEC_SESSION,
  });
  const ws = shared.db
    .prepare('SELECT host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(claim.workspace.workspaceId) as { host_path: string; env_instance_id: string } | undefined;
  if (ws === undefined) {
    throw new Error(`认领工作区行缺失: ${claim.workspace.workspaceId}`);
  }
  return {
    claimId: claim.claimId,
    dispatchId: claim.dispatchId,
    workspaceId: claim.workspace.workspaceId,
    devWsPath: String(ws.host_path),
    devEnvId: String(ws.env_instance_id),
  };
}

export interface ApprovedState extends ActiveState {
  readonly submissionId: string;
  readonly commitId: string;
  readonly reviewId: string;
  readonly reviewerCapabilityId: string;
  readonly artHash: string;
}

/** 铺到 APPROVED：写工作文件 → submit → 建评审 → 接受 → 人工回执 → approved 结论。 */
export async function driveToApproved(rail: Rail, shared: SharedContext): Promise<ApprovedState> {
  const active = await driveToActive(rail, shared);
  // 模拟 worker 开发改动：测试自己经 jj 写入（ownedPaths 内）。
  fs.writeFileSync(join(active.devWsPath, 'src', 'a', `hello-${rail.scenario}.ts`), `export const scenario = '${rail.scenario}';\n`);
  const report = `# report ${rail.scenario}\n内容 ${STAMP}\n`;
  fs.mkdirSync(join(active.devWsPath, 'out'), { recursive: true });
  fs.writeFileSync(join(active.devWsPath, 'out', 'report.md'), report);
  const artHash = sha256(report);

  const submissions = createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj, stepTimeoutMs: 120_000 });
  const submitted = await submissions.submit({
    taskId: rail.taskId,
    claimId: active.claimId,
    tokenClaimId: active.claimId,
    session: EXEC_SESSION,
    evidenceManifest: [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: artHash },
    ],
  });
  if (!isSubmitAccepted(submitted)) {
    throw new Error(`submit 不应要求 rebase: ${JSON.stringify(submitted)}`);
  }

  rail.jj.armEditOnNextRevAdd = true;
  const reviews = createReviewService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    stepTimeoutMs: 120_000,
  });
  const session = await reviews.onMergeReady({ taskId: rail.taskId, session: 'gov-poll' });
  await reviews.reviewAccept({
    taskId: rail.taskId,
    reviewId: session.reviewId,
    tokenReviewId: session.reviewId,
    session: session.reviewerCapabilityId ?? 'reviewer',
  });
  const manual = manualApprove(
    { db: shared.db },
    { taskId: rail.taskId, criterionId: 'man-1', session: OPERATOR_SESSION, note: '集成测试人工核验' },
  );
  const verdict = await reviews.reviewSubmit({
    taskId: rail.taskId,
    reviewId: session.reviewId,
    tokenReviewId: session.reviewId,
    session: session.reviewerCapabilityId ?? 'reviewer',
    payload: {
      verdict: 'approved',
      findings: [],
      evidence: [
        { criterionId: 'cmd-1', exitCode: 0 },
        { criterionId: 'art-1', artifactHash: artHash },
        { criterionId: 'man-1', manualDecisionId: manual.manualDecisionId },
      ],
      reportRef: `gov-it://${rail.taskId}/review-report`,
    },
  });
  if (verdict.taskStatus !== 'APPROVED') {
    throw new Error(`评审结论后任务应为 APPROVED，实际 ${verdict.taskStatus}`);
  }
  return {
    ...active,
    submissionId: submitted.submissionId,
    commitId: submitted.commitId,
    reviewId: session.reviewId,
    reviewerCapabilityId: session.reviewerCapabilityId ?? 'reviewer',
    artHash,
  };
}

// ---------------------------------------------------------------------------
// 断言助手
// ---------------------------------------------------------------------------

export function dockerBin(): string {
  for (const candidate of ['/usr/local/bin/docker', '/opt/homebrew/bin/docker']) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'docker';
}

export async function dockerPsNames(nameFilter: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    dockerBin(),
    ['ps', '-a', '--filter', `name=${nameFilter}`, '--format', '{{.Names}}'],
    { timeout: 30_000, encoding: 'utf8' },
  );
  return stdout.trim().split('\n').filter((line) => line.length > 0);
}

export async function envExists(envId: string): Promise<boolean> {
  return (await dockerPsNames(envId)).length > 0;
}

export function taskStatus(shared: SharedContext, taskId: string): string {
  return String(shared.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status);
}

export function blockedReason(shared: SharedContext, taskId: string): string | null {
  const value = shared.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason;
  return value === null || value === undefined ? null : String(value);
}

export function claimStatus(shared: SharedContext, claimId: string): string {
  return String(shared.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claimId)?.status);
}

export function taskEvents(shared: SharedContext, taskId: string, type: string): Array<Record<string, unknown>> {
  return shared.db
    .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq ASC')
    .all(taskId, type)
    .map((row) => JSON.parse(String(row.payload_json)) as Record<string, unknown>);
}
