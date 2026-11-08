/**
 * T5.1 受限启动器隔离测试（真实容器 + 真实 gov API + 真实桌面 runtime）。
 * fail-loud：Docker / 桌面 Orca runtime / runtime 配对设备 / gov server 任一
 * 不可用直接红，不 skip（与 T2.3 集测同口径）。
 *
 * 传输通道（Phase 5.1 探针候选 A，实证记录见 execution/phase-5.1-report.md）：
 * 容器内真 CLI 以 ORCA_PAIRING_CODE（桌面设备注册表 runtime-scope 设备 +
 * E2EE 公钥重构的 orca://pair?... 码）连 ws://host.docker.internal:<port> 回
 * 桌面 runtime——同一 runtimeId，不在容器内跑 `orca serve`。gov API 经
 * host.docker.internal 回连宿主 127.0.0.1 随机端口（Docker Desktop 代理实测）。
 *
 * 正向链夹具（无模型调用）：`terminal create --command bash` + `terminal send`
 * 在终端内执行 run-create，把该终端绑为 Run coordinator；guard orca check
 * --terminal <该终端> 即返回该 Run 邮箱（T0.3 正向链复现的证据面）。
 * gov 侧 fixture 直接落库：任务 gt-* + 认领 DISPATCHED（terminal_handle =
 * 夹具终端、dispatch_id 为夹具合成值——check 不消费 dispatch，真实派工回执
 * 归 T5.2/T6.x 接线）。
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { issueToken } from '../../../src/auth.ts';
import { GOV_ACTIONS_BY_ROLE } from '../../../src/domain/roles.ts';
import { createHostPaths, bootHost, type TestHost } from '../../unit/api/testing.ts';

const execFileAsync = promisify(execFile);

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const dockerBin = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find((p) => fs.existsSync(p)) ?? 'docker';
const orcaBin = '/Applications/Orca.app/Contents/Resources/bin/orca';
const orcaResources = '/Applications/Orca.app/Contents/Resources';
const orcaUserData = path.join(os.homedir(), 'Library', 'Application Support', 'orca');

interface ExecResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number | string;
  readonly ok: boolean;
}

function run(bin: string, args: readonly string[], opts: { readonly timeoutMs?: number } = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      bin,
      [...args],
      { timeout: opts.timeoutMs ?? 30_000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0, ok: true });
        } else {
          const e = err as { code?: unknown; killed?: boolean };
          resolve({
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            code: typeof e.code === 'number' ? e.code : e.killed ? 'TIMEOUT' : 'SPAWN',
            ok: false,
          });
        }
      },
    );
  });
}

function shQuote(text: string): string {
  return `'${text.replaceAll("'", `'\\''`)}'`;
}

/** 从 Orca 回执 JSON 里抓 ok:true 的 result；失败抛原文。 */
function parseOkJson(stdout: string, what: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`${what} 输出不是 JSON: ${stdout.slice(0, 400)} (${(err as Error).message})`);
  }
  const body = parsed as { ok?: unknown; result?: unknown; error?: unknown };
  if (body.ok !== true || typeof body.result !== 'object' || body.result === null) {
    throw new Error(`${what} 未返回 ok:true: ${stdout.slice(0, 400)}`);
  }
  return body.result as Record<string, unknown>;
}

