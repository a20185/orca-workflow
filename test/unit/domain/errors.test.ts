import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GOV_ERROR_CODES, GovError } from '../../../src/domain/errors.ts';

test('GOV_ERROR_CODES 恰为契约约定的九个错误码', () => {
  assert.deepEqual(GOV_ERROR_CODES, [
    'E_CONFIG_INVALID',
    'E_SPEC_INVALID',
    'E_PATH_OUT_OF_SCOPE',
    'E_REPO_NOT_CONFIGURED',
    'E_TARGET_INVALID',
    'E_CRITERIA_INVALID',
    'E_RUNTIME_UNSUPPORTED',
    'E_DB_MIGRATION',
    'E_TRANSITION_INVALID',
  ]);
});

test('GovError 是 Error 且携带 code', () => {
  const err = new GovError('E_SPEC_INVALID', '任务书校验失败');
  assert.ok(err instanceof Error);
  assert.ok(err instanceof GovError);
  assert.equal(err.code, 'E_SPEC_INVALID');
  assert.equal(err.name, 'GovError');
  assert.equal(err.message, '任务书校验失败');
});
