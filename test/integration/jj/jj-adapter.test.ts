/**
 * jj 0.41.0 适配层真实集成测试（T2.2）。fail-loud：本机 jj 不可用直接红，不 skip。
 *
 * 资源边界：全部操作在 /tmp 临时 colocated 仓与两个临时 workspace 上进行，
 * 结束 rm -rf 回基准。真实 jj 二进制（Homebrew 绝对路径回退），不 push/fetch。
 *
 * 与简报的机制级偏差（语义不变，见 src/adapters/jj.ts 文件头）：
 * - 「B 侧改同文件触发 A stale」在 jj 0.41 的实际因果是：同文件分叉后从 B/主侧
 *   rebase A 的工作副本提交（旧提交被隐藏）→ A stale；仅改文件不产生 stale。
 *   本测试按实测因果构造：同文件分叉 → rebase（同时产出冲突与 stale）→ update-stale。
 * - 快进判定用「`bm::new` 区间输出包含现值」（jj 区间输出 newest-first）。
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createJjAdapter, JjAdapterError } from '../../../src/adapters/jj.ts';
import { GovError } from '../../../src/domain/errors.ts';
import type { GovConfig } from '../../../src/config.ts';

const execFileAsync = promisify(execFile);

/** jj 可执行文件解析：测试进程 PATH 可能不含 Homebrew（spawn ENOENT），按常见绝对路径回退。 */
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

const stamp = `${Date.now()}`;
// 显式落在 /tmp（macOS 上是 /private/tmp 的符号链接），覆盖 repoRoot 锁的路径归一化。
const tmpRoot = fs.mkdtempSync(join('/', 'tmp', `gov-t22-it-${stamp}-`));
const repoDir = join(tmpRoot, 'repo');
const realTmpRoot = fs.realpathSync(tmpRoot);
const realRepoDir = join(realTmpRoot, 'repo');
const wsADir = join(tmpRoot, 'ws-a');
const wsBDir = join(tmpRoot, 'ws-b');

const config: GovConfig = {
  schemaVersion: 1,
  repos: [{ repoId: 'it-repo', hostPath: repoDir, targets: ['base'] }],
};

const adapter = createJjAdapter({ repoRoot: repoDir, config });

// 跨用例共享锚（node:test 同文件按声明序串行执行）。
const anchors: { a1: string; treeA1: string; b0: string; a1Prime: string; b1: string } = {
  a1: '',
  treeA1: '',
  b0: '',
  a1Prime: '',
  b1: '',
};

function jjRaw(dir: string, args: readonly string[]): Promise<{ stdout: string }> {
  return execFileAsync(jjBin, [...args], { cwd: dir, encoding: 'utf8', timeout: 60_000 });
}

async function rawCommitId(dir: string, revset: string): Promise<string> {
  const { stdout } = await jjRaw(dir, ['log', '-r', revset, '--no-graph', '-T', 'commit_id']);
  const id = stdout.trim();
  assert.match(id, /^[0-9a-f]{40}$/, `raw revset ${revset} 应解析到 commit id`);
  return id;
}

function expectJjError(fn: () => unknown | Promise<unknown>): Promise<JjAdapterError> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => assert.fail('期望抛出 JjAdapterError'),
      (err: unknown) => {
        assert.ok(err instanceof JjAdapterError, `期望 JjAdapterError，实际: ${String(err)}`);
        return err;
      },
    );
}

test('仓库路径锁：任意路径拒绝，realpath 归一形态放行（E_REPO_NOT_CONFIGURED）', () => {
  assert.throws(
    () => createJjAdapter({ repoRoot: `/tmp/gov-t22-foreign-${stamp}`, config }),
    (err: unknown) => err instanceof JjAdapterError && err.code === 'E_REPO_NOT_CONFIGURED',
  );
  // /private/tmp 形态与 /tmp 形态必须识别为同一仓库；此刻 repo/ 尚不存在也不影响锁判定。
  const realForm = createJjAdapter({ repoRoot: realRepoDir, config });
  assert.equal(realForm.repoRoot, adapter.repoRoot);
});

