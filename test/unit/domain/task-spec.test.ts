import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { GovConfig } from '../../../src/config.ts';
import { GovError, type GovErrorCode } from '../../../src/domain/errors.ts';
import { normalizeTaskSpec, parseTaskSpec } from '../../../src/domain/task-spec.ts';

const config: GovConfig = {
  schemaVersion: 1,
  repos: [{ repoId: 'demo', hostPath: '/srv/repos/demo', targets: ['main', 'feat-x'] }],
};

function validCriteria(): Array<Record<string, unknown>> {
  return [
    {
      type: 'command',
      criterionId: 'ac-cmd',
      config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 },
    },
    {
      type: 'artifact',
      criterionId: 'ac-artifact',
      config: { path: 'out/report.md', minBytes: 1, maxBytes: 1_048_576 },
    },
    {
      type: 'manual',
      criterionId: 'ac-manual',
      config: { description: '人工复核认领日志' },
    },
  ];
}

function validSpec(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId: 'gt-0001',
    problem: '修复并发认领时的死锁',
    inScope: ['src/queue/', 'src/claim/'],
    outOfScope: ['docs/'],
    nonGoals: ['不更换数据库'],
    ownedPaths: ['src/queue/claim.ts'],
    repoId: 'demo',
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: '1f'.repeat(20),
    acceptanceCriteria: validCriteria(),
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 3, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
  };
}

function expectCode(code: GovErrorCode, fn: () => unknown): GovError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof GovError, `应抛 GovError，实际抛出: ${String(err)}`);
    assert.equal(err.code, code);
    return err;
  }
  assert.fail(`应抛 GovError(${code})，但调用成功`);
}

test('合法任务书通过解析', () => {
  const spec = parseTaskSpec(validSpec(), config);
  assert.equal(spec.taskId, 'gt-0001');
  assert.equal(spec.target.kind, 'top-level');
  assert.equal(spec.acceptanceCriteria.length, 3);
});

test('未知字段被拒：顶层 / target / budget / agentPolicy / criterion config', () => {
  const criteria = validCriteria();
  const badCriterion = {
    ...criteria[0]!,
    config: { ...(criteria[0]!.config as Record<string, unknown>), extra: true },
  };
  const cases: Array<Record<string, unknown>> = [
    { ...validSpec(), extra: 'x' },
    { ...validSpec(), target: { kind: 'top-level', bookmark: 'main', extra: 1 } },
    { ...validSpec(), budget: { maxReviewRounds: 3, maxWallSeconds: 3600, maxEvidenceBytes: 1024, extra: 1 } },
    { ...validSpec(), agentPolicy: { executor: 'opencode', reviewer: 'claude', extra: 1 } },
    { ...validSpec(), acceptanceCriteria: [badCriterion, ...criteria.slice(1)] },
  ];
  for (const spec of cases) {
    expectCode('E_SPEC_INVALID', () => parseTaskSpec(spec, config));
  }
});

test('空 ownedPaths 与空 acceptanceCriteria 被拒', () => {
  expectCode('E_SPEC_INVALID', () => parseTaskSpec({ ...validSpec(), ownedPaths: [] }, config));
  expectCode('E_SPEC_INVALID', () => parseTaskSpec({ ...validSpec(), acceptanceCriteria: [] }, config));
});

test('ownedPaths 中的绝对路径被拒（E_PATH_OUT_OF_SCOPE）', () => {
  expectCode('E_PATH_OUT_OF_SCOPE', () =>
    parseTaskSpec({ ...validSpec(), ownedPaths: ['/etc/passwd'] }, config),
  );
});

test('ownedPaths 中的 .. 段、空段被拒（E_PATH_OUT_OF_SCOPE）', () => {
  for (const bad of ['../outside.ts', 'src/../lib/x.ts', 'src//x.ts', 'src/']) {
    expectCode('E_PATH_OUT_OF_SCOPE', () => parseTaskSpec({ ...validSpec(), ownedPaths: [bad] }, config));
  }
});

test('ownedPaths 正常仓库相对路径通过，含子目录与 . 段', () => {
  const spec = parseTaskSpec({ ...validSpec(), ownedPaths: ['src/a.ts', 'docs/sub/b.md', './local.md'] }, config);
  assert.equal(spec.ownedPaths.length, 3);
});

test('artifact 验收标准的绝对 path 被拒（E_PATH_OUT_OF_SCOPE）', () => {
  const criteria = validCriteria();
  const bad = {
    ...criteria[1]!,
    config: { ...(criteria[1]!.config as Record<string, unknown>), path: '/tmp/leak.txt' },
  };
  expectCode('E_PATH_OUT_OF_SCOPE', () =>
    parseTaskSpec({ ...validSpec(), acceptanceCriteria: [criteria[0]!, bad] }, config),
  );
});

test('repoId 未在 GovConfig.repos 配置被拒（E_REPO_NOT_CONFIGURED）', () => {
  expectCode('E_REPO_NOT_CONFIGURED', () =>
    parseTaskSpec({ ...validSpec(), repoId: 'not-configured' }, config),
  );
});

