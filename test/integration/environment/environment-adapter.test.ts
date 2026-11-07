/**
 * 本地 Docker SSH-mode 环境适配层真实集成测试（T2.3）。fail-loud：本机 Docker /
 * Orca / jj 不可用直接红，不 skip。
 *
 * 资源边界：/tmp 临时 colocated 工作区 + 一次性容器；结束 destroy 已建环境、
 * 恢复目录权限、rm -rf 临时目录，并断言本测试涉及的全部容器名在 docker ps -a
 * 中无残留。
 *
 * 实测口径（2026-11-07 Docker 29.6.1 / Docker Desktop 4.81，macOS）：
 * - paused 容器上 docker exec 被 daemon 立即拒绝（"unpause the container
 *   before exec"，docker CLI exit 1），不挂起——按此断言。
 * - 宿主 chmod 0000/0777 经 virtiofs 立即生效，无属性缓存竞态。
 * - docker inspect 对不存在对象会在 stdout 先吐一个空行：脚本侧已剔除空白。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createEnvironmentAdapter, DEFAULT_VM_KEY_ROOT, EnvAdapterError } from '../../../src/adapters/environment.ts';
import { DEFAULT_JJ_CANDIDATES } from '../../../src/adapters/jj.ts';

const execFileAsync = promisify(execFile);

const repoRoot = join(import.meta.dirname, '..', '..', '..');

function resolveBin(candidates: readonly string[], fallback: string): string {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return fallback;
}

const jjBin = resolveBin(DEFAULT_JJ_CANDIDATES, 'jj');
const dockerBin = resolveBin(['/usr/local/bin/docker', '/opt/homebrew/bin/docker'], 'docker');

const adapter = createEnvironmentAdapter({ repoRoot });

const stamp = `${Date.now()}`;
const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t23-it-${stamp}-`));
const workspaceDir = join(tmpRoot, 'workspace');
const writableDir = join(workspaceDir, 'src');

/** 跨用例共享锚（node:test 同文件按声明序串行执行）。 */
const ctx: {
  envId?: string;
  connection?: { host: string; port: number };
  resumedPort?: number;
  failedAttemptName?: string;
} = {};

/** 本测试创建/尝试创建的全部容器名：after() 逐一断言无残留。 */
const knownContainerNames: string[] = [];

function expectEnvError(fn: () => unknown | Promise<unknown>): Promise<EnvAdapterError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => assert.fail('期望抛出 EnvAdapterError'),
      (err: unknown) => {
        assert.ok(err instanceof EnvAdapterError, `期望 EnvAdapterError，实际: ${String(err)}`);
        return err;
      },
    );
}

async function dockerPsNames(nameFilter: string): Promise<string[]> {
  const { stdout } = await execFileAsync(
    dockerBin,
    ['ps', '-a', '--filter', `name=${nameFilter}`, '--format', '{{.Names}}'],
    { timeout: 30_000, encoding: 'utf8' },
  );
  return stdout.trim().split('\n').filter((line) => line.length > 0);
}

function tcpConnectOk(port: number, timeoutMs = 5_000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port, timeout: timeoutMs });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function dirMode(path: string): number {
  return fs.statSync(path).mode & 0o777;
}

after(async () => {
  // 安全网：主流程之外的残留（如断言中断）也尽量清零，再断言无残留。
  if (ctx.envId !== undefined) {
    await adapter.destroy(ctx.envId).catch(() => undefined);
  }
  for (const name of knownContainerNames) {
    await execFileAsync(dockerBin, ['rm', '-f', name], { timeout: 60_000 }).catch(() => undefined);
  }
  const leftovers: string[] = [];
  for (const name of knownContainerNames) {
    leftovers.push(...(await dockerPsNames(name)));
  }
  fs.chmodSync(writableDir, 0o755);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  assert.deepEqual(leftovers, [], `docker ps -a 应无本测试容器残留: ${leftovers.join(', ')}`);
});

test('前置：临时 colocated 工作区（.jj + .git 并存，供遮蔽断言）', async () => {
  fs.mkdirSync(workspaceDir);
  await execFileAsync(jjBin, ['git', 'init', '--colocate', workspaceDir], { timeout: 60_000, encoding: 'utf8' });
  assert.ok(fs.statSync(join(workspaceDir, '.jj'), { throwIfNoEntry: false })?.isDirectory(), '.jj 应存在');
  assert.ok(fs.statSync(join(workspaceDir, '.git'), { throwIfNoEntry: false })?.isDirectory(), '.git 应存在');
  assert.ok(fs.readdirSync(join(workspaceDir, '.jj')).length > 0, '.jj 应有真实内容（遮蔽断言才有意义）');
  fs.mkdirSync(writableDir);
  fs.writeFileSync(join(writableDir, 'code.ts'), 'export {};\n');
  fs.writeFileSync(join(workspaceDir, 'readme.txt'), 'workspace root file\n');
});