test('initColocated：.jj + .git 并存（colocated 形态）；init 目标不是锁定仓库根则拒绝', async () => {
  const receipt = await adapter.initColocated();
  assert.equal(receipt.ok, true);
  assert.equal(receipt.dir, realRepoDir);
  assert.ok(fs.existsSync(join(realRepoDir, '.jj')), 'colocated 仓应有 .jj');
  assert.ok(fs.existsSync(join(realRepoDir, '.git')), 'colocated 仓应有 .git');
  assert.ok(receipt.opIds.length > 0, 'init 应回带 op log 回执');

  const err = await expectJjError(() => adapter.initColocated(join(tmpRoot, 'not-the-repo')));
  assert.equal(err.code, 'E_REPO_NOT_CONFIGURED');
});

test('doctor：版本钉 0.41.x + 仓库可读；不可达 executable → E_JJ_CALL_FAILED', async () => {
  const receipt = await adapter.doctor();
  assert.equal(receipt.ok, true);
  assert.match(receipt.version, /^jj 0\.41\./);

  const broken = createJjAdapter({ repoRoot: repoDir, config, jjPath: '/nonexistent/jj-gov-t22-it' });
  const err = await expectJjError(() => broken.doctor());
  assert.equal(err.code, 'E_JJ_CALL_FAILED');
  assert.match(err.message, /不可达/);
});

test('base 解析：raw jj 建初始提交与 bookmark，resolveBase 一律返回 commitId', async () => {
  fs.mkdirSync(join(repoDir, 'docs'), { recursive: true });
  fs.mkdirSync(join(repoDir, 'pkg'), { recursive: true });
  fs.writeFileSync(join(repoDir, 'docs', 'guide.md'), '# guide\n');
  fs.writeFileSync(join(repoDir, 'pkg', 'a.txt'), 'line1\nline2-base\nline3\n');
  fs.writeFileSync(join(repoDir, 'pkg', 'b.txt'), 'b-content\n');
  await jjRaw(repoDir, ['commit', '-m', 'init']);
  const c0 = await rawCommitId(repoDir, '@-');
  await jjRaw(repoDir, ['bookmark', 'create', 'base', '-r', c0]);

  const resolved = await adapter.resolveBase('base');
  assert.equal(resolved.ok, true);
  assert.equal(resolved.commitId, c0);
  assert.match(resolved.treeId, /^[0-9a-f]{64}$/, 'treeId 应为 sha256 指纹');

  const current = await adapter.bookmarkCurrent('base');
  assert.equal(current.commitId, c0);

  const missing = await expectJjError(() => adapter.resolveBase('ghost-bookmark'));
  assert.equal(missing.code, 'E_JJ_CALL_FAILED');
});

test('workspaceAdd/List：两个 workspace 落在指定 rev 上，清单含路径与工作副本提交', async () => {
  const c0 = (await adapter.bookmarkCurrent('base')).commitId;
  for (const [name, dir] of [
    ['ws-a', wsADir],
    ['ws-b', wsBDir],
  ] as const) {
    const added = await adapter.workspaceAdd({ name, path: dir, rev: c0 });
    assert.equal(added.ok, true);
    assert.ok(added.opIds.length > 0);
  }
  const listed = await adapter.workspaceList();
  const names = listed.workspaces.map((w) => w.name);
  assert.deepEqual([...names].sort(), ['default', 'ws-a', 'ws-b']);
  const rowA = listed.workspaces.find((w) => w.name === 'ws-a');
  assert.ok(rowA !== undefined);
  assert.equal(rowA.path, fs.realpathSync(wsADir), '清单路径应为 realpath 形态');
  assert.match(rowA.commitId, /^[0-9a-f]{40}$/);
});

