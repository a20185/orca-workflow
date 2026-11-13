/**
 * T5.3 hooks 面（简报 test/unit/prompts 清单）：
 * - settings.json 可解析、结构正确（SessionStart + PreToolUse(Bash)）、指向的
 *   脚本存在于本仓 hooks/bin/ 且带可执行位（打包面同名复制契约）；
 * - settings 不携带 permissions 面——hooks 只做防御与注入，不承担授权；
 * - PreToolUse 匹配器正/负样本各 ≥5 例（直接驱动真实脚本，无镜像层）；
 * - 命中时 deny 决策 + violation 事件文件追记；SessionStart 只读注入。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOKS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'hooks');

interface HookCommandEntry {
  readonly type?: string;
  readonly command?: string;
}

interface SettingsShape {
  hooks?: {
    SessionStart?: Array<{ hooks?: HookCommandEntry[] }>;
    PreToolUse?: Array<{ matcher?: string; hooks?: HookCommandEntry[] }>;
  };
}

function readSettings(): SettingsShape {
  return JSON.parse(readFileSync(join(HOOKS_DIR, 'settings.json'), 'utf8')) as SettingsShape;
}

function runHook(
  script: string,
  input: string,
  env: NodeJS.ProcessEnv = {},
): { readonly status: number | null; readonly stdout: string; readonly stderr: string } {
  const result = spawnSync(process.execPath, [join(HOOKS_DIR, 'bin', script)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('settings.json 可解析：SessionStart + PreToolUse(Bash)，命令名对应本仓脚本且可执行', () => {
  const settings = readSettings();
  assert.equal('permissions' in settings, false, 'hooks settings 不承担授权：不得携带 permissions 面');

  const sessionStart = settings.hooks?.SessionStart?.[0]?.hooks?.[0];
  assert.equal(sessionStart?.type, 'command');
  assert.ok(sessionStart?.command?.includes('session-start.mjs'));

  const preToolUse = settings.hooks?.PreToolUse?.[0];
  assert.equal(preToolUse?.matcher, 'Bash');
  assert.equal(preToolUse?.hooks?.[0]?.type, 'command');
  assert.ok(preToolUse?.hooks?.[0]?.command?.includes('pretool-use.mjs'));

  for (const command of [sessionStart?.command, preToolUse?.hooks?.[0]?.command]) {
    // settings 写的是容器内路径；按 basename 对应本仓 hooks/bin 的同名脚本
    //（随镜像打包时同名复制），并断言可执行位。
    const scriptPath = join(HOOKS_DIR, 'bin', basename(String(command)));
    accessSync(scriptPath, constants.X_OK);
  }
});

// ---------------------------------------------------------------------------
// PreToolUse 匹配器：正/负样本直接驱动真实脚本
// ---------------------------------------------------------------------------

const POSITIVE: ReadonlyArray<readonly [command: string, rule: string]> = [
  ['git commit -m x', 'git'],
  ['jj new -r abc123', 'jj'],
  ['orca task-update gt-1 --status done', 'orca-task-update'],
  ['orca worktree add gt-1', 'orca-worktree'],
  ['sudo rm -rf /tmp/leftover', 'sudo-non-guard'],
  ['pnpm test && git push origin main', 'git'],
  ['/usr/bin/git status', 'git'],
  ['sudo -u root cat /etc/shadow', 'sudo-non-guard'],
];

const NEGATIVE: readonly string[] = [
  'pnpm test',
  'pnpm run check',
  'node --test "test/unit/**/*.test.ts"',
  'orca check --wait',
  'sudo -n -u orca-broker /usr/local/lib/gov/guard gov status',
  'sudo -u orca-broker /usr/local/lib/gov/guard orca check --wait',
  'cat src/jjAdapter.ts',
  'ls out/my-git-notes.md',
];

function runBashHook(command: string, env: NodeJS.ProcessEnv = {}): { readonly status: number | null; readonly stdout: string } {
  return runHook(
    'pretool-use.mjs',
    JSON.stringify({ tool_name: 'Bash', tool_input: { command } }),
    env,
  );
}

test('PreToolUse 匹配器：正样本 deny 并逐条追记 violation 事件文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-hooks-test-'));
  try {
    const violations = join(dir, 'violations.jsonl');
    for (const [command, rule] of POSITIVE) {
      const out = runBashHook(command, { GOV_HOOK_VIOLATIONS_FILE: violations });
      assert.equal(out.status, 0, `脚本应正常退出: ${command}`);
      const parsed = JSON.parse(out.stdout) as {
        hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string };
      };
      assert.equal(parsed.hookSpecificOutput?.hookEventName, 'PreToolUse');
      assert.equal(parsed.hookSpecificOutput?.permissionDecision, 'deny', `应拒绝: ${command}`);
    }
    const lines = readFileSync(violations, 'utf8').trim().split('\n');
    assert.equal(lines.length, POSITIVE.length, '每次命中应恰好一条违规记录');
    for (let i = 0; i < POSITIVE.length; i++) {
      const record = JSON.parse(String(lines[i])) as { rule: string; ts: string };
      assert.equal(record.rule, POSITIVE[i]?.[1], `第 ${i} 条违规记录规则不符`);
      assert.ok(record.ts.length > 0, '违规记录应有时间戳');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PreToolUse 匹配器：负样本静默放行（exit 0 无输出）', () => {
  for (const command of NEGATIVE) {
    const out = runBashHook(command);
    assert.equal(out.status, 0, `应正常退出: ${command}`);
    assert.equal(out.stdout, '', `应无 deny 输出: ${command}`);
  }
});

test('PreToolUse：非 Bash 工具与畸形输入静默放行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-hooks-test-'));
  try {
    const violations = join(dir, 'violations.jsonl');
    for (const input of [
      JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/etc/shadow' } }),
      JSON.stringify({ tool_name: 'Bash', tool_input: {} }),
      'not-json',
    ]) {
      const out = runHook('pretool-use.mjs', input, { GOV_HOOK_VIOLATIONS_FILE: violations });
      assert.equal(out.status, 0);
      assert.equal(out.stdout, '');
    }
    // 畸形输入不产生违规记录。
    assert.equal(existsSync(violations), false, '畸形输入不应写违规文件');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SessionStart：只读注入
// ---------------------------------------------------------------------------

test('SessionStart：读取角色卡文件注入 stdout，无副作用', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-hooks-test-'));
  try {
    const card = join(dir, 'role-card.md');
    writeFileSync(card, '角色卡测试内容（renderPrompt 产物）', 'utf8');
    const out = runHook('session-start.mjs', '', { GOV_ROLE_CARD_FILE: card });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '角色卡测试内容（renderPrompt 产物）');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('SessionStart：环境变量缺失、文件不可读、超限时跳过注入且正常退出', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gov-hooks-test-'));
  try {
    for (const env of [{ GOV_ROLE_CARD_FILE: '' }, { GOV_ROLE_CARD_FILE: join(dir, 'absent.md') }]) {
      const out = runHook('session-start.mjs', '', env);
      assert.equal(out.status, 0);
      assert.equal(out.stdout, '');
      assert.ok(out.stderr.length > 0, '应有 stderr 注记');
    }
    const oversized = join(dir, 'big.md');
    writeFileSync(oversized, 'x'.repeat(128 * 1024 + 1), 'utf8');
    const out = runHook('session-start.mjs', '', { GOV_ROLE_CARD_FILE: oversized });
    assert.equal(out.status, 0);
    assert.equal(out.stdout, '');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