/** 桌面设备注册表 → CLI 远端配对码（候选 A：runtime-scope 设备 + E2EE 公钥）。 */
function mintPairingCode(): { readonly code: string; readonly wsPort: number } {
  const devices = JSON.parse(fs.readFileSync(path.join(orcaUserData, 'orca-devices.json'), 'utf8')) as Array<{
    scope?: string;
    lastSeenAt?: number;
    token: string;
    deviceId: string;
  }>;
  const runtimeDevices = devices.filter((d) => d.scope === 'runtime');
  const device = runtimeDevices.find((d) => (d.lastSeenAt ?? 0) === 0) ?? runtimeDevices[0];
  if (device === undefined) {
    throw new Error(
      `桌面设备注册表无 runtime-scope 设备（${orcaUserData}/orca-devices.json）。` +
        '补救：在 Orca 桌面设置里打开一次 runtime 配对面（生成 CLI 配对码）后重跑。',
    );
  }
  const keypair = JSON.parse(fs.readFileSync(path.join(orcaUserData, 'orca-e2ee-keypair.json'), 'utf8')) as {
    publicKeyB64: string;
  };
  const runtimeMeta = JSON.parse(fs.readFileSync(path.join(orcaUserData, 'orca-runtime.json'), 'utf8')) as {
    transports?: Array<{ kind?: string; endpoint?: string }>;
  };
  const wsEndpoint = runtimeMeta.transports?.find((t) => t.kind === 'websocket')?.endpoint ?? '';
  const wsPort = Number(/:(\d+)$/.exec(wsEndpoint)?.[1] ?? 0);
  if (wsPort === 0) {
    throw new Error(`桌面 runtime 元数据无 websocket 传输端口: ${wsEndpoint}`);
  }
  const offer = {
    v: 2,
    endpoint: `ws://host.docker.internal:${wsPort}`,
    deviceToken: device.token,
    publicKeyB64: keypair.publicKeyB64,
    pairedDeviceId: device.deviceId,
    scope: 'runtime',
  };
  const b64 = Buffer.from(JSON.stringify(offer), 'utf8').toString('base64url').replace(/=+$/, '');
  return { code: `orca://pair?code=${b64}`, wsPort };
}

/** 真 CLI bundle：app.asar.unpacked 的 out/{cli,shared,main,package.json} + Resources/node_modules。 */
function prepareCliBundle(bundleDir: string): void {
  fs.rmSync(bundleDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(bundleDir, 'out'), { recursive: true });
  for (const part of ['cli', 'shared', 'main']) {
    fs.cpSync(path.join(orcaResources, 'app.asar.unpacked', 'out', part), path.join(bundleDir, 'out', part), {
      recursive: true,
    });
  }
  // out/package.json（version/commit 戳）是 cli-version 的读取面，缺它 --version 退出非零。
  fs.copyFileSync(
    path.join(orcaResources, 'app.asar.unpacked', 'out', 'package.json'),
    path.join(bundleDir, 'out', 'package.json'),
  );
  fs.cpSync(path.join(orcaResources, 'node_modules'), path.join(bundleDir, 'node_modules'), { recursive: true });
}

interface Fixture {
  readonly container: string;
  readonly imageTag: string;
  readonly host: TestHost;
  readonly govTaskId: string;
  readonly govClaimId: string;
  readonly executorToken: string;
  readonly terminalHandle: string;
  readonly runId: string;
  readonly fixtureDispatchId: string;
  readonly wsRoot: string;
  readonly pairingCode: string;
  readonly desktopRuntimeId: string;
}

let fixture: Fixture | null = null;

function fx(): Fixture {
  if (fixture === null) {
    throw new Error('fixture 未初始化');
  }
  return fixture;
}

/** docker exec（任务用户）跑 sh -c。 */
async function taskSh(command: string, env: readonly string[] = [], timeoutMs = 60_000): Promise<ExecResult> {
  const args = ['exec', '-u', '1000:1000'];
  for (const e of env) {
    args.push('-e', e);
  }
  args.push(fx().container, 'sh', '-c', command);
  return run(dockerBin, args, { timeoutMs });
}

/** 任务用户 → sudo → guard（唯一授权入口）。 */
async function guard(args: readonly string[], env: readonly string[] = [], timeoutMs = 90_000): Promise<ExecResult> {
  return taskSh(`sudo -n -u orca-broker /usr/local/lib/gov/guard ${args.map(shQuote).join(' ')}`, env, timeoutMs);
}

