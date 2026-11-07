import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertRuntime, loadConfig } from '../../../src/config.ts';
import { GovError } from '../../../src/domain/errors.ts';

const validConfigJson = {
  schemaVersion: 1,
  repos: [{ repoId: 'demo', hostPath: '/srv/repos/demo', targets: ['main', 'feat-x'] }],
};

async function withTempConfig(content: string, run: (path: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'gov-config-'));
  try {
    const path = join(dir, 'gov.config.json');
    await writeFile(path, content, 'utf8');
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function expectConfigError(path: string, messagePart?: string): Promise<GovError> {
  try {
    await loadConfig(path);
  } catch (err) {
    assert.ok(err instanceof GovError, `应抛 GovError，实际抛出: ${String(err)}`);
    assert.equal(err.code, 'E_CONFIG_INVALID');
    if (messagePart !== undefined) {
      assert.ok(err.message.includes(messagePart), `message 应含「${messagePart}」，实际: ${err.message}`);
    }
    return err;
  }
  assert.fail('应抛 GovError(E_CONFIG_INVALID)，但调用成功');
}

test('loadConfig 读取并解析合法配置', async () => {
  await withTempConfig(JSON.stringify(validConfigJson), async (path) => {
    const config = await loadConfig(path);
    assert.equal(config.schemaVersion, 1);
    assert.equal(config.repos[0]?.repoId, 'demo');
    assert.deepEqual(config.repos[0]?.targets, ['main', 'feat-x']);
  });
});

test('loadConfig：文件不存在抛 E_CONFIG_INVALID', async () => {
  await expectConfigError(join(tmpdir(), 'gov-config-definitely-missing.json'), '无法读取');
});

test('loadConfig：非法 JSON 抛 E_CONFIG_INVALID', async () => {
  await withTempConfig('{ not json', async (path) => {
    await expectConfigError(path, '不是合法 JSON');
  });
});

test('loadConfig：未知字段抛 E_CONFIG_INVALID', async () => {
  const bad = { ...validConfigJson, extra: true };
  await withTempConfig(JSON.stringify(bad), async (path) => {
    await expectConfigError(path);
  });
});

test('loadConfig：相对 hostPath 抛 E_CONFIG_INVALID', async () => {
  const bad = {
    ...validConfigJson,
    repos: [{ repoId: 'demo', hostPath: 'repos/demo', targets: ['main'] }],
  };
  await withTempConfig(JSON.stringify(bad), async (path) => {
    await expectConfigError(path, '绝对路径');
  });
});

test('loadConfig：空 repoId / 空 targets / 重复 targets 抛 E_CONFIG_INVALID', async () => {
  const cases = [
    { ...validConfigJson, repos: [{ repoId: '', hostPath: '/srv/r', targets: ['main'] }] },
    { ...validConfigJson, repos: [{ repoId: 'demo', hostPath: '/srv/r', targets: [] }] },
    {
      ...validConfigJson,
      repos: [{ repoId: 'demo', hostPath: '/srv/r', targets: ['main', 'main'] }],
    },
  ];
  for (const bad of cases) {
    await withTempConfig(JSON.stringify(bad), async (path) => {
      await expectConfigError(path);
    });
  }
});

test('loadConfig：schemaVersion 非 1 抛 E_CONFIG_INVALID', async () => {
  const bad = { ...validConfigJson, schemaVersion: 2 };
  await withTempConfig(JSON.stringify(bad), async (path) => {
    await expectConfigError(path);
  });
});

test('assertRuntime：主版本 < 24 抛 E_RUNTIME_UNSUPPORTED（注入版本串）', () => {
  for (const version of ['v18.20.4', 'v20.11.1', 'v23.11.0', 'v4.9.1', 'not-a-version', '']) {
    try {
      assertRuntime(version);
    } catch (err) {
      assert.ok(err instanceof GovError, `应抛 GovError，实际抛出: ${String(err)}`);
      assert.equal(err.code, 'E_RUNTIME_UNSUPPORTED');
      assert.ok(err.message.includes(version), `message 应含注入的版本串「${version}」`);
      continue;
    }
    assert.fail(`版本「${version}」应被拒绝，但 assertRuntime 通过`);
  }
});

test('assertRuntime：主版本 >= 24 通过（含当前进程版本）', () => {
  assertRuntime('v24.0.0');
  assertRuntime('v24.15.0');
  assertRuntime('26.1.0');
  assertRuntime(process.version);
});
