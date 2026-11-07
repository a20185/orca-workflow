/**
 * Orca CLI 适配层真实集成测试（T2.1）。fail-loud：Orca runtime 未启动直接红
 * （E_ORCA_RUNTIME_DOWN），不 skip。
 *
 * 资源边界：只在临时 Run + /tmp 临时 colocated 仓上操作；结束回基准——
 * release 全部 dispatch、删 Orca 自建工作树、project setup-delete 注销注册仓根、
 * 删除临时目录与 claude 工作区信任种子，并断言 worktree/repo 清单无残留。
 *
 * 运行前提：测试进程需处于 Orca 管理的终端会话中（orchestration 动词依赖
 * 发送方终端身份）；Orca 桌面运行中。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GovError } from '../../../src/domain/errors.ts';
import {
  assertOrcaVerbAllowed,
  createOrcaAdapter,
  OrcaAdapterError,
  predictWorktreePath,
  SEND_TYPE_WHITELIST,
  type SendType,
} from '../../../src/adapters/orca.ts';

const execFileAsync = promisify(execFile);

const adapter = createOrcaAdapter();

/** 最小受控 worker 提示词：check 一次 → worker_done --outcome failed → 空闲。 */
const WORKER_SPEC = [
  '这是 gov 适配层集成测试的受控任务，立即按以下两步执行，不做任何其他事：',
  '第一步：原样执行注入 preamble 中给出的 check 命令一次（不改任何参数），输出读后即弃，不处理任何消息、不回复任何问题。',
  '第二步：立即按 preamble 中 worker_done 的说明，从本终端发送 worker_done，--outcome failed，正文写「gov 集成测试占位失败」。',
  '发送后立即结束本轮并保持空闲，不轮询、不开始新工作。不要读文件、不要写文件、不要运行测试。',
  'Target: 无。Change: 无。Constraints: 只执行上述两步。Ownership: 无。Observable acceptance: 协调者收到 outcome=failed 的 worker_done。',
].join('\n');

interface Ctx {
  readonly tmpRoot: string; // /tmp 形态（未 realpath），用于验证路径归一化
  repoDir: string;
  readonly runObjective: string;
  repoId?: string;
  repoDisplayName?: string;
  runId?: string;
  taskId?: string;
  mismatchTaskId?: string;
  dispatchIds: string[];
  worktreeNames: string[];
}

/** 前置状态断言辅助：缺失即抛错（测试链断裂应 fail-loud）。 */
function req<T>(value: T | undefined, name: string): T {
  if (value === undefined) {
    throw new Error(`前置状态缺失: ${name}`);
  }
  return value;
}

const stamp = `${Date.now()}`;
// 显式落在 /tmp（macOS 上是 /private/tmp 的符号链接），使路径归一化断言覆盖简报口径。
const ctx: Ctx = {
  tmpRoot: fs.mkdtempSync(join('/', 'tmp', `gov-t21-it-${stamp}-`)),
  repoDir: '',
  runObjective: `gov-t21-it-${stamp}`,
  dispatchIds: [],
  worktreeNames: [],
};
ctx.repoDir = join(ctx.tmpRoot, 'repo');

/** claude 工作区信任预置：Orca 以 TUI 启动 worker claude，未信任目录会卡信任对话框
 * （agent_readiness 失败 agent-trust-workspace）。种子写入 worker claude 实际使用的
 * 配置目录（继承的 CLAUDE_CONFIG_DIR）与默认 ~/.claude.json，结束只删除本测试加的键。 */
const trustSeeds = new Map<string, string[]>();

function seedClaudeWorkspaceTrust(paths: readonly string[]): void {
  const homes = new Set<string>([join(process.env['HOME'] ?? '', '.claude.json')]);
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

function removeClaudeWorkspaceTrustSeeds(): void {
  // 除了本测试写入的种子键，worker claude 会话退出时也会在临时仓/工作树路径下
  // 写入自己的 project 条目；一并清除（尽力而为，容忍与 claude 写盘的竞态）。
  const prefixes = [fs.realpathSync(ctx.tmpRoot)];
  for (const name of ctx.worktreeNames) {
    prefixes.push(predictWorktreePath(ctx.repoDisplayName ?? '', name));
  }
  const files = new Set<string>(trustSeeds.keys());
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  if (configDir !== undefined && configDir.length > 0) {
    files.add(join(configDir, '.claude.json'));
  }
  files.add(join(process.env['HOME'] ?? '', '.claude.json'));
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
      // 清理尽力而为：种子键本身只在临时工作树路径上，孤儿无害。
    }
  }
  trustSeeds.clear();
}

