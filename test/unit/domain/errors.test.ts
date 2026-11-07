import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GOV_ERROR_CODES, GovError } from '../../../src/domain/errors.ts';

test('GOV_ERROR_CODES 恰为契约约定的全部错误码（T1.1 九码 + T1.3 九码 + T2.1 Orca 四码 + T2.2 jj 七码 + T2.3 环境五码 + T3.1 认领五码）', () => {
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
    'E_ORCA_RUNTIME_DOWN',
    'E_ORCA_CALL_FAILED',
    'E_ORCA_SCHEMA',
    'E_ORCA_FORBIDDEN_VERB',
    'E_JJ_CALL_FAILED',
    'E_JJ_CONFLICT',
    'E_JJ_NOT_FAST_FORWARD',
    'E_JJ_TARGET_MOVED',
    'E_JJ_PATH_OUT_OF_SCOPE',
    'E_JJ_STALE',
    'E_JJ_SCHEMA',
    'E_ENV_CREATE_FAILED',
    'E_ENV_SWITCH_FAILED',
    'E_ENV_LIFECYCLE_FAILED',
    'E_ENV_NOT_FOUND',
    'E_ENV_SCHEMA',
    'E_CLAIM_EXISTS',
    'E_CLAIM_PREP_FAILED',
    'E_CLAIM_UNCERTAIN',
    'E_CLAIM_RETRY_EXHAUSTED',
    'E_CLAIM_STATE_INVALID',
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