test('top-level 目标缺 bookmark 被拒（E_TARGET_INVALID）', () => {
  expectCode('E_TARGET_INVALID', () =>
    parseTaskSpec({ ...validSpec(), target: { kind: 'top-level' } }, config),
  );
});

test('top-level bookmark 不在 repo.targets 被拒（E_TARGET_INVALID）', () => {
  expectCode('E_TARGET_INVALID', () =>
    parseTaskSpec({ ...validSpec(), target: { kind: 'top-level', bookmark: 'unknown-branch' } }, config),
  );
});

test('top-level bookmark 命中 repo.targets 通过', () => {
  const spec = parseTaskSpec({ ...validSpec(), target: { kind: 'top-level', bookmark: 'feat-x' } }, config);
  assert.equal(spec.target.bookmark, 'feat-x');
});

test('parent-claim 缺 parentClaimId 被拒（E_TARGET_INVALID）', () => {
  expectCode('E_TARGET_INVALID', () =>
    parseTaskSpec({ ...validSpec(), target: { kind: 'parent-claim' } }, config),
  );
});

test('parent-claim 携带 parentClaimId 通过', () => {
  const spec = parseTaskSpec(
    { ...validSpec(), target: { kind: 'parent-claim', parentClaimId: 'gc-0042' } },
    config,
  );
  assert.equal(spec.target.parentClaimId, 'gc-0042');
});

test('criterionId 重复被拒（E_CRITERIA_INVALID）', () => {
  const criteria = validCriteria();
  const dup = { ...criteria[2]!, criterionId: 'ac-cmd' };
  expectCode('E_CRITERIA_INVALID', () =>
    parseTaskSpec({ ...validSpec(), acceptanceCriteria: [criteria[0]!, dup] }, config),
  );
});

test('budget 下界：恰好达标通过，差 1 或非整数被拒', () => {
  parseTaskSpec(
    {
      ...validSpec(),
      budget: { maxReviewRounds: 1, maxWallSeconds: 60, maxEvidenceBytes: 1024 },
    },
    config,
  );
  for (const budget of [
    { maxReviewRounds: 0, maxWallSeconds: 60, maxEvidenceBytes: 1024 },
    { maxReviewRounds: 1, maxWallSeconds: 59, maxEvidenceBytes: 1024 },
    { maxReviewRounds: 1, maxWallSeconds: 60, maxEvidenceBytes: 1023 },
    { maxReviewRounds: 1.5, maxWallSeconds: 60, maxEvidenceBytes: 1024 },
  ]) {
    expectCode('E_SPEC_INVALID', () => parseTaskSpec({ ...validSpec(), budget }, config));
  }
});

test('taskId 与可选父级字段必须是 gt- 前缀；baseCommitId 须为 40/64 位 hex', () => {
  expectCode('E_SPEC_INVALID', () => parseTaskSpec({ ...validSpec(), taskId: 'task-1' }, config));
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), parentTaskId: 'parent-1' }, config),
  );
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), supersedesTaskId: 'old-1' }, config),
  );
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), baseCommitId: 'zz'.repeat(20) }, config),
  );
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), baseCommitId: '1f'.repeat(39) }, config),
  );

  const ok = parseTaskSpec(
    { ...validSpec(), parentTaskId: 'gt-0000', supersedesTaskId: 'gt-0009', baseCommitId: 'ab'.repeat(32) },
    config,
  );
  assert.equal(ok.parentTaskId, 'gt-0000');
});

test('agentPolicy 候选集外被拒', () => {
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), agentPolicy: { executor: 'claude', reviewer: 'claude' } }, config),
  );
  expectCode('E_SPEC_INVALID', () =>
    parseTaskSpec({ ...validSpec(), agentPolicy: { executor: 'opencode', reviewer: 'gpt' } }, config),
  );
  const ok = parseTaskSpec(
    { ...validSpec(), agentPolicy: { executor: 'opencode', reviewer: 'codex' } },
    config,
  );
  assert.equal(ok.agentPolicy.reviewer, 'codex');
});

function reverseKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(reverseKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      out[key] = reverseKeysDeep(source[key]);
    }
    return out;
  }
  return value;
}

test('specHash 确定性：同内容不同键序得到相同 canonical 与哈希', () => {
  const a = normalizeTaskSpec(parseTaskSpec(validSpec(), config));
  const reordered = reverseKeysDeep(validSpec());
  const b = normalizeTaskSpec(parseTaskSpec(reordered, config));
  assert.match(a.specHash, /^[0-9a-f]{64}$/);
  assert.equal(a.canonical, b.canonical);
  assert.equal(a.specHash, b.specHash);
});

test('specHash 对内容变化敏感', () => {
  const a = normalizeTaskSpec(parseTaskSpec(validSpec(), config));
  const mutated = { ...validSpec(), problem: '另一个问题陈述' };
  const b = normalizeTaskSpec(parseTaskSpec(mutated, config));
  assert.notEqual(a.specHash, b.specHash);
});