/** 断言抛出 GovError（适配器输入校验是 GovError/E_REQUEST_INVALID；CLI 侧是 OrcaAdapterError）。 */
function expectGovError(fn: () => unknown | Promise<unknown>): Promise<GovError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => assert.fail('期望抛出 GovError'),
      (err: unknown) => {
        assert.ok(err instanceof GovError, `期望 GovError，实际: ${String(err)}`);
        return err;
      },
    );
}

/** 断言抛出 OrcaAdapterError（CLI 调用/结构/门禁失败）。 */
function expectOrcaError(fn: () => unknown | Promise<unknown>): Promise<OrcaAdapterError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => assert.fail('期望抛出 OrcaAdapterError'),
      (err: unknown) => {
        assert.ok(err instanceof OrcaAdapterError, `期望 OrcaAdapterError，实际: ${String(err)}`);
        return err;
      },
    );
}

/** jj 可执行文件解析：测试进程的 PATH 可能不含 Homebrew（spawn ENOENT），按常见绝对路径回退。 */
function resolveJjBin(): string {
  const envBin = process.env['GOV_IT_JJ_BIN'];
  if (envBin !== undefined && envBin.length > 0) {
    return envBin;
  }
  for (const candidate of ['/opt/homebrew/bin/jj', '/usr/local/bin/jj']) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'jj';
}

const jjBin = resolveJjBin();

function jj(repoDir: string, args: readonly string[]): Promise<{ stdout: string }> {
  return execFileAsync(jjBin, [...args], { cwd: repoDir, encoding: 'utf8', timeout: 60_000 });
}

test('doctor：runtime 就绪 + 版本与能力面；不可达 executable → E_ORCA_RUNTIME_DOWN', async () => {
  const receipt = await adapter.doctor();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.runtimeState, 'ready');
  assert.match(receipt.appVersion ?? '', /^1\./);
  assert.ok(Array.isArray(receipt.capabilities));
  assert.ok(receipt.capabilities.length > 0);

  const broken = createOrcaAdapter({ orcaPath: '/nonexistent/orca-binary-for-gov-t21' });
  const err = await expectOrcaError(() => broken.doctor());
  assert.equal(err.code, 'E_ORCA_RUNTIME_DOWN');
});

test('禁用动词：task-update / dispatch --inject / orchestration reset 在白名单层抛错，不派生进程', () => {
  const forbiddenCases: readonly (readonly string[])[] = [
    ['orchestration', 'task-update', '--task', 'task_x', '--status', 'completed', '--json'],
    ['orchestration', 'dispatch', '--inject', '--task', 'task_x', '--terminal', 'term_x', '--json'],
    ['orchestration', 'reset', '--json'],
    ['orchestration', 'gate-resolve', '--json'],
    ['terminal', 'send', '--terminal', 'term_x', '--text', 'hi'],
  ];
  for (const args of forbiddenCases) {
    assert.throws(() => assertOrcaVerbAllowed([...args]), (err: unknown) => {
      assert.ok(err instanceof OrcaAdapterError);
      assert.equal(err.code, 'E_ORCA_FORBIDDEN_VERB');
      return true;
    }, `应拒绝: ${args.join(' ')}`);
  }
  // 白名单内的动词形态放行。
  assert.doesNotThrow(() => assertOrcaVerbAllowed(['status', '--json']));
  assert.doesNotThrow(() => assertOrcaVerbAllowed(['orchestration', 'worker-start', '--task', 't', '--json']));
  // send 面的 type 白名单（数据层防线）。
  assert.deepEqual([...SEND_TYPE_WHITELIST], ['status', 'merge_ready', 'question']);
});

test('路径归一化：/tmp 形态注册成功并归一为 realpath', async () => {
  // 临时 colocated 仓（探针口径 8）：.jj + .git 并存。
  fs.mkdirSync(ctx.repoDir, { recursive: true });
  await jj(ctx.repoDir, ['git', 'init', '--colocate']);
  fs.writeFileSync(join(ctx.repoDir, 'README.md'), `# gov-t21-it ${stamp}\n`);
  await jj(ctx.repoDir, ['commit', '-m', 'init']);
  // 此刻尚无 bookmark → 无默认 base ref，供失败回执测试使用。

  const added = await adapter.repoAdd(ctx.repoDir);
  assert.equal(added.ok, true);
  assert.ok(added.raw.repo.id.length > 0);
  assert.ok(!added.raw.repo.path.startsWith('/tmp/'), 'repo.path 应为 realpath（/private/tmp）形态');
  ctx.repoId = added.raw.repo.id;
  ctx.repoDisplayName = added.raw.repo.displayName ?? 'repo';

  const shown = await adapter.repoShow(ctx.repoDir);
  assert.equal(shown.raw.repo.id, ctx.repoId);
});