/** 从 guard/CLI 的 stdout 解析单帧 JSON（丢弃 sudo 主机名告警等 stderr 噪声）。 */
function stdoutJson(result: ExecResult): Record<string, unknown> {
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

before(async () => {
  // 失败时收尾已建资源（server/终端/容器），让错误信息可见且进程可退出。
  let createdTerminal: string | null = null;
  let createdHost: TestHost | null = null;
  let createdContainer: string | null = null;
  let createdWsRoot: string | null = null;
  try {
  // --- 桌面 runtime 与传输通道前置 ----------------------------------------
  const status = await run(orcaBin, ['status', '--json']);
  const statusBody = parseOkJson(status.stdout, 'orca status');
  const runtime = (statusBody['runtime'] ?? {}) as { state?: string; reachable?: boolean; runtimeId?: string };
  assert.equal(runtime.state, 'ready', `桌面 runtime 未就绪: ${JSON.stringify(runtime)}`);
  const pairing = mintPairingCode();

  // --- gov server + 夹具（真实 HTTP 面；容器经 host.docker.internal 回连） ----
  const paths = createHostPaths();
  const host = await bootHost(paths);
  createdHost = host;
  const taskId = `gt-t51iso-${crypto.randomBytes(6).toString('hex')}`;
  const claimId = `gcl_${crypto.randomBytes(12).toString('base64url')}`;
  const now = new Date().toISOString();
  const fixtureDispatchId = `ctx_t51fixture-${crypto.randomBytes(6).toString('hex')}`;

  // --- 正向链夹具：bash 终端内 typed run-create 绑 coordinator -------------
  const termOut = await run(orcaBin, ['terminal', 'create', '--command', 'bash', '--json']);
  const terminalHandle = String(
    ((parseOkJson(termOut.stdout, 'terminal create')['terminal'] ?? {}) as { handle?: string }).handle ?? '',
  );
  assert.match(terminalHandle, /^term_/, `terminal create 未返回 handle: ${termOut.stdout.slice(0, 200)}`);
  createdTerminal = terminalHandle;
  await run(orcaBin, ['terminal', 'send', '--terminal', terminalHandle, '--text',
    `orca orchestration run-create --objective "T5.1 guard isolation fixture" --json > /tmp/gov-t51-run.json 2>&1`]);
  await run(orcaBin, ['terminal', 'send', '--terminal', terminalHandle, '--text', '\r']);
  let runId = '';
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const check = await run(orcaBin, ['orchestration', 'check', '--terminal', terminalHandle, '--json']);
    try {
      runId = String(parseOkJson(check.stdout, 'fixture check')['runId'] ?? '');
    } catch {
      runId = '';
    }
    if (runId !== '') {
      break;
    }
  }
  assert.match(runId, /^run_/, '夹具终端 20s 内未绑定 Run（typed run-create 未生效）');

  // --- gov 库夹具：任务 ACTIVE + 当前认领 DISPATCHED ------------------------
  //（外键次序：先任务（current_claim_id 空）→ 认领 → 回填 current_claim_id → 签发令牌）
  host.db
    .prepare(
      `INSERT INTO tasks (task_id, spec_hash, status, target_json, declared_session, created_at, updated_at)
       VALUES (?, ?, 'ACTIVE', '{}', 'gcap_t51_fixture', ?, ?)`,
    )
    .run(taskId, `sha256:${createHash('sha256').update('t51-fixture').digest('hex')}`, now, now);
  host.db
    .prepare(
      `INSERT INTO claims (claim_id, task_id, dispatch_id, claimer_session, terminal_handle, status, token_hash, created_at, updated_at)
       VALUES (?, ?, ?, 'gcap_t51_fixture', ?, 'DISPATCHED', NULL, ?, ?)`,
    )
    .run(claimId, taskId, fixtureDispatchId, terminalHandle, now, now);
  host.db
    .prepare('UPDATE tasks SET current_claim_id = ? WHERE task_id = ?')
    .run(claimId, taskId);
  const executorToken = issueToken(host.db, {
    role: 'executor',
    taskId,
    claimId,
    actions: [...GOV_ACTIONS_BY_ROLE.executor, 'guard-authorize'],
    ttlSeconds: 3600,
  });

  // --- 工作区 + 恶意材料 + 真 CLI bundle ------------------------------------
  const wsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-t51-iso-'));
  createdWsRoot = wsRoot;
  const taskDir = path.join(wsRoot, 'task-w');
  fs.mkdirSync(taskDir, { recursive: true });
  // .git/.jj 必须存在：tmpfs 遮蔽挂载点由 bind mount 提供，空工作区会让 docker
  // 在只读根文件层 mkdir 挂载点失败（T2.3 集测用 colocated 工作区天然满足）。
  fs.mkdirSync(path.join(wsRoot, '.git'), { recursive: true });
  fs.mkdirSync(path.join(wsRoot, '.jj'), { recursive: true });
  fs.writeFileSync(path.join(wsRoot, 'orca.yaml'), '%%% 故意损坏的配置 [not: valid: yaml {{{\n');
  fs.writeFileSync(path.join(wsRoot, 'package.json'), '{"name":"evil-repo-config","version":"0.0.1"}');
  const plantedModule = path.join(taskDir, 'node_modules', 'ws');
  fs.mkdirSync(plantedModule, { recursive: true });
  fs.writeFileSync(path.join(plantedModule, 'package.json'), '{"name":"ws","version":"0.0.0-pwned","main":"index.js"}');
  fs.writeFileSync(
    path.join(plantedModule, 'index.js'),
    'require("fs").writeFileSync("/tmp/gov-t51-pwned-marker", "loaded");\nmodule.exports = {};\n',
  );
  const bundleDir = path.join(os.tmpdir(), `gov-t51-cli-bundle-${crypto.randomBytes(4).toString('hex')}`);
  prepareCliBundle(bundleDir);

  // --- create.sh 全链部署（镜像构建 + guard 面 + 信任种子） ------------------
  const imageTag = `gov-t51-iso:${crypto.randomBytes(4).toString('hex')}`;
  const identity = {
    token: executorToken.token,
    govBaseUrl: `http://host.docker.internal:${host.server.port}`,
    taskId,
    claimId,
    terminalHandle,
    dispatchId: fixtureDispatchId,
    orcaPairingCode: pairing.code,
  };
  const createEnv = {
    ...process.env,
    GOV_VM_IMAGE_TAG: imageTag,
    GOV_GUARD_ORCA_BUNDLE: bundleDir,
    GOV_GUARD_IDENTITY: JSON.stringify(identity),
  };
  const createOut = await new Promise<ExecResult>((resolve) => {
    execFile(
      path.join(repoRoot, 'scripts', 'orca-vm', 'create.sh'),
      [wsRoot, 'task-w'],
      { timeout: 420_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: createEnv },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0, ok: true });
        } else {
          const e = err as { code?: unknown; killed?: boolean };
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof e.code === 'number' ? e.code : 'TIMEOUT', ok: false });
        }
      },
    );
  });
  if (!createOut.ok) {
    throw new Error(`create.sh 失败 (exit ${createOut.code}): ${createOut.stderr.slice(-2000)}`);
  }
  // create.sh 成功信封是 recipe 形态（无 ok 字段）：直接按结构解析。
  const recipe = JSON.parse(createOut.stdout) as { userData?: { resourceId?: string } };
  const container = String(recipe.userData?.resourceId ?? '');
  assert.match(container, /^gov-vm-/, `create.sh 未返回 resourceId: ${createOut.stdout.slice(0, 300)}`);
  createdContainer = container;

  // create.sh 尾声把可写区置 0000（accept 前只读）；隔离测试要读恶意材料，
  // 宿主侧恢复 0777 使「未被读取」的断言有区分度（0000 下拒读是平凡通过）。
  fs.chmodSync(taskDir, 0o777);

  fixture = {
    container,
    imageTag,
    host,
    govTaskId: taskId,
    govClaimId: claimId,
    executorToken: executorToken.token,
    terminalHandle,
    runId,
    fixtureDispatchId,
    wsRoot,
    pairingCode: pairing.code,
    desktopRuntimeId: String(runtime.runtimeId ?? ''),
  };
  } catch (err) {
    // 失败收尾：不留 server/终端/容器残骸，再抛原始错误。
    if (createdContainer !== null) {
      await new Promise<void>((resolve) => {
        const child = spawn(
          path.join(repoRoot, 'scripts', 'orca-vm', 'destroy.sh'),
          [],
          { stdio: ['pipe', 'ignore', 'ignore'] },
        );
        child.stdin.write(`${JSON.stringify({ schemaVersion: 1, userData: { resourceId: createdContainer } })}\n`);
        child.stdin.end();
        child.on('exit', () => resolve());
        child.on('error', () => resolve());
      });
    }
    if (createdTerminal !== null) {
      await run(orcaBin, ['terminal', 'close', '--terminal', createdTerminal, '--json']);
    }
    if (createdHost !== null) {
      await createdHost.dispose();
    }
    if (createdWsRoot !== null) {
      try {
        fs.rmSync(createdWsRoot, { recursive: true, force: true });
      } catch {
        // 收尾尽力而为。
      }
    }
    throw err;
  }
});