test('snapshot 锚定：脏工作副本快照出新提交，重复快照锚确定', async () => {
  fs.writeFileSync(join(wsADir, 'pkg', 'a.txt'), 'line1\nline2-wsa\nline3\n');
  const first = await adapter.snapshot(wsADir);
  assert.equal(first.ok, true);
  assert.match(first.commitId, /^[0-9a-f]{40}$/);
  assert.match(first.treeId, /^[0-9a-f]{64}$/);
  const again = await adapter.snapshot(wsADir);
  assert.equal(again.commitId, first.commitId, '无新改动时锚应保持确定');
  assert.equal(again.treeId, first.treeId);

  const bAnchor = await adapter.snapshot(wsBDir);
  assert.match(bAnchor.commitId, /^[0-9a-f]{40}$/);
  anchors.a1 = first.commitId;
  anchors.treeA1 = first.treeId;
  anchors.b0 = bAnchor.commitId;
});

test('rebase 新 tree + 冲突：B 侧改同文件，rebase A 锚到 B → 新 commitId/新 tree + 未解决冲突', async () => {
  // B 侧对同一行改成不同内容（冲突源），并新增一个文件（treeId 是路径清单指纹，
  // 纯内容冲突不改路径集；加文件让 rebase 的 manifest 变化可被指纹捕捉）。
  fs.writeFileSync(join(wsBDir, 'pkg', 'a.txt'), 'line1\nline2-wsb\nline3\n');
  fs.writeFileSync(join(wsBDir, 'pkg', 'added-by-b.txt'), 'from b\n');
  const bSnap = await adapter.snapshot(wsBDir);
  const b1 = bSnap.commitId;
  assert.notEqual(b1, anchors.b0);
  anchors.b1 = b1;

  const rebased = await adapter.rebase({ rev: anchors.a1, newBase: b1 });
  anchors.a1Prime = rebased.newCommitId;

  assert.equal(rebased.ok, true);
  assert.notEqual(rebased.newCommitId, anchors.a1, 'rebase 后应产生新提交');
  assert.ok(rebased.conflicts.length > 0, '同行改动 rebase 后应有未解决冲突');
  assert.ok(rebased.conflicts.join('\n').includes('pkg/a.txt'), `冲突应落在 pkg/a.txt: ${rebased.conflicts.join('; ')}`);

  const readNew = await adapter.readCommit(rebased.newCommitId);
  assert.equal(readNew.commitId, rebased.newCommitId);
  assert.notEqual(readNew.treeId, anchors.treeA1, 'rebase 后 tree 指纹应变化');
});

test('workspace stale：A 锚被外部 rebase 隐藏后 snapshot 拒绝（E_JJ_STALE）', async () => {
  const err = await expectJjError(() => adapter.snapshot(wsADir));
  assert.equal(err.code, 'E_JJ_STALE');
  assert.match(err.detail.output ?? '', /working copy is stale/);
});

test('workspaceUpdateStale：A 内恢复，工作副本落在被改写的提交上并物化冲突标记', async () => {
  const updated = await adapter.workspaceUpdateStale(wsADir);
  assert.equal(updated.ok, true);
  assert.equal(updated.staleRecovered, true);
  assert.equal(updated.commitId, anchors.a1Prime, '恢复后 A 的工作副本应即 rebase 产物');

  const content = fs.readFileSync(join(wsADir, 'pkg', 'a.txt'), 'utf8');
  assert.match(content, /<<<<<<< conflict/);

  const conflicts = await adapter.conflictList(anchors.a1Prime);
  assert.ok(conflicts.conflicts.length > 0);
  assert.ok(conflicts.conflicts[0]?.startsWith('pkg/a.txt'));
});

test('snapshot 后解决：编辑冲突文件再快照 → 新 commitId 且 conflictList 为空', async () => {
  fs.writeFileSync(join(wsADir, 'pkg', 'a.txt'), 'line1\nline2-resolved\nline3\n');
  const resolved = await adapter.snapshot(wsADir);
  assert.notEqual(resolved.commitId, anchors.a1Prime);
  const after = await adapter.conflictList(resolved.commitId);
  assert.deepEqual(after.conflicts, []);
});

