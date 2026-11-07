/**
 * T3.1 默认信任预置单测：向 CLAUDE_CONFIG_DIR/.claude.json 的 projects 表写入
 * hasTrustDialogAccepted 条目，幂等（已信任不写盘），cleanup 只撤销本次增量。
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createDefaultTrustProvision } from '../../../src/services/workspaces.ts';

interface TrustDoc {
  readonly [key: string]: unknown;
  projects?: Record<string, Record<string, unknown>>;
}

function withTempConfig(fn: (file: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-trust-test-'));
  const previous = process.env['CLAUDE_CONFIG_DIR'];
  process.env['CLAUDE_CONFIG_DIR'] = dir;
  return fn(path.join(dir, '.claude.json')).finally(() => {
    if (previous === undefined) {
      delete process.env['CLAUDE_CONFIG_DIR'];
    } else {
      process.env['CLAUDE_CONFIG_DIR'] = previous;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function readDoc(file: string): TrustDoc {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as TrustDoc;
}

test('默认信任预置：新建条目写 flag；重复预置幂等不再改文件', async () => {
  await withTempConfig(async (file) => {
    const provision = createDefaultTrustProvision();
    const handle = await provision('/srv/ws/gt-demo-1');
    const doc = readDoc(file);
    assert.equal(doc.projects?.['/srv/ws/gt-demo-1']?.['hasTrustDialogAccepted'], true);

    // 幂等：再次预置同一路径不改变文件内容。
    const before = fs.readFileSync(file, 'utf8');
    await provision('/srv/ws/gt-demo-1');
    assert.equal(fs.readFileSync(file, 'utf8'), before);

    // cleanup 撤销本次增量（我们新建的条目被移除）。
    await handle.cleanup();
    assert.equal(readDoc(file).projects?.['/srv/ws/gt-demo-1'], undefined);
  });
});

test('默认信任预置：已有条目只补 flag，cleanup 移除 flag 保留其余键', async () => {
  await withTempConfig(async (file) => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        otherTopLevel: 1,
        projects: {
          '/srv/other': { hasTrustDialogAccepted: true },
          '/srv/ws/gt-demo-2': { allowedTools: ['Bash'] },
        },
      }),
      'utf8',
    );
    const provision = createDefaultTrustProvision();
    const handle = await provision('/srv/ws/gt-demo-2');

    const doc = readDoc(file);
    assert.equal(doc.projects?.['/srv/ws/gt-demo-2']?.['hasTrustDialogAccepted'], true);
    assert.deepEqual(doc.projects?.['/srv/ws/gt-demo-2']?.['allowedTools'], ['Bash']);
    assert.equal(doc.otherTopLevel, 1, '顶层其余键不动');
    assert.equal(doc.projects?.['/srv/other']?.['hasTrustDialogAccepted'], true, '其他条目不动');

    await handle.cleanup();
    const cleaned = readDoc(file).projects?.['/srv/ws/gt-demo-2'];
    assert.equal(cleaned?.['hasTrustDialogAccepted'], undefined, 'cleanup 移除本次补写的 flag');
    assert.deepEqual(cleaned?.['allowedTools'], ['Bash'], '条目原有内容保留');
  });
});
