import type { ZodError } from 'zod';

/** 治理系统全部错误码。新增码必须先入设计契约，调用点不得私造字符串。 */
export const GOV_ERROR_CODES = [
  'E_CONFIG_INVALID',
  'E_SPEC_INVALID',
  'E_PATH_OUT_OF_SCOPE',
  'E_REPO_NOT_CONFIGURED',
  'E_TARGET_INVALID',
  'E_CRITERIA_INVALID',
  'E_RUNTIME_UNSUPPORTED',
  'E_DB_MIGRATION',
  'E_TRANSITION_INVALID',
  // T1.3 宿主 API 面：传输、鉴权、幂等与动作分发的稳定错误码。
  'E_NOT_FOUND',
  'E_UNAUTHENTICATED',
  'E_FORBIDDEN_ACTION',
  'E_TOKEN_EXPIRED',
  'E_REQUEST_HASH_MISMATCH',
  'E_PAYLOAD_TOO_LARGE',
  'E_TIMEOUT',
  'E_ACTION_UNIMPLEMENTED',
  'E_REQUEST_INVALID',
  // T2.1 Orca CLI 适配层：runtime 门禁、调用失败、结构校验与禁用动词。
  'E_ORCA_RUNTIME_DOWN',
  'E_ORCA_CALL_FAILED',
  'E_ORCA_SCHEMA',
  'E_ORCA_FORBIDDEN_VERB',
] as const;

export type GovErrorCode = (typeof GOV_ERROR_CODES)[number];

export class GovError extends Error {
  readonly code: GovErrorCode;

  constructor(code: GovErrorCode, message: string) {
    super(message);
    this.name = 'GovError';
    this.code = code;
  }
}

/** 把 Zod 校验失败压成单行可读文本，随 GovError message 抛出；不携带堆栈。 */
export function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