after(async () => {
  if (fixture === null) {
    return;
  }
  const { container, host, terminalHandle, wsRoot, imageTag } = fixture;
  fixture = null;
  // 终端关闭（夹具终端）；Run 行按 T0.3 先例留作审计（无 run 删除通道）。
  await run(orcaBin, ['terminal', 'close', '--terminal', terminalHandle, '--json']).catch(() => undefined as never);
  const destroyEnv = { ...process.env };
  await new Promise<void>((resolve) => {
    const child = spawn(
      path.join(repoRoot, 'scripts', 'orca-vm', 'destroy.sh'),
      [],
      { env: destroyEnv, stdio: ['pipe', 'ignore', 'ignore'] },
    );
    child.stdin.write(`${JSON.stringify({ schemaVersion: 1, userData: { resourceId: container } })}\n`);
    child.stdin.end();
    child.on('exit', () => resolve());
  });
  await host.dispose();
  // macOS virtiofs 删除有短暂竞态（ENOTEMPTY）：重试三次。
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.rmSync(wsRoot, { recursive: true, force: true });
      break;
    } catch (err) {
      if (i === 2) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  await run(dockerBin, ['rmi', '-f', imageTag]);
  const left = await run(dockerBin, ['ps', '-a', '--format', '{{.Names}}']);
  assert.ok(!left.stdout.split('\n').includes(container), `容器残留: ${container}`);
});