test('staticDoctor：免费静态检查无警告（orca.yaml + 四脚本 + vm recipe doctor 全 pass）', async () => {
  const receipt = await adapter.staticDoctor();
  assert.equal(receipt.orcaYaml.exists, true, 'orca.yaml 应存在');
  for (const [name, check] of Object.entries(receipt.scripts)) {
    assert.equal(check.executable, true, `${name} 脚本应可执行: ${check.path}`);
  }
  assert.equal(receipt.vmRecipeDoctor.ran, true, 'vm recipe doctor 应已执行');
  assert.equal(receipt.vmRecipeDoctor.ok, true, `vm recipe doctor 应 ok: ${JSON.stringify(receipt.vmRecipeDoctor.error ?? '')}`);
  assert.equal(receipt.vmRecipeDoctor.allPass, true, 'vm recipe doctor 应全部 pass（warn 也算不过）');
  const nonPass = receipt.vmRecipeDoctor.checks.filter((c) => c.status !== 'pass');
  assert.deepEqual(nonPass, [], `不应存在 warn/fail 检查项: ${JSON.stringify(nonPass)}`);
  assert.equal(receipt.ok, true);
});

test('doctor：综合体检六项绿（node / orca / jj / docker / 目录 / 版本）', async () => {
  const receipt = await adapter.doctor();
  assert.equal(receipt.node.ok, true, `node: ${receipt.node.version}`);
  assert.equal(receipt.orca.ok, true, `orca: ${JSON.stringify(receipt.orca)}`);
  assert.equal(receipt.jj.ok, true, `jj: ${JSON.stringify(receipt.jj)}`);
  assert.equal(receipt.docker.ok, true, `docker: ${JSON.stringify(receipt.docker)}`);
  assert.equal(receipt.dirs.ok, true, `dirs: ${JSON.stringify(receipt.dirs)}`);
  assert.match(receipt.versions.node, /^\d+\./);
  assert.ok(receipt.versions.orca !== undefined, '应报告 orca 版本');
  assert.match(receipt.versions.jj ?? '', /^jj 0\.41\./);
  assert.ok(receipt.versions.docker !== undefined, '应报告 docker 版本');
  assert.equal(receipt.ok, true);
});

test('create：SSH-mode recipe；accept 前挂载矩阵（0000 拒写、.jj/.git 遮蔽、根只读）', async () => {
  const receipt = await adapter.create({ workspaceHostPath: workspaceDir, taskDirRel: 'src' });
  ctx.envId = receipt.envInstanceId;
  knownContainerNames.push(receipt.envInstanceId);
  ctx.connection = { host: receipt.connection.host, port: receipt.connection.port };

  assert.match(receipt.envInstanceId, /^gov-vm-/);
  assert.equal(receipt.connection.type, 'ssh');
  assert.equal(receipt.connection.host, '127.0.0.1');
  assert.ok(receipt.connection.port >= 1 && receipt.connection.port <= 65535);
  assert.equal(receipt.connection.username, 'task');
  assert.equal(receipt.connection.projectRoot, '/work');
  assert.ok(fs.existsSync(receipt.connection.identityFile ?? ''), 'identityFile 应存在于宿主');
  assert.equal(receipt.connection.identitiesOnly, true);
  assert.ok(receipt.raw.userData.containerId !== undefined && /^[0-9a-f]{64}$/.test(receipt.raw.userData.containerId), 'containerId 应为 64 位十六进制');

  // create 后宿主可写区应已置 0000（accept 前只读）。
  assert.equal(dirMode(writableDir), 0o000);

  const envId = receipt.envInstanceId;
  // 写可写区被拒（0000）。
  const writeSrc = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/src/.gov-probe' });
  assert.equal(writeSrc.ok, false, 'accept 前写 /work/src 应被拒');
  assert.equal(writeSrc.exitCode, 13);
  // 读 .jj：遮蔽后为空目录（宿主侧 .jj 有内容，前置已断言）。
  const listJj = await adapter.execProbe(envId, { kind: 'list-dir', path: '/work/.jj' });
  assert.equal(listJj.ok, true, '遮蔽目录本身可 list（空 tmpfs）');
  assert.equal(listJj.stdout.trim(), '', '/work/.jj 应被空 tmpfs 遮蔽（读保护）');
  // 写 .jj 被拒（只读 tmpfs 层）。
  const writeJj = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/.jj/probe' });
  assert.equal(writeJj.ok, false, '写 /work/.jj 应被拒（只读层）');
  // 写工作区根被拒（只读 bind 层）。
  const writeRoot = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/root-probe' });
  assert.equal(writeRoot.ok, false, '写 /work 根应被拒（只读层）');
  // 根可读。
  const listRoot = await adapter.execProbe(envId, { kind: 'list-dir', path: '/work' });
  assert.equal(listRoot.ok, true, '/work 根应可读');
  assert.ok(listRoot.stdout.includes('src'), '/work 应含 src');
});

