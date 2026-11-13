#!/usr/bin/env node
/**
 * T5.3 SessionStart hook（容器内 Claude Code 设置，随镜像打包到
 * /usr/local/lib/gov/hooks/bin/；本仓 hooks/settings.json 即其 CLAUDE_CONFIG_DIR 模板）。
 *
 * 职责：把 renderPrompt 装配产物（角色卡文件）注入会话上下文——只读
 * GOV_ROLE_CARD_FILE 指向的文件并把内容写到 stdout（SessionStart 的 stdout
 * 会被 Claude Code 加入会话上下文）。无任何写副作用。
 *
 * 失效行为全部是「跳过注入 + stderr 注记 + 正常退出」：本层不承担授权，
 * 容器权限（T5.2：无版本控制可执行面、broker 0600 身份、sudoers 单入口）
 * 是硬边界，缺角色卡不阻止会话、也不打开任何权限。
 */
import { readFileSync, statSync } from 'node:fs';

const MAX_BYTES = 128 * 1024;

function main() {
  const file = process.env.GOV_ROLE_CARD_FILE;
  if (typeof file !== 'string' || file.length === 0) {
    process.stderr.write('gov session-start hook: 未设置 GOV_ROLE_CARD_FILE，跳过角色卡注入\n');
    return;
  }
  let size;
  try {
    size = statSync(file).size;
  } catch {
    process.stderr.write(`gov session-start hook: 角色卡文件不可读: ${file}\n`);
    return;
  }
  if (size > MAX_BYTES) {
    process.stderr.write(`gov session-start hook: 角色卡超过 ${MAX_BYTES} 字节上限，拒绝注入\n`);
    return;
  }
  process.stdout.write(readFileSync(file, 'utf8'));
}

try {
  main();
} catch (err) {
  process.stderr.write(`gov session-start hook: ${err instanceof Error ? err.message : String(err)}\n`);
}
process.exit(0);
