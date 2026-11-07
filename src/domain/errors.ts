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