test('setWritable：accept 后切 0777，容器内 uid1000 试写成功', async () => {
  const envId = ctx.envId ?? assert.fail('前置环境缺失');
  const receipt = await adapter.setWritable(envId);
  assert.equal(receipt.target, 'writable');
  assert.equal(receipt.verified, true);
  assert.equal(dirMode(writableDir), 0o777);
  const probe = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/src/.gov-probe' });
  assert.equal(probe.ok, true, 'accept 后写 /work/src 应成功');
});

test('suspend：pause 后容器进程不可写（daemon 拒绝 exec，实测 docker CLI exit 1）', async () => {
  const envId = ctx.envId ?? assert.fail('前置环境缺失');
  const receipt = await adapter.suspend(envId);
  assert.equal(receipt.suspended, true);
  assert.equal(receipt.existed, true);
  const probe = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/src/.gov-probe' });
  assert.equal(probe.ok, false, 'paused 容器上探针不应成功');
  assert.equal(probe.exitCode, 1, '实测口径：daemon 拒绝 paused 容器 exec，docker CLI 以 exit 1 返回错误');
  assert.match(probe.stderr, /is paused|unpause the container/, 'daemon 应报 paused 错误');
});

test('resume：unpause 保留终端（sshd 端口可连），写权限保持', async () => {
  const envId = ctx.envId ?? assert.fail('前置环境缺失');
  const receipt = await adapter.resume(envId);
  ctx.resumedPort = receipt.connection.port;
  assert.equal(receipt.connection.type, 'ssh');
  assert.equal(receipt.connection.host, '127.0.0.1');
  assert.equal(receipt.connection.projectRoot, '/work');
  assert.equal(await tcpConnectOk(receipt.connection.port), true, 'resume 后 sshd 映射端口应可 TCP 连通');
  const probe = await adapter.execProbe(envId, { kind: 'write-file', path: '/work/src/.gov-probe' });
  assert.equal(probe.ok, true, 'resume 后写权限应保持（0777）');
});

test('setReadonly：切回 0000 后容器内写被拒', async () => {
  const envId = ctx.envId ?? assert.fail('前置环境缺失');
  const receipt = await adapter.setReadonly(envId);
  assert.equal(receipt.target, 'readonly');
  assert.equal(receipt.verified, true);
  assert.equal(dirMode(writableDir), 0o000);
});

test('destroy：幂等（二次调用成功）、目录权限恢复、密钥与容器清零', async () => {
  const envId = ctx.envId ?? assert.fail('前置环境缺失');
  const first = await adapter.destroy(envId);
  assert.equal(first.destroyed, true);
  assert.equal(first.existed, true);
  assert.equal(first.hostModeRestored, true);
  assert.equal(dirMode(writableDir), 0o755, 'destroy 后宿主可写区应恢复 0755');
  assert.deepEqual(await dockerPsNames(envId), [], '容器应已从 docker ps -a 消失');
  assert.equal(fs.existsSync(join(DEFAULT_VM_KEY_ROOT, envId)), false, 'SSH 密钥目录应已清理');

  const second = await adapter.destroy(envId);
  assert.equal(second.destroyed, true, 'destroy 幂等：容器已不存在视为成功');
  assert.equal(second.existed, false);

  // 未登记过的任意 id：destroy 不存在容器 → 幂等成功。
  const ghost = await adapter.destroy('gov-vm-never-existed-xyz');
  assert.equal(ghost.destroyed, true);
  assert.equal(ghost.existed, false);
});

test('create 异常：错误镜像名 → E_ENV_CREATE_FAILED + 资源可查明且无残留', async () => {
  const badAdapter = createEnvironmentAdapter({
    repoRoot,
    imageName: 'gov-nonexistent-image-xyz',
  });
  const err = await expectEnvError(() => badAdapter.create({ workspaceHostPath: workspaceDir, taskDirRel: 'src' }));
  assert.equal(err.code, 'E_ENV_CREATE_FAILED');
  assert.equal(err.detail.stage, 'docker-run');
  assert.ok(err.detail.resourceId !== undefined, '失败应保留 resourceId（容器名）供查明');
  ctx.failedAttemptName = err.detail.resourceId;
  knownContainerNames.push(err.detail.resourceId);
  assert.deepEqual(await dockerPsNames(err.detail.resourceId ?? ''), [], '查明：docker ps -a 不应有该容器（run 阶段即失败）');
  assert.equal(dirMode(writableDir), 0o755, '失败发生在 chmod 前，宿主目录权限不应被改动');
});

test('resume 异常：不存在的环境 → E_ENV_NOT_FOUND', async () => {
  const err = await expectEnvError(() => adapter.resume('gov-vm-never-existed-xyz'));
  assert.equal(err.code, 'E_ENV_NOT_FOUND');
});
