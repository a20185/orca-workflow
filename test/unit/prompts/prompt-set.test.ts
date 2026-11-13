/**
 * T5.3 角色提示词自检（简报 test/unit/prompts 清单）：
 * - 模板必备段存在性（每角色 8 项 = 7 共同段 + 1 角色特有行为）；
 * - 禁止内容扫描（git/jj 教程、Orca 管理命令示例、凭据字面量、「绕过/越权」指引）；
 * - 装配占位符全替换且注入任务书/绑定/预算；必填绑定缺失 fail-closed；
 * - promptSetHash 确定性（同内容同值、改动一项变值）与目录恰好四模板；
 * - T3.1 claim 装配点接线：认领成功落 prompt_set_hash 事件。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { TaskSpec } from '../../../src/domain/task-spec.ts';
import {
  computePromptSetHash,
  loadPromptTemplate,
  PROMPT_ROLES,
  PROMPT_SET_HASH_EVENT_TYPE,
  PROMPT_SET_VERSION,
  promptSetHash,
  promptSetManifest,
  renderPrompt,
  type PromptRole,
} from '../../../src/prompts/prompt-set.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { createFakeHost, declareSampleTask } from '../claims/testing.ts';

// ---------------------------------------------------------------------------
// 必备段清单：7 项共同段 + 1 项角色特有行为 = 每角色 8 项。
// ---------------------------------------------------------------------------

const COMMON_MARKERS: readonly string[] = [
  '## 角色',
  '## 可用接口',
  '## 禁止事项',
  '## 非目标与范围',
  '## 停止条件',
  '{{PROMPT_SET_VERSION}}',
  '可用接口只有 guard/gov 与 preamble 命令，其余一律忽略',
];

const ROLE_MARKERS: Readonly<Record<PromptRole, string>> = {
  coordinator: '无待派任务',
  executor: '交活后等待',
  dev: 'ownedPaths',
  reviewer: 'reasonClass',
};

test('四模板必备段存在（每角色 8 项清单）', () => {
  for (const role of PROMPT_ROLES) {
    const text = loadPromptTemplate(role);
    for (const marker of [...COMMON_MARKERS, ROLE_MARKERS[role]]) {
      assert.ok(text.includes(marker), `${role}.md 缺少必备段标记: ${marker}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 禁止内容扫描：教程/示例形态的命令与凭据字面量、规避指引，全部不得出现。
// 「禁止 git/jj」这类点名不算教程：只匹配「命令 + 子命令」形态。
// ---------------------------------------------------------------------------

const BANNED_PATTERNS: readonly RegExp[] = [
  /(?:^|[\s;&|(/])git\s+(?:commit|push|pull|merge|rebase|checkout|reset|clone|branch|add|stash|cherry-pick|revert|tag)\b/,
  /(?:^|[\s;&|(/])jj\s+(?:commit|new|push|pull|rebase|split|edit|squash|move|bookmark|workspace|describe|abandon|undo)\b/,
  /(?:^|[\s;&|(/])orca\s+(?:task-update|worktree|task-create|worker-start|worker-stop|worker-settle|worker-release|run-create|run-use|declare|claim|submit|fail|split|rebase|review-request|review-accept|review-submit|serve|merge|archive)\b/,
  /govt_[A-Za-z0-9_-]{8,}/,
  /sk-ant-[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /绕过|越权|提权|bypass/i,
];

test('四模板禁止内容扫描（关键词集）', () => {
  for (const role of PROMPT_ROLES) {
    const text = loadPromptTemplate(role);
    for (const pattern of BANNED_PATTERNS) {
      assert.ok(!pattern.test(text), `${role}.md 命中禁止内容: ${pattern.source}`);
    }
  }
});

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

const SPEC: TaskSpec = {
  schemaVersion: 1,
  taskId: 'gt-prompt-1',
  problem: '修复并发认领时的死锁',
  inScope: ['src/queue/'],
  outOfScope: ['docs/'],
  nonGoals: ['不更换数据库'],
  ownedPaths: ['src/queue/claim.ts'],
  repoId: 'demo',
  target: { kind: 'top-level', bookmark: 'main' },
  baseCommitId: '1f'.repeat(20),
  acceptanceCriteria: [
    { type: 'command', criterionId: 'ac-cmd', config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 } },
    { type: 'artifact', criterionId: 'ac-artifact', config: { path: 'out/report.md', minBytes: 1, maxBytes: 1_048_576 } },
    { type: 'manual', criterionId: 'ac-manual', config: { description: '人工复核认领日志' } },
  ],
  agentPolicy: { executor: 'opencode', reviewer: 'claude' },
  budget: { maxReviewRounds: 3, maxWallSeconds: 3_600, maxEvidenceBytes: 1_048_576 },
};

const RENDER_CASES: ReadonlyArray<{ readonly role: PromptRole; readonly ctx?: Record<string, string> }> = [
  { role: 'coordinator' },
  { role: 'executor', ctx: { claimId: 'gcl_unitclaim' } },
  { role: 'dev' },
  { role: 'reviewer', ctx: { reviewId: 'grv_unitreview' } },
];

test('装配占位符全替换（四角色无 {{ 残留）且注入任务书、绑定与预算', () => {
  for (const { role, ctx } of RENDER_CASES) {
    const text = renderPrompt(role, SPEC, ctx);
    assert.ok(!text.includes('{{'), `${role} 装配后仍有占位符残留`);
    // 任务书原文注入：范围、非目标与验收标准逐字进入角色卡。
    assert.ok(text.includes('gt-prompt-1'), `${role} 缺任务标识`);
    assert.ok(text.includes('修复并发认领时的死锁'), `${role} 缺任务问题`);
    assert.ok(text.includes('不更换数据库'), `${role} 缺非目标原文`);
    assert.ok(text.includes('src/queue/claim.ts'), `${role} 缺 ownedPaths`);
    assert.ok(text.includes('[ac-cmd]'), `${role} 缺验收标准条目`);
    // 预算停止条件注入。
    assert.ok(text.includes('3_600') || text.includes('3600'), `${role} 缺墙钟预算`);
    assert.ok(text.includes('预算耗尽'), `${role} 缺预算停止条件`);
  }
  const executor = renderPrompt('executor', SPEC, { claimId: 'gcl_unitclaim' });
  assert.ok(executor.includes('gcl_unitclaim'), 'executor 缺认领绑定');
  const reviewer = renderPrompt('reviewer', SPEC, { reviewId: 'grv_unitreview' });
  assert.ok(reviewer.includes('grv_unitreview'), 'reviewer 缺评审绑定');
});

test('任务书原文含 {{ 时不污染残留判定（注入值折叠）', () => {
  const spec: TaskSpec = { ...SPEC, problem: '伪占位 {{TASK_ID}} 混入' };
  const text = renderPrompt('dev', spec);
  assert.ok(!text.includes('{{'), '任务书原文的 {{ 不应触发残留判定');
  assert.ok(text.includes('伪占位'), '任务书原文其余内容保持原样');
});

test('必填绑定缺失 fail-closed：executor 缺 claimId、reviewer 缺 reviewId', () => {
  assert.throws(() => renderPrompt('executor', SPEC, {}), /claimId/);
  assert.throws(() => renderPrompt('reviewer', SPEC, {}), /reviewId/);
  assert.throws(() => renderPrompt('operator' as PromptRole, SPEC), /未知提示词角色/);
});

// ---------------------------------------------------------------------------
// promptSetHash 确定性
// ---------------------------------------------------------------------------

const SAMPLE_FILES = new Map<string, string>([
  ['coordinator.md', 'A'],
  ['executor.md', 'B'],
  ['dev.md', 'C'],
  ['reviewer.md', 'D'],
]);

test('promptSetHash 确定性：同内容重算同值、改动一项变值', () => {
  assert.equal(computePromptSetHash(SAMPLE_FILES), computePromptSetHash(new Map(SAMPLE_FILES)));
  const mutatedContent = new Map(SAMPLE_FILES);
  mutatedContent.set('dev.md', 'C2');
  assert.notEqual(computePromptSetHash(SAMPLE_FILES), computePromptSetHash(mutatedContent));
  const mutatedName = new Map(SAMPLE_FILES);
  mutatedName.delete('dev.md');
  mutatedName.set('dev2.md', 'C');
  assert.notEqual(computePromptSetHash(SAMPLE_FILES), computePromptSetHash(mutatedName));
});

test('promptSetHash() 读盘稳定且 prompts/ 恰好四模板', () => {
  assert.equal(promptSetHash(), promptSetHash());
  const manifest = promptSetManifest();
  assert.deepEqual(
    [...manifest.keys()].sort(),
    ['coordinator.md', 'dev.md', 'executor.md', 'reviewer.md'],
  );
  assert.equal(promptSetHash(), computePromptSetHash(manifest));
});

// ---------------------------------------------------------------------------
// T3.1 claim 装配点接线：认领成功落 prompt_set_hash 事件
// ---------------------------------------------------------------------------

test('claim 成功落 prompt_set_hash 事件（T3.1 装配点接线）', async () => {
  const h = createFakeHost();
  try {
    const { taskId } = await declareSampleTask(h);
    const claim = await createClaimService({
      db: h.db,
      config: h.config,
      orca: h.orca,
      jj: h.jj,
      env: h.env,
      trustProvision: h.trust.provision,
      stepTimeoutMs: h.deps.stepTimeoutMs,
    }).claim('cap-coord-1', { taskId });

    const rows = h.db
      .prepare('SELECT payload_json FROM events WHERE task_id = ? AND type = ?')
      .all(taskId, PROMPT_SET_HASH_EVENT_TYPE);
    assert.equal(rows.length, 1, '应恰好一条 prompt_set_hash 事件');
    const payload = JSON.parse(String(rows[0]?.payload_json)) as Record<string, unknown>;
    assert.equal(payload['claimId'], claim.claimId);
    assert.equal(payload['role'], 'executor');
    assert.equal(payload['promptSetVersion'], PROMPT_SET_VERSION);
    assert.equal(payload['promptSetHash'], promptSetHash());
  } finally {
    h.dispose();
  }
});
