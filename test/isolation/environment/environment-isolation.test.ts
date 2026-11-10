/**
 * T5.2 容器隔离与资源限制测试（设计 §14.2 逐条；fail-loud）。
 * 真实面：真实 docker + scripts/orca-vm/create.sh 全链（含统一镜像 deploy/docker
 * 构建），不部署 guard 面（GOV_GUARD_* 缺省）、不依赖桌面 Orca runtime 与 gov
 * server——guard 入口本身归 test/isolation/guard/（T5.1）。
 *
 * 用例编号对齐 T5.2 简报：
 * ①无宿主凭据（docker.sock 不可达、~/.ssh 无私钥、GOV_* 与 ORCA_PAIRING* 零泄漏）
 * ②capabilities 断言（cap-drop=ALL+最小补回：CapEff 空集、bounding 受限、
 *   非 privileged；no-new-privileges 与 guard sudo 入口互斥的裁定见 deploy/README.md，
 *   此处断言实际选定姿态）
 * ③资源上限实测（--memory 256m 下 OOMKill 只影响本容器；pids-limit 下 fork 自限）
 * ④读侧遮蔽（T0.4 口径：.jj/.git 真内容在容器内不可读；jj-only 工作区容忍
 *   .git 缺席不报错——T3.3 发现③）
 * ⑤符号链接审计（容器内造链接 → destroy 回执 symlinkAudit.new 含清单 → 幂等）
 * ⑥跨任务隔离（两个并行容器互访对方 /work 任务路径不可达）
 * ⑦destroy 后全量零残留（容器/密钥/构建上下文/审计临时文件/宿主临时目录）
 * 另含：create 环境不可用拒绝启动（docker daemon 不可达 / 镜像缺失均非零退出）
 * 与 claude CLI 安装面（任务用户可执行、安装与配置 broker 只读）。
 *
 * 串行执行：package.json 的 test:isolation 带 --test-concurrency=1（与 guard
 * 套件共享 docker 面，T5.1 实证并发污染）。
 */
import { execFile } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { after, before, describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { DEFAULT_VM_KEY_ROOT } from '../../../src/adapters/environment.ts';

const execFileAsync = promisify(execFile);

const repoRoot = path.join(import.meta.dirname, '..', '..', '..');
const dockerBin = ['/usr/local/bin/docker', '/opt/homebrew/bin/docker'].find((p) => fs.existsSync(p)) ?? 'docker';
const sshBin = ['/usr/bin/ssh', '/opt/homebrew/bin/ssh', '/usr/local/bin/ssh'].find((p) => fs.existsSync(p)) ?? 'ssh';
const createSh = path.join(repoRoot, 'scripts', 'orca-vm', 'create.sh');
const destroySh = path.join(repoRoot, 'scripts', 'orca-vm', 'destroy.sh');

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

/** create.sh：返回完整 stdout（成功=recipe JSON；失败也返回，由调用方断言）。 */
function createWorkspace(
  ws: string,
  rel: string,
  env: Record<string, string>,
  timeoutMs = 420_000,
): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      createSh,
      [ws, rel],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...env } },
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
}

/** destroy.sh：stdin 传生命周期 JSON，stdout 单行回执。 */
function destroyResource(rid: string, env: Record<string, string> = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    const child = execFile(
      destroySh,
      [],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, ...env } },
      (err, stdout, stderr) => {
        if (err === null) {
          resolve({ stdout, stderr, code: 0, ok: true });
        } else {
          const e = err as { code?: unknown };
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', code: typeof e.code === 'number' ? e.code : 'SPAWN', ok: false });
        }
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(`${JSON.stringify({ schemaVersion: 1, userData: { resourceId: rid } })}\n`);
  });
}

/** docker exec（任务用户 uid1000）跑 sh -c。 */
function taskSh(container: string, command: string, timeoutMs = 60_000): Promise<ExecResult> {
  return run(dockerBin, ['exec', '-u', '1000:1000', container, 'sh', '-c', command], { timeoutMs });
}

