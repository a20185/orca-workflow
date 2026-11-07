import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  acceptanceCriterionSchema,
  artifactCriterionSchema,
  manualCriterionSchema,
} from '../../../src/domain/acceptance.ts';

test('command 标准合法形态通过，cwd/expectedExit 候选外被拒', () => {
  const ok = acceptanceCriterionSchema.parse({
    type: 'command',
    criterionId: 'ac-cmd',
    config: { command: ['pnpm', 'check'], cwd: 'review-workspace', expectedExit: 0 },
  });
  assert.equal(ok.type, 'command');

  assert.equal(
    acceptanceCriterionSchema.safeParse({
      type: 'command',
      criterionId: 'ac-cmd',
      config: { command: ['pnpm', 'check'], cwd: '/tmp', expectedExit: 0 },
    }).success,
    false,
  );
  assert.equal(
    acceptanceCriterionSchema.safeParse({
      type: 'command',
      criterionId: 'ac-cmd',
      config: { command: ['pnpm', 'check'], cwd: 'review-workspace', expectedExit: 1 },
    }).success,
    false,
  );
});

test('command 标准的空命令数组被拒', () => {
  assert.equal(
    acceptanceCriterionSchema.safeParse({
      type: 'command',
      criterionId: 'ac-cmd',
      config: { command: [], cwd: 'review-workspace', expectedExit: 0 },
    }).success,
    false,
  );
});

test('artifact 标准的 minBytes >= 1、maxBytes 整数、path 非空', () => {
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: 'out/r.md', minBytes: 0, maxBytes: 100 },
    }).success,
    false,
  );
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: '', minBytes: 1, maxBytes: 100 },
    }).success,
    false,
  );
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: 'out/r.md', minBytes: 1, maxBytes: 1.5 },
    }).success,
    false,
  );
  // maxBytes 下界及与 minBytes 的交叉校验
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: 'out/r.md', minBytes: 10, maxBytes: 0 },
    }).success,
    false,
  );
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: 'out/r.md', minBytes: 100, maxBytes: 99 },
    }).success,
    false,
  );
  assert.equal(
    artifactCriterionSchema.safeParse({
      type: 'artifact',
      criterionId: 'ac-a',
      config: { path: 'out/r.md', minBytes: 100, maxBytes: 100 },
    }).success,
    true,
  );
});

test('manual 标准的 description 非空', () => {
  assert.equal(
    manualCriterionSchema.safeParse({ type: 'manual', criterionId: 'ac-m', config: { description: '' } })
      .success,
    false,
  );
  assert.equal(
    manualCriterionSchema.safeParse({ type: 'manual', criterionId: 'ac-m', config: { description: '人工确认' } })
      .success,
    true,
  );
});

test('未知 criterion type 被判别联合拒绝', () => {
  assert.equal(
    acceptanceCriterionSchema.safeParse({
      type: 'llm-judge',
      criterionId: 'ac-x',
      config: {},
    }).success,
    false,
  );
});
