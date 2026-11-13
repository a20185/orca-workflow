#!/usr/bin/env node
/**
 * T5.3 防御性 PreToolUse(Bash) hook（容器内 Claude Code 设置，随镜像打包到
 * /usr/local/lib/gov/hooks/bin/）。职责只有两个：
 *
 * 1. 对显著越出角色面的 Bash 命令给出 deny 决策（git / jj / orca 管理子命令 /
 *    非 guard 形态的 sudo——与各角色卡的禁止事项对应，只匹配显著形态）；
 * 2. 把每次命中追记到 violation 事件文件（GOV_HOOK_VIOLATIONS_FILE，缺省
 *    $HOME/.gov-hook-violations.jsonl，命令截断 512 字符）。
 *
 * 本层不承担授权：容器权限（T5.2）才是硬边界。任何失效形态——输入异常、
 * 记录失败、脚本被删——都只退化为「不提示」，不会打开任何权限；反过来
 * 它多拒绝一条也只是防御性保守，不影响合法路径经 guard 执行。
 *
 * 协议：stdin 收 hook JSON（tool_name、tool_input.command）；命中时 stdout
 * 输出 permissionDecision=deny 的 hookSpecificOutput（Claude Code PreToolUse
 * 协议）；未命中或非 Bash 工具时静默放行（exit 0、无输出）。
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** guard 的规范 sudo 形态（与 /usr/local/bin/orca 垫片同一入口），剥除后才判 sudo。 */
const GUARD_SUDO = /sudo(?:\s+-[A-Za-z]+)*\s+-u\s+orca-broker\s+\/usr\/local\/lib\/gov\/guard\b/g;
// 命令两侧的显著边界：行首或空白/;&|(/ 开头，后随空白/;&|)/ 或行尾。
// 覆盖绝对路径形态（/usr/bin/git），同时放过 jjAdapter、my-git-notes 这类文件名。
const EDGE_BEFORE = '(?:^|[\\s;&|(/])';
const EDGE_AFTER = '(?=$|[\\s;&|)])';

const RULES = [
  { rule: 'git', pattern: new RegExp(`${EDGE_BEFORE}git${EDGE_AFTER}`) },
  { rule: 'jj', pattern: new RegExp(`${EDGE_BEFORE}jj${EDGE_AFTER}`) },
  { rule: 'orca-task-update', pattern: new RegExp(`${EDGE_BEFORE}orca\\s+task-update\\b`) },
  { rule: 'orca-worktree', pattern: new RegExp(`${EDGE_BEFORE}orca\\s+worktree\\b`) },
];

function matchViolation(command) {
  for (const { rule, pattern } of RULES) {
    if (pattern.test(command)) {
      return { rule };
    }
  }
  const stripped = command.replaceAll(GUARD_SUDO, '');
  if (new RegExp(`${EDGE_BEFORE}sudo${EDGE_AFTER}`).test(stripped)) {
    return { rule: 'sudo-non-guard' };
  }
  return null;
}

function recordViolation(event, hit, command) {
  const file = process.env.GOV_HOOK_VIOLATIONS_FILE ?? join(homedir(), '.gov-hook-violations.jsonl');
  const record = {
    ts: new Date().toISOString(),
    tool: typeof event?.tool_name === 'string' ? event.tool_name : 'Bash',
    rule: hit.rule,
    command: command.length > 512 ? `${command.slice(0, 512)}…` : command,
  };
  try {
    appendFileSync(file, `${JSON.stringify(record)}\n`);
  } catch {
    // 记录失败不影响 deny 决策本身。
  }
}

function main() {
  let raw;
  try {
    raw = readFileSync(0, 'utf8');
  } catch {
    return;
  }
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return;
  }
  if (event?.tool_name !== 'Bash') {
    return;
  }
  const command = event?.tool_input?.command;
  if (typeof command !== 'string' || command.length === 0) {
    return;
  }
  const hit = matchViolation(command);
  if (hit === null) {
    return;
  }
  recordViolation(event, hit, command);
  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: `gov 防御性 hook：命令命中角色面禁止模式（${hit.rule}）。版本控制与管理操作由治理系统经 guard 执行。`,
      },
    })}\n`,
  );
}

try {
  main();
} catch (err) {
  process.stderr.write(`gov pretool-use hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
process.exit(0);