describe('T5.1 guard 隔离（真实容器 + 真实 gov + 真实 runtime）', () => {
  test('正向链：guard orca check 返回夹具 Run 邮箱（T0.3 复现）', async () => {
    const result = await guard(['orca', 'check']);
    assert.equal(result.code, 0, `guard orca check 失败: ${result.stderr.slice(0, 400)}\n${result.stdout.slice(0, 400)}`);
    const body = stdoutJson(result);
    assert.equal(body.ok, true);
    const checkResult = body.result as { runId?: string; dispatchId?: string | null; messages?: unknown[] };
    assert.equal(checkResult.runId, fx().runId, 'check 应返回夹具终端绑定的 Run 邮箱');
    assert.ok(Array.isArray(checkResult.messages), 'mailbox messages 应为数组');
  });

  test('垫片入口：/usr/local/bin/orca（preamble 裸命令名）仍经 guard', async () => {
    const result = await taskSh('PATH=/usr/local/bin:/usr/bin:/bin orca check');
    assert.equal(result.code, 0, `垫片路径失败: ${result.stderr.slice(0, 400)}`);
    const body = stdoutJson(result);
    assert.equal((body.result as { runId?: string }).runId, fx().runId);
  });

  test('任务用户直接执行真 CLI 被拒（broker 0700 目录）', async () => {
    const result = await taskSh('/opt/orca-broker/bin/orca --version');
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /denied|Permission|EACCES/i, `应因权限拒绝: ${result.stderr.slice(0, 200)}`);
  });

  test('guard 非 broker 身份运行被拒（root 与任务用户都被 0600 身份文件挡住）', async () => {
    const asRoot = await run(dockerBin, ['exec', '-u', '0', fx().container, '/usr/local/lib/gov/guard', 'gov', 'status']);
    assert.equal(asRoot.code, 5, `root 直接跑 guard 应 exit 5: ${asRoot.stderr.slice(0, 200)}`);
    const asTask = await run(dockerBin, ['exec', '-u', '1000:1000', fx().container, '/usr/local/lib/gov/guard', 'gov', 'status']);
    assert.equal(asTask.code, 5, `任务用户直跑 guard 应 exit 5: ${asTask.stderr.slice(0, 200)}`);
  });

  test('PATH 垫片替换：前置假 orca 无任何旁路，真动作仍入 guard', async () => {
    const install = await taskSh(
      'mkdir -p ~/shim && printf \'#!/bin/sh\\necho FAKE-ORCA-RAN >&2\\ncat /opt/orca-broker/bin/orca >&2 2>&1\\n' +
      'cat /var/lib/orca-broker/identity.json >&2 2>&1\\nexec /usr/local/bin/orca "$@"\\n\' > ~/shim/orca && chmod +x ~/shim/orca',
    );
    assert.equal(install.code, 0, install.stderr);
    const result = await taskSh('PATH=$HOME/shim:/usr/local/bin:/usr/bin:/bin orca check');
    assert.match(result.stderr, /FAKE-ORCA-RAN/, '前置垫片应被执行（PATH 命中）');
    assert.match(result.stderr, /denied|Permission|EACCES/i, '假垫片读真 CLI 应被拒');
    const identityLeak = await taskSh('PATH=$HOME/shim:$PATH orca check 2>&1 >/dev/null | grep -c govt_ || true');
    assert.equal(identityLeak.stdout.trim(), '0', '假垫片读不到身份令牌（govt_ 零泄漏）');
    assert.equal(result.code, 0, `转发真垫片后应成功: ${result.stderr.slice(0, 400)}`);
    assert.equal((stdoutJson(result).result as { runId?: string }).runId, fx().runId);
  });

  test('环境变量伪造（ORCA_*/GOV_*）不影响身份与传输', async () => {
    const result = await guard(
      ['orca', 'check'],
      [
        'ORCA_PAIRING_CODE=garbage',
        'ORCA_TERMINAL_HANDLE=term_evil',
        'ORCA_AGENT_LAUNCH_TOKEN=forged',
        'GOV_TOKEN=govt_forged',
        'TASK_ID=gt-evil',
        'DISPATCH_ID=ctx_evil',
      ],
    );
    assert.equal(result.code, 0, `guard 应忽略伪造 env: ${result.stderr.slice(0, 400)}`);
    const body = stdoutJson(result);
    assert.equal((body.result as { runId?: string }).runId, fx().runId, '伪造终端/env 不得改变 resolvedTerminal');
  });

  test('恶意仓库配置不被读取（cwd 隔离）', async () => {
    const visible = await taskSh('cat /work/orca.yaml && ls /work/task-w/node_modules/ws/');
    assert.match(visible.stdout, /not: valid: yaml/, '恶意 orca.yaml 应在 /work 可见（读取断言的区分度前提）');
    const result = await guard(['orca', 'check']);
    assert.equal(result.code, 0, `cwd 隔离下 guard 应不受 /work 恶意配置影响: ${result.stderr.slice(0, 300)}`);
    assert.equal((stdoutJson(result).result as { runId?: string }).runId, fx().runId);
  });

  test('任务目录植入同名 node 模块不被加载', async () => {
    const result = await guard(['orca', 'check']);
    assert.equal(result.code, 0);
    const marker = await taskSh('test -f /tmp/gov-t51-pwned-marker && echo LOADED || echo CLEAN');
    assert.equal(marker.stdout.trim(), 'CLEAN', '植入模块不得被 guard 的 CLI 加载');
  });

  test('参数注入：元字符被白名单解析拒绝', async () => {
    const semi = await guard(['orca', 'send', '--type', 'status', '--subject', 'x; rm -rf /']);
    assert.equal(semi.code, 2, `分号注入应 exit 2: ${semi.stderr.slice(0, 200)}`);
    const backtick = await guard(['orca', 'send', '--type', 'status', '--subject', 'x `id`']);
    assert.equal(backtick.code, 2);
    const cmdSub = await guard(['orca', 'send', '--type', 'status', '--subject', 'x $(id)']);
    assert.equal(cmdSub.code, 2);
  });

  test('伪造注入指令字段（--from/--terminal/--task-id）不改 resolvedTerminal', async () => {
    const result = await guard(['orca', 'check', '--terminal', 'term_evil', '--from', 'term_evil']);
    assert.equal(result.code, 0, `调用者身份标志应被剥除: ${result.stderr.slice(0, 300)}`);
    const body = stdoutJson(result);
    assert.equal((body.result as { runId?: string }).runId, fx().runId, '解析终端必须是 gov 回执值');
  });

  test('允许的 gov 动作（status）通过并回真 JSON', async () => {
    const result = await guard(['gov', 'status', `{"taskId":"${fx().govTaskId}"}`]);
    assert.equal(result.code, 0, result.stderr.slice(0, 300));
    const body = stdoutJson(result);
    assert.equal(body.ok, true);
    const task = (body.result as { task?: { taskId?: string } }).task;
    assert.equal(task?.taskId, fx().govTaskId);
  });

  test('越权 gov 动作拒：本地白名单先拒 operator 动作；跨角色动作过 gov 门拒', async () => {
    // cancel 是 operator 动作：guard 本地白名单（executor/reviewer 联合面）先拒（exit 2）。
    const local = await guard(['gov', 'cancel', `{"taskId":"${fx().govTaskId}"}`]);
    assert.equal(local.code, 2, `operator 动作应被本地白名单拒: ${local.stderr.slice(0, 200)}`);
    // review-accept 在本地白名单（reviewer 面）内，但 executor 令牌过 gov 门被拒（exit 3）。
    const cross = await guard(['gov', 'review-accept', `{"taskId":"${fx().govTaskId}"}`]);
    assert.equal(cross.code, 3, `跨角色动作应被 gov 授权拒: ${cross.stdout.slice(0, 200)} ${cross.stderr.slice(0, 200)}`);
    assert.match(cross.stderr + cross.stdout, /E_FORBIDDEN_ACTION/);
  });

  test('guard-authorize 拒绝非 executor/reviewer 角色（dev 令牌）', async () => {
    const devToken = issueToken(fx().host.db, { role: 'dev', actions: ['guard-authorize'], ttlSeconds: 600 });
    const response = await fetch(`http://127.0.0.1:${fx().host.server.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${devToken.token}` },
      body: JSON.stringify({
        requestId: `t51-dev-${crypto.randomUUID()}`,
        action: 'guard-authorize',
        payload: {
          subcommand: 'gov:status',
          taskId: fx().govTaskId,
          argsDigest: createHash('sha256').update('[]').digest('hex'),
          identity: { terminalHandle: fx().terminalHandle, dispatchId: fx().fixtureDispatchId },
        },
      }),
    });
    const body = (await response.json()) as { ok: boolean; error?: { code?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'E_FORBIDDEN_ACTION');
  });

  test('预置身份与认领回执漂移被拒（terminal 不一致）', async () => {
    const tampered = issueToken(fx().host.db, {
      role: 'executor',
      taskId: fx().govTaskId,
      claimId: fx().govClaimId,
      actions: [...GOV_ACTIONS_BY_ROLE.executor, 'guard-authorize'],
      ttlSeconds: 600,
    });
    const response = await fetch(`http://127.0.0.1:${fx().host.server.port}/api/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tampered.token}` },
      body: JSON.stringify({
        requestId: `t51-drift-${crypto.randomUUID()}`,
        action: 'guard-authorize',
        payload: {
          subcommand: 'orca:check',
          taskId: fx().govTaskId,
          argsDigest: createHash('sha256').update('[]').digest('hex'),
          identity: { terminalHandle: 'term_drift', dispatchId: fx().fixtureDispatchId },
        },
      }),
    });
    const body = (await response.json()) as { ok: boolean; error?: { code?: string } };
    assert.equal(body.ok, false);
    assert.equal(body.error?.code, 'E_FORBIDDEN_ACTION');
  });

  test('越权/提前 worker_done 拒（未合并/未失败/评审未受理）', async () => {
    const result = await guard([
      'orca', 'send', '--type', 'worker_done', '--outcome', 'succeeded', '--subject', 'done', '--body', 'premature',
    ]);
    assert.equal(result.code, 3, `提前 worker_done 应 exit 3: ${result.stdout.slice(0, 200)} ${result.stderr.slice(0, 200)}`);
    assert.match(result.stderr + result.stdout, /E_FORBIDDEN_ACTION/);
  });

  test('merge_ready 无提交记录拒', async () => {
    const result = await guard(['orca', 'send', '--type', 'merge_ready', '--subject', 'm', '--body', 'b']);
    assert.equal(result.code, 3);
    assert.match(result.stderr + result.stdout, /E_FORBIDDEN_ACTION/);
  });

  test('非白名单消息类型拒（question/handoff）', async () => {
    const q = await guard(['orca', 'send', '--type', 'question', '--subject', 'q', '--body', 'b']);
    assert.equal(q.code, 2, 'guard 白名单应先拒（类型不在 SEND_TYPES）');
    const handoff = await guard(['orca', 'send', '--type', 'handoff', '--subject', 'h', '--body', 'b']);
    assert.equal(handoff.code, 2);
  });

  test('管理动词（task-update/worker-start/terminal）拒', async () => {
    for (const verb of ['task-update', 'worker-start', 'terminal', 'worktree', 'dispatch', 'automations', 'repo']) {
      const result = await guard(['orca', verb, '--status', 'done']);
      assert.equal(result.code, 2, `管理动词 ${verb} 应 exit 2: ${result.stderr.slice(0, 150)}`);
    }
  });

  test('sudo 除固定入口外全拒（sudoers 面）', async () => {
    const shell = await taskSh('sudo -n -u orca-broker /bin/sh -c id');
    assert.notEqual(shell.code, 0, 'sudo 到 broker 的任意命令应被拒');
    const asRoot = await taskSh('sudo -n /usr/local/lib/gov/guard gov status');
    assert.notEqual(asRoot.code, 0, 'sudo 不带 -u（root 目标）应被拒');
    const arbitrary = await taskSh('sudo -n /bin/sh -c id');
    assert.notEqual(arbitrary.code, 0, 'sudo root 任意命令应被拒');
    const listing = await taskSh('sudo -n -l');
    assert.match(listing.stdout, /\/usr\/local\/lib\/gov\/guard/, 'sudo -l 应列出唯一 guard 入口');
    assert.ok(!/(ALL)[)] NOPASSWD: (ALL|\/bin)/.test(listing.stdout), `sudo -l 不得含其他 NOPASSWD 面: ${listing.stdout}`);
  });

  test('镜像 setuid/setgid 清单断言（仅 sudo/su）', async () => {
    const result = await run(dockerBin, ['exec', '-u', '0', fx().container, 'sh', '-c', 'find / -xdev -perm /6000 -type f | LC_ALL=C sort']);
    assert.equal(result.code, 0);
    assert.deepEqual(
      result.stdout.trim().split('\n').filter((l) => l.length > 0),
      ['/usr/bin/su', '/usr/bin/sudo'],
      '镜像内 setuid/setgid 可执行文件清单必须恰好为 su/sudo（C 排序）',
    );
  });

  test('guard 身份文件与真 CLI 均为 broker 专用权限', async () => {
    const identity = await run(dockerBin, ['exec', '-u', '0', fx().container, 'stat', '-c', '%U %a', '/var/lib/orca-broker/identity.json']);
    assert.equal(identity.stdout.trim(), 'orca-broker 600');
    const cliDir = await run(dockerBin, ['exec', '-u', '0', fx().container, 'stat', '-c', '%U %a', '/opt/orca-broker']);
    assert.equal(cliDir.stdout.trim(), 'orca-broker 700');
    const guardFile = await run(dockerBin, ['exec', '-u', '0', fx().container, 'stat', '-c', '%U %a', '/usr/local/lib/gov/guard']);
    assert.equal(guardFile.stdout.trim(), 'root 755');
    const shim = await run(dockerBin, ['exec', '-u', '0', fx().container, 'stat', '-c', '%U %a', '/usr/local/bin/orca']);
    assert.equal(shim.stdout.trim(), 'root 755');
  });

  test('工作区信任种子已预置（/work hasTrustDialogAccepted）', async () => {
    const result = await taskSh('cat /home/task/.claude.json');
    const parsed = JSON.parse(result.stdout) as { projects?: Record<string, { hasTrustDialogAccepted?: boolean }> };
    assert.equal(parsed.projects?.['/work']?.hasTrustDialogAccepted, true);
  });

  test('传输通道：容器内真 CLI 经配对码回到同一桌面 runtime', async () => {
    // 经 guard 的 status 不在白名单——直接以 broker 身份跑真 CLI 的 status 证明
    // 传输通道本身（同 runtimeId；不经容器内 serve）。配对码从 broker 0600
    // identity.json 取（与 guard 同源）。
    const cmd =
      'ORCA_PAIRING_CODE=$(node -e \'console.log(JSON.parse(require("fs").readFileSync("/var/lib/orca-broker/identity.json","utf8")).orcaPairingCode)\') ' +
      'exec /opt/orca-broker/bin/orca status --json';
    const result = await run(dockerBin, ['exec', '-u', '1200:1200', fx().container, 'sh', '-c', cmd], { timeoutMs: 60_000 });
    assert.equal(result.code, 0, `容器内真 CLI status 失败: ${result.stderr.slice(0, 300)}`);
    const meta = (JSON.parse(result.stdout) as { _meta?: { runtimeId?: string } })._meta;
    assert.equal(meta?.runtimeId, fx().desktopRuntimeId, '容器 CLI 必须回连宿主同一桌面 runtime');
    const statusBody = parseOkJson(result.stdout, 'container orca status');
    const runtime = (statusBody['runtime'] ?? {}) as { state?: string; connectionState?: string };
    assert.equal(runtime.state, 'ready');
    assert.equal(runtime.connectionState, 'connected');
  });
});