test('run-create + run-current：创建并绑定临时 Run', async () => {
  const created = await adapter.runCreate(ctx.runObjective);
  assert.equal(created.ok, true);
  assert.ok(created.raw.run.id.startsWith('run_'));
  assert.equal(created.raw.run.objective, ctx.runObjective);
  ctx.runId = created.raw.run.id;

  const current = await adapter.runCurrent();
  assert.equal(current.raw.run.id, ctx.runId);
});

test('task-create：任务落在当前 Run', async () => {
  const created = await adapter.taskCreate({ spec: WORKER_SPEC, taskTitle: `gov-t21-it-${stamp}` });
  assert.equal(created.ok, true);
  assert.ok(created.raw.task.id.startsWith('task_'));
  assert.equal(created.raw.task.run_id, ctx.runId);
  assert.equal(created.raw.task.status, 'ready');
  ctx.taskId = created.raw.task.id;

  const mismatchTask = await adapter.taskCreate({ spec: 'terminal mismatch 探针任务，不应被执行。' });
  ctx.mismatchTaskId = mismatchTask.raw.task.id;
});

test('worker-start 失败回执：无 base ref → failedStage + residualResources 保留', async () => {
  const receipt = await adapter.workerStart({
    task: req(ctx.taskId, 'taskId'),
    worktree: 'new-child',
    repo: ctx.repoDir,
    name: 'no-baseref',
    agent: 'claude',
  });
  // 失败/不确定结局是回执而非异常（CLI ok:true + exit 1）。
  assert.equal(receipt.ok, true);
  assert.equal(receipt.raw.state, 'failed');
  assert.equal(receipt.raw.failedStage, 'worktree_create');
  assert.ok(Array.isArray(receipt.raw.residualResources));
  assert.ok(typeof receipt.raw.lastError === 'string' && receipt.raw.lastError.length > 0);
  ctx.dispatchIds.push(receipt.raw.dispatchId);
  ctx.worktreeNames.push('no-baseref');
});

test('retry-of 重派：建立 base ref + 信任预置后真实 claude worker 启动成功', async () => {
  const log = await jj(ctx.repoDir, ['log', '-r', '@-', '--no-graph', '-T', 'commit_id']);
  const sha = log.stdout.trim();
  assert.match(sha, /^[0-9a-f]{40}$/);
  await jj(ctx.repoDir, ['bookmark', 'create', 'main', '-r', sha]);

  const name = 'w1';
  seedClaudeWorkspaceTrust([predictWorktreePath(ctx.repoDisplayName ?? '', name)]);
  ctx.worktreeNames.push(name);

  const started = await adapter.workerStart({
    task: req(ctx.taskId, 'taskId'),
    retryOf: req(ctx.dispatchIds.at(-1), 'failedDispatch'),
    worktree: 'new-child',
    repo: ctx.repoDir,
    name,
    agent: 'claude',
  });
  assert.equal(started.ok, true);
  assert.equal(started.raw.state, 'ready');
  assert.ok(started.raw.dispatchId.length > 0);
  assert.ok(started.raw.terminalHandle !== undefined, 'ready 回执应含 terminal handle');
  assert.deepEqual(started.raw.residualResources, [], 'ready 回执不应有残留资源');
  ctx.dispatchIds.push(started.raw.dispatchId);
});

test('重复启动拒绝：活跃 Task 再启动 → E_ORCA_CALL_FAILED / task_not_startable', async () => {
  const err = await expectOrcaError(() =>
    adapter.workerStart({
      task: req(ctx.taskId, 'taskId'),
      worktree: 'new-child',
      repo: ctx.repoDir,
      name: 'dup-start',
      agent: 'claude',
    }),
  );
  assert.equal(err.code, 'E_ORCA_CALL_FAILED');
  assert.equal(err.detail.orcaErrorCode, 'task_not_startable');
});

test('终端不匹配：--terminal 复用他树终端 → terminal_worktree_mismatch', async () => {
  // 复用 w1 的 agent 终端（属于临时仓工作树）+ current（协调者工作树）→ 校验层拒绝。
  const list = await adapter.workerList({ run: req(ctx.runId, 'runId') });
  const w1row = list.raw.workers?.find((w) => w.dispatchId === ctx.dispatchIds[ctx.dispatchIds.length - 1]);
  const terminalHandle = w1row?.agentTerminalHandle;
  assert.ok(typeof terminalHandle === 'string' && terminalHandle.length > 0, 'worker-list 应暴露 w1 的 agentTerminalHandle');

  const err = await expectOrcaError(() =>
    adapter.workerStart({
      task: req(ctx.mismatchTaskId, 'mismatchTaskId'),
      terminal: terminalHandle,
      worktree: 'current',
    }),
  );
  assert.equal(err.code, 'E_ORCA_CALL_FAILED');
  assert.equal(err.detail.orcaErrorCode, 'terminal_worktree_mismatch');
});

