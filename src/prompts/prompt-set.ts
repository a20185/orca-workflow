/**
 * T5.3 角色提示词装配与角色材料版本哈希（设计 §12）。
 *
 * 四模板真源在仓库根 prompts/<role>.md（纯文本 + {{占位符}}，不含逻辑）；
 * 本模块只做三件事：
 * - loadPromptTemplate：按角色读模板；
 * - renderPrompt(role, spec, ctx)：注入任务书原文、claimId/reviewId 绑定与
 *   预算停止条件；装配后不得残留任何 {{ 占位符（残留即模板与装配函数漂移，
 *   fail-closed 抛错，绝不产出半成品角色卡）；
 * - promptSetHash：目录清单（排序文件名）+ 各文件内容 sha256 的汇总 sha256，
 *   claim 成功时随 prompt_set_hash 事件落库，作为该认领使用的角色材料指纹。
 *
 * prompts/ 目录形状是契约的一部分：恰好四个 <role>.md，多一个、少一个或出现
 * 陌生 .md 都抛错，防止模板集悄悄漂移而哈希无感。
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AcceptanceCriterion } from '../domain/acceptance.ts';
import type { TaskSpec } from '../domain/task-spec.ts';

/** 角色提示词集版本（人工递增；内容指纹另由 promptSetHash 承担）。 */
export const PROMPT_SET_VERSION = '1';

/** 发角色卡的四个角色（operator 属宿主运维面，不经提示词驱动）。 */
export const PROMPT_ROLES = ['coordinator', 'executor', 'dev', 'reviewer'] as const;

export type PromptRole = (typeof PROMPT_ROLES)[number];

/** claim 成功时落 events 的提示词集指纹事件 type（自由 type，与 claim_* 事件同面）。 */
export const PROMPT_SET_HASH_EVENT_TYPE = 'prompt_set_hash';

const PROMPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts');

export function loadPromptTemplate(role: PromptRole): string {
  return readFileSync(join(PROMPTS_DIR, `${role}.md`), 'utf8');
}

export interface PromptRenderContext {
  /** 认领绑定（executor 必填）。 */
  readonly claimId?: string | undefined;
  /** 评审绑定（reviewer 必填）。 */
  readonly reviewId?: string | undefined;
}

/** 各角色装配所需的最小绑定上下文；缺即抛错（不产出无绑定身份的角色卡）。 */
const REQUIRED_CONTEXT: Readonly<Record<PromptRole, readonly ('claimId' | 'reviewId')[]>> = {
  coordinator: [],
  executor: ['claimId'],
  dev: [],
  reviewer: ['reviewId'],
};

function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 注入值里的 {{ 折叠为全角：任务书原文不得伪造占位符形态混过残留判定。 */
function sanitizeValue(value: string): string {
  return value.replaceAll('{{', '｛｛');
}

function describeCriterion(criterion: AcceptanceCriterion): string {
  if (criterion.type === 'command') {
    return `命令型：${criterion.config.command.join(' ')}（期望退出码 ${criterion.config.expectedExit}）`;
  }
  if (criterion.type === 'artifact') {
    return `产物型：${criterion.config.path}（${criterion.config.minBytes}–${criterion.config.maxBytes} 字节）`;
  }
  return `人工型：${criterion.config.description}`;
}

/** 任务书原文块：范围、非目标与验收标准逐字进入角色卡（共同段「非目标与范围」的真源）。 */
export function renderTaskSpecBlock(spec: TaskSpec): string {
  const lines: string[] = [
    '任务书原文（范围与非目标以此为准）：',
    `- 任务标识：${spec.taskId}`,
    `- 问题：${spec.problem}`,
    `- 范围内：${spec.inScope.join('；')}`,
    `- 范围外：${spec.outOfScope.join('；')}`,
    `- 非目标：${spec.nonGoals.join('；')}`,
    `- 归属路径（ownedPaths）：${spec.ownedPaths.join('；')}`,
    '- 验收标准：',
  ];
  for (const criterion of spec.acceptanceCriteria) {
    lines.push(`  - [${criterion.criterionId}] ${describeCriterion(criterion)}`);
  }
  return lines.join('\n');
}

/** 预算停止条件行（注入各角色「停止条件」段）。 */
export function renderBudgetLine(spec: TaskSpec): string {
  const budget = spec.budget;
  return `预算上限：评审轮数 ${budget.maxReviewRounds}；墙钟 ${budget.maxWallSeconds} 秒；证据 ${budget.maxEvidenceBytes} 字节。预算耗尽或明显不足以完成时停止推进并如实报告，不得为凑结论继续消耗。`;
}

export function renderPrompt(role: PromptRole, spec: TaskSpec, ctx: PromptRenderContext = {}): string {
  if (!(PROMPT_ROLES as readonly string[]).includes(role)) {
    throw new Error(`未知提示词角色: ${String(role)}`);
  }
  for (const key of REQUIRED_CONTEXT[role]) {
    const value = ctx[key];
    if (value === undefined || value.length === 0) {
      throw new Error(`角色 ${role} 的提示词装配缺少必填绑定: ${key}`);
    }
  }
  const vars: Readonly<Record<string, string>> = {
    PROMPT_SET_VERSION,
    TASK_ID: spec.taskId,
    TASK_SPEC: renderTaskSpecBlock(spec),
    BUDGET: renderBudgetLine(spec),
    CLAIM_ID: ctx.claimId ?? '（本角色不绑定认领）',
    REVIEW_ID: ctx.reviewId ?? '（本角色不绑定评审）',
  };
  let text = loadPromptTemplate(role);
  for (const [key, rawValue] of Object.entries(vars)) {
    text = text.split(`{{${key}}}`).join(sanitizeValue(rawValue));
  }
  if (text.includes('{{')) {
    throw new Error(`角色 ${role} 模板装配后仍有 {{ 占位符残留（模板与装配函数漂移）`);
  }
  return text;
}

/** 纯哈希：文件清单（名排序）+ 各文件内容 sha256 → 汇总 sha256。与 IO 无关，供确定性测试直接断言。 */
export function computePromptSetHash(files: ReadonlyMap<string, string>): string {
  const names = [...files.keys()].sort();
  const parts: string[] = [];
  for (const name of names) {
    const content = files.get(name);
    if (content === undefined) {
      throw new Error(`提示词集缺文件内容: ${name}`);
    }
    parts.push(`${name}:${sha256Hex(content)}`);
  }
  return sha256Hex(parts.join('\n'));
}

/** prompts/ 目录清单（恰好四模板；陌生 .md 或缺文件都抛错）。 */
export function promptSetManifest(): Map<string, string> {
  const expected = new Set<string>(PROMPT_ROLES.map((role) => `${role}.md`));
  const manifest = new Map<string, string>();
  for (const name of readdirSync(PROMPTS_DIR)) {
    if (!name.endsWith('.md')) {
      continue;
    }
    if (!expected.has(name)) {
      throw new Error(`prompts/ 含预期外的模板文件: ${name}`);
    }
    manifest.set(name, readFileSync(join(PROMPTS_DIR, name), 'utf8'));
  }
  for (const name of expected) {
    if (!manifest.has(name)) {
      throw new Error(`prompts/ 缺少模板文件: ${name}`);
    }
  }
  return manifest;
}

/** 当前角色材料指纹（claim 时随事件落库的值）。 */
export function promptSetHash(): string {
  return computePromptSetHash(promptSetManifest());
}