test('moveBookmarkFF：合法快进成功；目标移动与非快进两情形各拒一次', async () => {
  const c0 = (await adapter.bookmarkCurrent('base')).commitId;
  const base = 'base';

  // 合法快进：D 是 c0 的子提交。
  await jjRaw(repoDir, ['new', c0]);
  fs.writeFileSync(join(repoDir, 'ff-target.txt'), 'ff\n');
  await jjRaw(repoDir, ['commit', '-m', 'ff target']);
  const d = await rawCommitId(repoDir, '@-');
  const moved = await adapter.moveBookmarkFF({ bookmark: base, toCommit: d, expectedCurrent: c0 });
  assert.equal(moved.ok, true);
  assert.equal(moved.from, c0);
  assert.equal(moved.to, d);
  assert.equal((await adapter.bookmarkCurrent(base)).commitId, d);

  // 情形一 E_JJ_TARGET_MOVED：bookmark 被外部前移到 D2，调用方仍持旧预期 D。
  await jjRaw(repoDir, ['new', d]);
  fs.writeFileSync(join(repoDir, 'ff-2.txt'), 'ff2\n');
  await jjRaw(repoDir, ['commit', '-m', 'ff target 2']);
  const d2 = await rawCommitId(repoDir, '@-');
  await jjRaw(repoDir, ['new', d2]);
  fs.writeFileSync(join(repoDir, 'ff-3.txt'), 'ff3\n');
  await jjRaw(repoDir, ['commit', '-m', 'ff target 3']);
  const d3 = await rawCommitId(repoDir, '@-');
  await jjRaw(repoDir, ['bookmark', 'move', base, '--to', d2]);

  const targetMoved = await expectJjError(() =>
    adapter.moveBookmarkFF({ bookmark: base, toCommit: d3, expectedCurrent: d }),
  );
  assert.equal(targetMoved.code, 'E_JJ_TARGET_MOVED');
  assert.equal(targetMoved.detail.current, d2);
  assert.equal(targetMoved.detail.expected, d);

  // 情形二 E_JJ_NOT_FAST_FORWARD：预期一致，但目标挂在 root() 上的旁支提交。
  await jjRaw(repoDir, ['new', 'root()']);
  fs.writeFileSync(join(repoDir, 'orphan.txt'), 'orphan\n');
  await jjRaw(repoDir, ['commit', '-m', 'orphan line']);
  const orphan = await rawCommitId(repoDir, '@-');
  const notFF = await expectJjError(() =>
    adapter.moveBookmarkFF({ bookmark: base, toCommit: orphan, expectedCurrent: d2 }),
  );
  assert.equal(notFF.code, 'E_JJ_NOT_FAST_FORWARD');
  // 拒绝后 bookmark 不得移动（jj bookmark move 自身无快进约束，闸门只在适配器）。
  assert.equal((await adapter.bookmarkCurrent(base)).commitId, d2);
});