test('定向消息：协调者车道 send --to dispatch:<id>（省略 --from）；type 白名单拒绝', async () => {
  const dispatch = req(ctx.dispatchIds.at(-1), 'dispatch');
  const sent = await adapter.sendToDispatch({
    dispatch,
    type: 'status',
    subject: `gov-t21-it-${stamp} 定向消息`,
    body: '协调者定向消息探针：请忽略本消息，按原计划继续并按任务说明结束。',
  });
  assert.equal(sent.ok, true);
  assert.ok(sent.raw.message.id.startsWith('msg_'));
  assert.equal(sent.raw.message.to_handle, `dispatch:${dispatch}`);
  assert.equal(sent.raw.message.type, 'status');

  const badType = await expectGovError(() =>
    adapter.sendToDispatch({
      dispatch,
      type: 'worker_done' as SendType,
      subject: 'x',
      body: 'x',
    }),
  );
  assert.equal(badType.code, 'E_REQUEST_INVALID');
});

test('checkRun --wait：收到 worker_done（outcome=failed）并 ack', async () => {
  const waited = await adapter.checkRun({
    runId: req(ctx.runId, 'runId'),
    wait: true,
    types: ['worker_done', 'escalation', 'question'],
    timeoutMs: 300_000,
  });
  assert.equal(waited.ok, true);
  assert.ok(waited.raw.deliveryId !== null && waited.raw.deliveryId !== undefined);
  const done = waited.raw.messages.find((m) => m.type === 'worker_done');
  assert.ok(done !== undefined, '应收到 worker_done');
  assert.ok((done.payload ?? '').includes('"outcome":"failed"'));
  assert.ok((done.payload ?? '').includes(req(ctx.dispatchIds.at(-1), 'dispatch')));

  const acked = await adapter.checkRun({ runId: req(ctx.runId, 'runId'), ackDeliveryId: req(waited.raw.deliveryId, 'deliveryId') });
  assert.equal(acked.raw.acknowledged, waited.raw.deliveryId);
  assert.equal(acked.raw.count, 0, 'ack 后协调者收件箱应无待处理批');
});

test('worker-show：结算状态可见', async () => {
  const dispatch = req(ctx.dispatchIds.at(-1), 'dispatch');
  const shown = await adapter.workerShow(dispatch);
  assert.equal(shown.raw.dispatch.id, dispatch);
  assert.equal(shown.raw.dispatch.status, 'failed');
  assert.equal(shown.raw.worker.state, 'failed');
});

test('worker-read 边界：limit 可下调不可上调', async () => {
  const dispatch = req(ctx.dispatchIds.at(-1), 'dispatch');
  const read = await adapter.workerRead({ dispatch, limit: 10 });
  assert.equal(read.ok, true);
  assert.ok((read.raw.terminal?.tail ?? []).length <= 10);

  const tooBig = await expectGovError(() => adapter.workerRead({ dispatch, limit: 500 }));
  assert.equal(tooBig.code, 'E_REQUEST_INVALID');
  const zero = await expectGovError(() => adapter.workerRead({ dispatch, limit: 0 }));
  assert.equal(zero.code, 'E_REQUEST_INVALID');
});

test('terminalRead 边界：行数上限与游标续读', async () => {
  const list = await adapter.workerList({ run: req(ctx.runId, 'runId') });
  const row = list.raw.workers?.find((w) => w.dispatchId === ctx.dispatchIds[ctx.dispatchIds.length - 1]);
  const handle = row?.agentTerminalHandle;
  assert.ok(typeof handle === 'string' && handle.length > 0, 'worker-list 应暴露 w1 的 agentTerminalHandle');

  const first = await adapter.terminalRead({ terminal: handle, limit: 10 });
  assert.ok(first.raw.terminal.tail.length <= 10);
  assert.equal(first.raw.terminal.handle, handle);

  const next = await adapter.terminalRead({ terminal: handle, cursor: req(first.raw.terminal.nextCursor, 'nextCursor'), limit: 5 });
  assert.ok(next.raw.terminal.tail.length <= 5);

  const tooBig = await expectGovError(() => adapter.terminalRead({ terminal: handle, limit: 201 }));
  assert.equal(tooBig.code, 'E_REQUEST_INVALID');
});

