import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GOV_ACTIONS_BY_ROLE, GOV_ROLES } from '../../../src/domain/roles.ts';

test('GOV_ACTIONS_BY_ROLE 与设计 §9.1/§9.2 的动作映射一致', () => {
  assert.deepEqual(GOV_ACTIONS_BY_ROLE, {
    coordinator: ['declare', 'claim', 'status'],
    executor: ['accept', 'submit', 'fail', 'split', 'rebase', 'review-request', 'status'],
    reviewer: ['review-accept', 'review-submit', 'status'],
    operator: ['cancel', 'manual-approve', 'operation-show', 'operation-resume', 'serve', 'doctor'],
    dev: [],
  });
});

test('GOV_ROLES 恰为五个角色且映射键与角色集一致', () => {
  assert.deepEqual(GOV_ROLES, ['coordinator', 'executor', 'dev', 'reviewer', 'operator']);
  assert.deepEqual(
    Object.keys(GOV_ACTIONS_BY_ROLE).sort(),
    [...GOV_ROLES].sort(),
  );
});

test('dev 角色不持有任何 gov 动作', () => {
  assert.deepEqual(GOV_ACTIONS_BY_ROLE.dev, []);
});