/** docker exec 指定用户跑 argv（无 shell）。 */
function execAs(container: string, user: string, args: readonly string[], timeoutMs = 60_000): Promise<ExecResult> {
  return run(dockerBin, ['exec', '-u', user, container, ...args], { timeoutMs });
}

interface Fixture {
  readonly imageTag: string;
  readonly containerA: string;
  readonly containerB: string;
  readonly wsA: string;
  readonly wsB: string;
  readonly taskA: string;
  readonly taskB: string;
  readonly portA: number;
  readonly identityA: string;
}

let fixture: Fixture | null = null;

function fx(): Fixture {
  if (fixture === null) {
    throw new Error('fixture 未初始化');
  }
  return fixture;
}

/** 本测试创建/尝试创建的全部容器名：after() 逐一兜底清理并断言无残留。 */
const knownContainerNames: string[] = [];

before(async () => {
  let createdA: string | null = null;
  let createdB: string | null = null;
  try {
    // --- 工作区 A：colocated 形态（.jj + .git 均在且带真内容，供遮蔽断言） ---
    const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-t52-iso-a-'));
    const wsA = path.join(tmpA, 'workspace');
    const taskA = path.join(wsA, 'task-a');
    fs.mkdirSync(path.join(wsA, '.jj'), { recursive: true });
    fs.mkdirSync(path.join(wsA, '.git'), { recursive: true });
    fs.writeFileSync(path.join(wsA, '.jj', 'secret-ji.toml'), '# jj 内部秘密\n');
    fs.writeFileSync(path.join(wsA, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    fs.mkdirSync(taskA, { recursive: true });
    fs.writeFileSync(path.join(taskA, 'a-marker.txt'), 'container-a owned file\n');
    // 基线符号链接：create 之前已存在 → destroy 审计不得计入 new。
    fs.symlinkSync('a-marker.txt', path.join(taskA, 'link-baseline.txt'));
    fs.writeFileSync(path.join(wsA, 'readme-a.txt'), 'ws a root\n');

    // --- 工作区 B：jj-only（无 .git——遮蔽容忍缺席的实测面，T3.3 发现③） ----
    const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-t52-iso-b-'));
    const wsB = path.join(tmpB, 'workspace');
    const taskB = path.join(wsB, 'task-b');
    fs.mkdirSync(path.join(wsB, '.jj'), { recursive: true });
    fs.writeFileSync(path.join(wsB, '.jj', 'secret-ji.toml'), '# jj 内部秘密 b\n');
    fs.mkdirSync(taskB, { recursive: true });
    fs.writeFileSync(path.join(taskB, 'unique-b.txt'), 'container-b owned file\n');

    const imageTag = `gov-t52-iso:${crypto.randomBytes(4).toString('hex')}`;
    const createEnv = { GOV_VM_IMAGE_TAG: imageTag };

    const outA = await createWorkspace(wsA, 'task-a', createEnv);
    assert.equal(outA.ok, true, `create A 失败: ${outA.stderr.slice(-1500)}`);
    const recipeA = JSON.parse(outA.stdout) as {
      connection?: { port?: number; identityFile?: string };
      userData?: { resourceId?: string };
    };
    createdA = String(recipeA.userData?.resourceId ?? '');
    assert.match(createdA, /^gov-vm-/, `create A 未返回 resourceId: ${outA.stdout.slice(0, 300)}`);
    knownContainerNames.push(createdA);

    const outB = await createWorkspace(wsB, 'task-b', createEnv);
    assert.equal(outB.ok, true, `create B 失败: ${outB.stderr.slice(-1500)}`);
    const recipeB = JSON.parse(outB.stdout) as { userData?: { resourceId?: string } };
    createdB = String(recipeB.userData?.resourceId ?? '');
    assert.match(createdB, /^gov-vm-/, `create B 未返回 resourceId: ${outB.stdout.slice(0, 300)}`);
    knownContainerNames.push(createdB);

    // create.sh 尾声把可写区置 0000（accept 前只读，§14.2 保留断言）。
    assert.equal(fs.statSync(taskA).mode & 0o777, 0o000, 'create 后 task-a 应为 0000');
    assert.equal(fs.statSync(taskB).mode & 0o777, 0o000, 'create 后 task-b 应为 0000');
    // 隔离测试要在容器内写探针/造符号链接，宿主侧恢复 0777（guard 套件同款口径）。
    fs.chmodSync(taskA, 0o777);
    fs.chmodSync(taskB, 0o777);

    fixture = {
      imageTag,
      containerA: createdA,
      containerB: createdB,
      wsA,
      wsB,
      taskA,
      taskB,
      portA: Number(recipeA.connection?.port ?? 0),
      identityA: String(recipeA.connection?.identityFile ?? ''),
    };
  } catch (err) {
    // 失败收尾：不留容器/临时目录，再抛原始错误。
    for (const rid of [createdA, createdB]) {
      if (rid !== null) {
        await destroyResource(rid).catch(() => undefined);
      }
    }
    for (const tmp of fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith('gov-t52-iso-'))) {
      try {
        fs.rmSync(path.join(os.tmpdir(), tmp), { recursive: true, force: true });
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
  const { containerA, containerB, imageTag, wsA, wsB } = fixture;
  fixture = null;
  for (const name of knownContainerNames) {
    await execFileAsync(dockerBin, ['rm', '-f', name], { timeout: 60_000 }).catch(() => undefined);
  }
  await execFileAsync(dockerBin, ['rmi', '-f', imageTag], { timeout: 120_000 }).catch(() => undefined);
  for (const ws of [wsA, wsB]) {
    for (let i = 0; i < 3; i += 1) {
      try {
        fs.rmSync(path.dirname(ws), { recursive: true, force: true });
        break;
      } catch (err) {
        if (i === 2) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
});

describe('T5.2 容器隔离（真实 docker + create.sh 全链 + 统一镜像）', () => {
  test('①无宿主凭据：docker.sock 不可达、~/.ssh 无私钥、env 零泄漏、broker 目录不可读', async () => {
    const { containerA, identityA } = fx();

    const sock = await taskSh(containerA, 'ls /var/run/docker.sock');
    assert.notEqual(sock.code, 0, 'docker.sock 不得存在');
    assert.match(sock.stderr, /No such file/i, `应报不存在: ${sock.stderr.slice(0, 200)}`);

    // 容器内 ~/.ssh 只含本容器临时公钥（entrypoint 注入），无任何私钥材料。
    const sshDir = await taskSh(containerA, 'ls -A ~/.ssh');
    assert.equal(sshDir.code, 0);
    assert.deepEqual(
      sshDir.stdout.trim().split('\n').filter((l) => l.length > 0),
      ['authorized_keys'],
      '~/.ssh 应恰好只含 authorized_keys',
    );
    const priv = await taskSh(containerA, 'grep -rl "PRIVATE KEY" ~/.ssh ~/.claude* 2>/dev/null; true');
    assert.equal(priv.stdout.trim(), '', '容器内不得有私钥材料');
    const pubkey = fs.readFileSync(identityA + '.pub', 'utf8').trim();
    const ak = await taskSh(containerA, 'cat ~/.ssh/authorized_keys');
    assert.equal(ak.stdout.trim(), pubkey, 'authorized_keys 应恰为本容器临时公钥');

    // env：GOV_* / ORCA_PAIRING* 不泄漏到任务用户环境（docker exec 与 SSH 登录双面）。
    const envExec = await taskSh(containerA, 'env | grep -cE "^(GOV_|ORCA_PAIRING)" || true');
    assert.equal(envExec.stdout.trim(), '0', `docker exec env 不应含 GOV_*/ORCA_PAIRING*: ${envExec.stdout}`);
    const sshEnv = await run(
      sshBin,
      [
        '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'IdentitiesOnly=yes', '-i', identityA,
        '-p', String(fx().portA),
        'task@127.0.0.1',
        'env | grep -cE "^(GOV_|ORCA_PAIRING)" || true',
      ],
      { timeoutMs: 30_000 },
    );
    assert.equal(sshEnv.code, 0, `SSH 登录失败: ${sshEnv.stderr.slice(0, 300)}`);
    assert.equal(sshEnv.stdout.trim(), '0', `SSH 会话 env 不应含 GOV_*/ORCA_PAIRING*: ${sshEnv.stdout}`);

    // broker 私有目录（身份/CLI 面）对任务用户不可读（0700）。
    const broker = await taskSh(containerA, 'ls /var/lib/orca-broker');
    assert.notEqual(broker.code, 0, '任务用户不得读 broker HOME');
    assert.match(broker.stderr, /Permission denied/i, `应因权限拒绝: ${broker.stderr.slice(0, 200)}`);
  });

  test('②capabilities：非 privileged、CapEff 空集、bounding 恰为 sudo 最小补回', async () => {
    const { containerA } = fx();

    const caps = await taskSh(containerA, 'grep -E "^(CapEff|CapBnd|NoNewPrivs)" /proc/self/status');
    assert.equal(caps.code, 0, caps.stderr);
    const lines = Object.fromEntries(
      caps.stdout.trim().split('\n').map((l) => l.split(/:\s+/) as [string, string]),
    );
    // CapEff 空集：任务用户（Agent 身份）零 capability。
    assert.equal(lines['CapEff'], '0000000000000000', `CapEff 应为空集: ${JSON.stringify(lines)}`);
    // Bounding 恰为 SETUID|SETGID|CHOWN|FOWNER|DAC_READ_SEARCH|AUDIT_WRITE
    // （guard sudo 入口 + guard_provision 部署步的最小补回；no-new-privileges
    // 与该入口互斥（sudo 拒跑），裁定与实测见 deploy/README.md）。
    assert.equal(lines['CapBnd'], '00000000200000cd', `CapBnd 应恰为 6 capability: ${JSON.stringify(lines)}`);
    assert.equal(lines['NoNewPrivs'], '0', '当前姿态不设 no-new-privileges（guard sudo 入口依赖 setuid）');

    // sshd（pid 1，同 uid1000）同样零 capability。
    const pid1 = await execAs(containerA, '1000:1000', ['cat', '/proc/1/status']);
    assert.equal(pid1.code, 0);
    assert.match(pid1.stdout, /CapEff:\s+0000000000000000/, 'sshd CapEff 应为空集');

    const inspect = await run(dockerBin, [
      'inspect',
      '--format',
      '{{json .HostConfig.Privileged}} {{json .HostConfig.SecurityOpt}} {{json .HostConfig.CapDrop}} {{json .HostConfig.CapAdd}} {{json .HostConfig.Memory}} {{json .HostConfig.NanoCpus}} {{json .HostConfig.PidsLimit}}',
      containerA,
    ]);
    assert.equal(inspect.code, 0, inspect.stderr);
    const [privileged, securityOpt, capDrop, capAdd, memory, nanoCpus, pidsLimit] = inspect.stdout.trim().split(' ');
    assert.equal(privileged, 'false', '容器不得 privileged 运行');
    assert.ok(securityOpt === '[]' || securityOpt === 'null', `不携带额外 security-opt: ${String(securityOpt)}`);
    assert.equal(capDrop, '["ALL"]', `应 cap-drop ALL: ${String(capDrop)}`);
    assert.deepEqual((JSON.parse(String(capAdd)) as string[]).sort(), [
      'CAP_AUDIT_WRITE',
      'CAP_CHOWN',
      'CAP_DAC_READ_SEARCH',
      'CAP_FOWNER',
      'CAP_SETGID',
      'CAP_SETUID',
    ]);
    assert.equal(memory, '2147483648', '内存上限 2g 应落到容器配置');
    assert.equal(nanoCpus, '2000000000', 'CPU 上限 2 核应落到容器配置');
    assert.equal(pidsLimit, '256', 'pids-limit 256 应落到容器配置');
  });

  test('claude CLI 安装面：任务用户全局可执行，安装与配置 broker 只读', async () => {
    const { containerA } = fx();

    const version = await taskSh(containerA, 'claude --version');
    assert.equal(version.code, 0, `claude 应可作为任务用户执行: ${version.stderr.slice(0, 300)}`);
    assert.match(version.stdout, /\(Claude Code\)/, `应回真实版本号: ${version.stdout}`);

    // 安装面属 broker（任务用户不可改）。
    const install = await run(dockerBin, ['exec', '-u', '0', containerA, 'stat', '-c', '%U %a', '/opt/claude-code/package']);
    assert.equal(install.stdout.trim(), 'orca-broker 755');
    // managed 配置属 broker 0644：任务用户可读不可写。
    const managed = await run(dockerBin, ['exec', '-u', '0', containerA, 'stat', '-c', '%U %a', '/etc/claude-code/managed-settings.json']);
    assert.equal(managed.stdout.trim(), 'orca-broker 644');
    const readManaged = await taskSh(containerA, 'cat /etc/claude-code/managed-settings.json');
    assert.equal(readManaged.code, 0, '任务用户应可读 managed 配置');
    const writeManaged = await taskSh(containerA, 'echo x >> /etc/claude-code/managed-settings.json');
    assert.notEqual(writeManaged.code, 0, '任务用户不得写 managed 配置');
  });

  test('④读侧遮蔽：.jj/.git 真内容不可读、写遮蔽层被拒；jj-only 工作区容忍 .git 缺席', async () => {
    const { containerA, containerB, wsA } = fx();

    // 区分度前提：宿主侧真内容存在。
    assert.ok(fs.existsSync(path.join(wsA, '.jj', 'secret-ji.toml')), '宿主 .jj 应有真内容');
    assert.ok(fs.existsSync(path.join(wsA, '.git', 'HEAD')), '宿主 .git 应有真内容');

    // A（.jj + .git 都在）：遮蔽后为空目录，真内容读不到（读保护不依赖 DAC）。
    const listJj = await taskSh(containerA, 'ls -A /work/.jj');
    assert.equal(listJj.code, 0);
    assert.equal(listJj.stdout.trim(), '', '/work/.jj 应被空 tmpfs 遮蔽');
    const catJj = await taskSh(containerA, 'cat /work/.jj/secret-ji.toml');
    assert.notEqual(catJj.code, 0, 'cat 宿主 .jj 内文件应被遮蔽拒绝');
    const listGit = await taskSh(containerA, 'ls -A /work/.git');
    assert.equal(listGit.stdout.trim(), '', '/work/.git 应被空 tmpfs 遮蔽');
    const catGit = await taskSh(containerA, 'cat /work/.git/HEAD');
    assert.notEqual(catGit.code, 0, 'cat 宿主 .git 内文件应被遮蔽拒绝');
    const writeJj = await taskSh(containerA, 'touch /work/.jj/probe');
    assert.notEqual(writeJj.code, 0, '写遮蔽层应被拒（只读 tmpfs）');
    const writeRoot = await taskSh(containerA, 'touch /work/root-probe');
    assert.notEqual(writeRoot.code, 0, '写工作区根应被拒（只读 bind 层）');

    // B（jj-only，无 .git）：create 成功（before 已证）；.git 缺席不报错、不可见。
    const gitAbsent = await taskSh(containerB, 'test -e /work/.git && echo PRESENT || echo ABSENT');
    assert.equal(gitAbsent.stdout.trim(), 'ABSENT', 'jj-only 工作区容器内 .git 应缺席');
    const catGitB = await taskSh(containerB, 'cat /work/.git/HEAD');
    assert.notEqual(catGitB.code, 0, '.git 缺席时读 .git 应失败（而非报挂载错）');
    const listJjB = await taskSh(containerB, 'ls -A /work/.jj');
    assert.equal(listJjB.stdout.trim(), '', 'B 的 /work/.jj 同样遮蔽');
  });

  test('⑥跨任务隔离：并行容器互访对方任务路径不可达', async () => {
    const { containerA, containerB } = fx();

    // A 看不到 B 的任务目录与文件；B 看不到 A 的。
    const aSeesB = await taskSh(containerA, 'test -e /work/task-b/unique-b.txt && echo REACHABLE || echo ISOLATED');
    assert.equal(aSeesB.stdout.trim(), 'ISOLATED', 'A 不得触及 B 的任务文件');
    const bSeesA = await taskSh(containerB, 'test -e /work/task-a/a-marker.txt && echo REACHABLE || echo ISOLATED');
    assert.equal(bSeesA.stdout.trim(), 'ISOLATED', 'B 不得触及 A 的任务文件');
    const bDirInA = await taskSh(containerA, 'test -d /work/task-b && echo DIR || echo NODIR');
    assert.equal(bDirInA.stdout.trim(), 'NODIR', 'A 的 /work 不含 B 的任务目录');
    // 各自的文件在各自容器内可见（隔离断言的区分度前提）。
    const own = await taskSh(containerA, 'test -f /work/task-a/a-marker.txt && echo OWN');
    assert.equal(own.stdout.trim(), 'OWN');
  });

  test('③资源上限：--memory 256m OOMKill 只影响本容器；pids-limit 下 fork 自限', async () => {
    const { containerA, imageTag } = fx();
    const suffix = crypto.randomBytes(3).toString('hex');

    // 内存炸弹：独立容器 256m，node 持续分配 → cgroup OOMKill（exit 137）。
    const memName = `gov-t52-mem-${suffix}`;
    knownContainerNames.push(memName);
    const memStart = await run(dockerBin, [
      'run', '-d', '--name', memName, '--memory', '256m', '--cap-drop=ALL', '-u', '1000:1000',
      '--entrypoint', 'node', imageTag,
      '-e', 'const a=[]; for(;;) a.push(Buffer.allocUnsafe(1024*1024));',
    ]);
    assert.equal(memStart.code, 0, `内存炸弹容器启动失败: ${memStart.stderr.slice(0, 300)}`);
    let memExit = '';
    for (let i = 0; i < 30; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const st = await run(dockerBin, ['inspect', '--format', '{{.State.Status}} {{.State.ExitCode}} {{.State.OOMKilled}}', memName]);
      if (st.stdout.trim().startsWith('exited')) {
        memExit = st.stdout.trim();
        break;
      }
    }
    assert.match(memExit, /^exited 137 true/, `应被 cgroup OOMKill（exit 137 + OOMKilled）: ${memExit || '30s 未退出'}`);
    // 只影响本容器：主容器 A 始终健康。
    const alive = await taskSh(containerA, 'echo alive');
    assert.equal(alive.stdout.trim(), 'alive', 'OOM 不得波及其他容器');

    // fork 炸弹：独立容器 --pids-limit 32，循环后台 300 个 sleep → 自限于上限。
    const pidsName = `gov-t52-pids-${suffix}`;
    knownContainerNames.push(pidsName);
    const pidsStart = await run(dockerBin, [
      'run', '-d', '--name', pidsName, '--pids-limit', '32', '--cap-drop=ALL', '-u', '1000:1000',
      '--entrypoint', 'sh', imageTag,
      '-c', 'for i in $(seq 1 300); do sleep 30 & done; echo PROCS=$(ls /proc | grep -c "^[0-9]")',
    ]);
    assert.equal(pidsStart.code, 0, `fork 炸弹容器启动失败: ${pidsStart.stderr.slice(0, 300)}`);
    let procsLine = '';
    let forkErr = '';
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const logs = await run(dockerBin, ['logs', pidsName]);
      if (/PROCS=\d+/.test(logs.stdout)) {
        procsLine = logs.stdout;
        break;
      }
      if (/fork|resource/i.test(logs.stderr)) {
        forkErr = logs.stderr;
      }
    }
    // 自限证据二选一：PROCS 计数 ≤ 上限（+任务开销），或 shell 早早死于 fork 失败。
    const procs = Number(/PROCS=(\d+)/.exec(procsLine)?.[1] ?? NaN);
    assert.ok(
      (!Number.isNaN(procs) && procs <= 40) || forkErr.length > 0,
      `fork 炸弹应自限于 pids-limit（PROCS=${procs}，forkErr=${forkErr.slice(0, 120)}）`,
    );
    const alive2 = await taskSh(containerA, 'echo alive');
    assert.equal(alive2.stdout.trim(), 'alive', 'fork 炸弹不得波及其他容器');

    await run(dockerBin, ['rm', '-f', memName, pidsName]);
  });

  test('⑤符号链接审计：容器内造链接 → destroy 回执含新增清单；幂等 destroy', async () => {
    const { containerA, containerB } = fx();

    const makeLink = await taskSh(containerA, 'ln -s /etc/passwd /work/task-a/audit-link');
    assert.equal(makeLink.code, 0, `容器内造符号链接应成功: ${makeLink.stderr.slice(0, 200)}`);

    const destroyed = await destroyResource(containerA);
    assert.equal(destroyed.ok, true, `destroy A 失败: ${destroyed.stderr.slice(0, 300)}`);
    const receipt = JSON.parse(destroyed.stdout) as {
      destroyed?: boolean;
      existed?: boolean;
      resourceId?: string;
      symlinkAudit?: { scanned?: boolean; baselineCount?: number; new?: string[] };
    };
    assert.equal(receipt.destroyed, true);
    assert.equal(receipt.existed, true);
    assert.equal(receipt.resourceId, containerA, '回执应带原 resourceId');
    // 审计核心断言：新增恰为容器内存活期所造链接；create 前的基线链接不计入。
    assert.equal(receipt.symlinkAudit?.scanned, true, `审计应完成: ${JSON.stringify(receipt.symlinkAudit)}`);
    assert.ok(Number.isInteger(receipt.symlinkAudit?.baselineCount));
    assert.deepEqual(
      receipt.symlinkAudit?.new,
      ['/work/task-a/audit-link'],
      `新增符号链接清单应恰含容器内所造链接: ${JSON.stringify(receipt.symlinkAudit)}`,
    );
    // 容器已消失；密钥目录（含基线与 meta）随之清理。
    const gone = await run(dockerBin, ['ps', '-a', '--filter', `name=${containerA}`, '--format', '{{.Names}}']);
    assert.equal(gone.stdout.trim(), '', '容器应已销毁');
    assert.equal(fs.existsSync(path.join(DEFAULT_VM_KEY_ROOT, containerA)), false, '密钥/基线目录应已清理');

    // 幂等 + 审计缺席降级：已销毁 id 再 destroy 仍成功，audit scanned:false。
    const again = await destroyResource(containerA);
    assert.equal(again.ok, true);
    const receipt2 = JSON.parse(again.stdout) as { destroyed?: boolean; existed?: boolean; symlinkAudit?: { scanned?: boolean } };
    assert.equal(receipt2.destroyed, true);
    assert.equal(receipt2.existed, false, '二次 destroy 幂等');
    assert.equal(receipt2.symlinkAudit?.scanned, false, '容器不存在时审计应降级 scanned:false');

    // B 同链路（无链接场景）：new 为空数组。
    const destroyedB = await destroyResource(containerB);
    assert.equal(destroyedB.ok, true, `destroy B 失败: ${destroyedB.stderr.slice(0, 300)}`);
    const receiptB = JSON.parse(destroyedB.stdout) as { symlinkAudit?: { scanned?: boolean; new?: string[] } };
    assert.equal(receiptB.symlinkAudit?.scanned, true);
    assert.deepEqual(receiptB.symlinkAudit?.new, [], 'B 无新增链接');
    assert.ok(!fs.existsSync(path.join(DEFAULT_VM_KEY_ROOT, containerB)), 'B 密钥目录应已清理');
  });

  test('create 拒绝启动：docker daemon 不可达与镜像缺失均非零退出且不建容器', async () => {
    const { wsA } = fx();

    // daemon 不可达（假 DOCKER_HOST）：stage=docker-daemon，非零退出。
    const daemonDown = await createWorkspace(wsA, 'task-a', {
      DOCKER_HOST: 'unix:///tmp/gov-t52-nonexistent-daemon.sock',
    }, 60_000);
    assert.notEqual(daemonDown.code, 0, 'daemon 不可达必须非零退出');
    const failBody = JSON.parse(daemonDown.stdout) as { ok?: boolean; stage?: string };
    assert.equal(failBody.ok, false);
    assert.equal(failBody.stage, 'docker-daemon', `stage 应为 docker-daemon: ${daemonDown.stdout.slice(0, 300)}`);

    // 镜像缺失（GOV_VM_IMAGE 指向不存在镜像）：stage=docker-run，非零退出。
    const badImage = `gov-t52-nonexistent-image:${crypto.randomBytes(3).toString('hex')}`;
    const imageMissing = await createWorkspace(wsA, 'task-a', { GOV_VM_IMAGE: badImage }, 120_000);
    assert.notEqual(imageMissing.code, 0, '镜像缺失必须非零退出');
    const failBody2 = JSON.parse(imageMissing.stdout) as { ok?: boolean; stage?: string; resourceId?: string };
    assert.equal(failBody2.ok, false);
    assert.equal(failBody2.stage, 'docker-run', `stage 应为 docker-run: ${imageMissing.stdout.slice(0, 300)}`);
    if (failBody2.resourceId !== undefined) {
      knownContainerNames.push(failBody2.resourceId);
      const left = await run(dockerBin, ['ps', '-a', '--filter', `name=${failBody2.resourceId}`, '--format', '{{.Names}}']);
      assert.equal(left.stdout.trim(), '', '失败路径不得留下容器');
      assert.equal(
        fs.existsSync(path.join(DEFAULT_VM_KEY_ROOT, failBody2.resourceId)),
        false,
        '失败路径的密钥目录应已回收（create.sh 自清）',
      );
    }
  });

  test('⑦destroy 后零残留：容器、密钥、构建上下文、审计临时文件与宿主临时目录全清', async () => {
    const { wsA, wsB } = fx();

    const left = await run(dockerBin, ['ps', '-a', '--format', '{{.Names}}']);
    const names = left.stdout.split('\n').filter((l) => l.length > 0);
    for (const name of knownContainerNames) {
      assert.ok(!names.includes(name), `容器残留: ${name}`);
    }

    // /tmp 配方面：构建上下文、guard 暂存、审计暂存全部收净。
    const tmpLeftovers = fs.readdirSync('/tmp').filter((d) =>
      /^gov-vm-(buildctx|guard|symlinks)-/.test(d) || /^gov-t52-iso-[ab]-/.test(d),
    );
    assert.deepEqual(tmpLeftovers, [], `/tmp 应无本套件残留: ${tmpLeftovers.join(', ')}`);

    // 密钥根下无本套件条目。
    const keyLeftovers = fs.existsSync(DEFAULT_VM_KEY_ROOT)
      ? fs.readdirSync(DEFAULT_VM_KEY_ROOT).filter((d) => knownContainerNames.includes(d))
      : [];
    assert.deepEqual(keyLeftovers, [], `密钥根应无残留: ${keyLeftovers.join(', ')}`);

    // 宿主工作区目录（含遮蔽源、任务目录与审计链接所在层）由测试侧删除并断言消失。
    for (const ws of [wsA, wsB]) {
      fs.rmSync(path.dirname(ws), { recursive: true, force: true });
      assert.equal(fs.existsSync(path.dirname(ws)), false, `宿主临时工作区应已删除: ${ws}`);
    }
  });
});