test('diffPaths：重命名双侧命中；越界路径拒绝；符号链接目标越出仓库拒绝', async () => {
  // 重命名 rev：建在含 pkg/ 的主线上（B 锚一系，含完整 pkg/ 树）。
  // 注意：连续 snapshot 会原地改写同一工作副本提交（同 parent），`jj diff -r` 随之
  // 变成累积 diff；每个探针 rev 快照后用 `jj new @` 封存，保证 diff 只含本批变更。
  await jjRaw(repoDir, ['new', anchors.b1]);
  fs.renameSync(join(repoDir, 'pkg', 'a.txt'), join(repoDir, 'pkg', 'renamed-a.txt'));
  fs.writeFileSync(join(repoDir, 'pkg', 'new-file.txt'), 'new\n');
  const renameRev = (await adapter.snapshot()).commitId;
  await jjRaw(repoDir, ['new', '@']);
  const renamed = await adapter.diffPaths(renameRev, ['pkg']);
  assert.ok(renamed.paths.includes('pkg/a.txt'), '重命名旧侧应记录');
  assert.ok(renamed.paths.includes('pkg/renamed-a.txt'), '重命名新侧应记录');
  assert.ok(renamed.paths.includes('pkg/new-file.txt'));

  // 越界：仓库根新增文件超出 ownedPaths。
  fs.writeFileSync(join(repoDir, 'rogue.txt'), 'out of scope\n');
  const rogueRev = (await adapter.snapshot()).commitId;
  await jjRaw(repoDir, ['new', '@']);
  const outOfScope = await expectJjError(() => adapter.diffPaths(rogueRev, ['pkg']));
  assert.equal(outOfScope.code, 'E_JJ_PATH_OUT_OF_SCOPE');
  assert.deepEqual(outOfScope.detail.offendingPaths, ['rogue.txt']);

  // 符号链接指向仓库外：同码拒绝并记录目标原文。
  fs.symlinkSync('/etc/hosts', join(repoDir, 'pkg', 'escape'));
  const escapeRev = (await adapter.snapshot()).commitId;
  await jjRaw(repoDir, ['new', '@']);
  const escaping = await expectJjError(() => adapter.diffPaths(escapeRev, ['pkg']));
  assert.equal(escaping.code, 'E_JJ_PATH_OUT_OF_SCOPE');
  assert.equal(escaping.detail.symlinkPath, 'pkg/escape');
  assert.equal(escaping.detail.symlinkTarget, '/etc/hosts', '拒绝时应记录链接目标原文');

  // 仓库内绝对目标（realpath 形态）的符号链接放行。
  fs.symlinkSync(join(realRepoDir, 'docs', 'guide.md'), join(repoDir, 'pkg', 'inside-link'));
  const insideRev = (await adapter.snapshot()).commitId;
  const inside = await adapter.diffPaths(insideRev, ['pkg']);
  assert.ok(inside.paths.includes('pkg/inside-link'));

  // ownedPaths 输入校验：绝对路径条目在适配器入口即拒（异步拒绝）。
  await assert.rejects(
    adapter.diffPaths(insideRev, ['/etc']),
    (err: unknown) => err instanceof GovError && err.code === 'E_REQUEST_INVALID',
  );
});

test('workspaceForget：注销后清单回收敛，目录保留由调用方处置', async () => {
  const forgotB = await adapter.workspaceForget('ws-b');
  assert.equal(forgotB.ok, true);
  const forgotA = await adapter.workspaceForget('ws-a');
  assert.equal(forgotA.ok, true);
  const listed = await adapter.workspaceList();
  assert.deepEqual(
    listed.workspaces.map((w) => w.name),
    ['default'],
  );
  assert.ok(fs.existsSync(wsBDir), '被注销 workspace 的目录应保留');
});

test('opLogReceipt：默认 3 条十六进制 op id；上限外 n 拒绝', async () => {
  const receipt = await adapter.opLogReceipt();
  assert.equal(receipt.opIds.length, 3);
  for (const id of receipt.opIds) {
    assert.match(id, /^[0-9a-f]+$/);
  }
  const two = await adapter.opLogReceipt(2);
  assert.equal(two.opIds.length, 2);
  await assert.rejects(
    adapter.opLogReceipt(0),
    (err: unknown) => err instanceof GovError && err.code === 'E_REQUEST_INVALID',
  );
});

test('异常退出映射：非法 revset → E_JJ_CALL_FAILED 带截断原文', async () => {
  const err = await expectJjError(() => adapter.conflictList(`gov-t22-no-such-rev-${stamp}`));
  assert.equal(err.code, 'E_JJ_CALL_FAILED');
  assert.match(err.detail.output ?? '', /doesn't exist|Error/);
});

test('doctor 复检：全部变更后仍自检通过', async () => {
  const receipt = await adapter.doctor();
  assert.equal(receipt.ok, true);
  assert.match(receipt.version, /^jj 0\.41\./);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  assert.ok(!fs.existsSync(tmpRoot), '临时目录应删除');
});
