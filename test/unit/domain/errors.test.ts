import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GOV_ERROR_CODES, GovError } from '../../../src/domain/errors.ts';

test('GOV_ERROR_CODES 恰为契约约定的全部错误码（T1.1 九码 + T1.3 宿主 API 九码）', () => {
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
    'E_NOT_FOUND',
    'E_UNAUTHENTICATED',
    'E_FORBIDDEN_ACTION',
    'E_TOKEN_EXPIRED',
    'E_REQUEST_HASH_MISMATCH',
    'E_PAYLOAD_TOO_LARGE',
    'E_TIMEOUT',
    'E_ACTION_UNIMPLEMENTED',
    'E_REQUEST_INVALID',
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