test('worker-stop 幂等：已结算 Dispatch → alreadySettled + 无进程动作', async () => {
  const dispatch = req(ctx.dispatchIds.at(-1), 'dispatch');
  for (let i = 0; i < 2; i++) {
    const stopped = await adapter.workerStop(dispatch);
    assert.equal(stopped.ok, true);
    assert.equal(stopped.raw.dispatchId, dispatch);
    assert.equal(stopped.raw.alreadySettled, true);
    assert.equal(stopped.raw.processAction, 'none');
  }
});

test('worker-release 收尾 + 幂等：released → already_released', async () => {
  const dispatch = req(ctx.dispatchIds.at(-1), 'dispatch');
  const first = await adapter.workerRelease(dispatch);
  assert.ok(first.raw.state === 'released' || first.raw.state === 'already_released');
  const second = await adapter.workerRelease(dispatch);
  assert.equal(second.raw.state, 'already_released');
});

test('searchSessions 上限：命中数不超过 limit；limit>20 拒绝', async () => {
  const found = await adapter.searchSessions({ query: 'gov-t21-it', limit: 3 });
  assert.equal(found.ok, true);
  assert.ok(found.raw.hits.length <= 3);
  assert.equal(found.raw.kind, 'results');

  const tooBig = await expectGovError(() => adapter.searchSessions({ query: 'gov-t21-it', limit: 21 }));
  assert.equal(tooBig.code, 'E_REQUEST_INVALID');
});

test('run-use 协调恢复：重新绑定既有 Run 且 run-current 一致', async () => {
  const rebound = await adapter.runUse(req(ctx.runId, 'runId'));
  assert.equal(rebound.ok, true);
  assert.equal(rebound.raw.run.id, ctx.runId);
  const current = await adapter.runCurrent();
  assert.equal(current.raw.run.id, ctx.runId);
});

after(async () => {
  const cleanupErrors: unknown[] = [];
  // 1. release 全部本测试创建的 dispatch（幂等，已 release 的报 already_released）。
  for (const dispatch of ctx.dispatchIds) {
    try {
      await adapter.workerRelease(dispatch);
    } catch (err) {
      if (!(err instanceof OrcaAdapterError && err.detail.orcaErrorCode === 'dispatch_inactive')) {
        cleanupErrors.push(err);
      }
    }
  }
  // 2. 删除临时仓下全部 Orca 自建工作树（跳过注册仓根：protected）。
  try {
    const listed = await adapter.worktreeList({ repo: ctx.repoDir });
    for (const wt of listed.raw.worktrees) {
      if (wt.isMainWorktree === true || !wt.path.includes('orca/workspaces')) {
        continue;
      }
      await adapter.worktreeRm(wt.path);
    }
  } catch (err) {
    cleanupErrors.push(err);
  }
  // 3. 注销注册仓根。
  if (ctx.repoId !== undefined) {
    try {
      await adapter.projectSetupDelete(ctx.repoId);
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  // 4. 临时目录与信任种子。
  removeClaudeWorkspaceTrustSeeds();
  try {
    fs.rmSync(ctx.tmpRoot, { recursive: true, force: true });
  } catch (err) {
    cleanupErrors.push(err);
  }
  // 5. 基准断言：repo 与 worktree 清单无本测试残留。
  try {
    const gone = await expectOrcaError(() => adapter.repoShow(ctx.repoDir));
    assert.equal(gone.detail.orcaErrorCode, 'repo_not_found');
  } catch (err) {
    cleanupErrors.push(err);
  }
  try {
    const all = await adapter.worktreeList();
    const leaked = all.raw.worktrees.filter((w) => w.path.includes(`gov-t21-it-${stamp}`));
    assert.deepEqual(leaked.map((w) => w.path), [], 'worktree 清单应回基准，无 gov-t21-it 残留');
  } catch (err) {
    cleanupErrors.push(err);
  }
  if (ctx.mismatchTaskId !== undefined) {
    // mismatch 任务从未启动，无资源需要回收；仅确保没有 dispatch 挂在上面。
    try {
      const list = await adapter.workerList({ run: req(ctx.runId, 'runId') });
      const active = list.raw.workers?.filter((w) => w.taskId === ctx.mismatchTaskId) ?? [];
      assert.equal(active.length, 0, 'mismatch 任务不应产生 dispatch');
    } catch (err) {
      cleanupErrors.push(err);
    }
  }
  assert.deepEqual(cleanupErrors, [], `清理阶段不应有错误: ${cleanupErrors.map(String).join('; ')}`);
});
