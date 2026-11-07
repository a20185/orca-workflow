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
  // T2.2 jj 适配层：调用失败、冲突、非快进、目标移动、路径越界、工作副本过期与输出结构。
  'E_JJ_CALL_FAILED',
  'E_JJ_CONFLICT',
  'E_JJ_NOT_FAST_FORWARD',
  'E_JJ_TARGET_MOVED',
  'E_JJ_PATH_OUT_OF_SCOPE',
  'E_JJ_STALE',
  'E_JJ_SCHEMA',
  // T2.3 环境适配层：创建失败、读写切换失败、生命周期失败、环境不存在与 recipe 输出结构。
  'E_ENV_CREATE_FAILED',
  'E_ENV_SWITCH_FAILED',
  'E_ENV_LIFECYCLE_FAILED',
  'E_ENV_NOT_FOUND',
  'E_ENV_SCHEMA',
  // T3.1 认领服务层：并发唯一冲突、准备阶段失败、外部结果不确定、重试耗尽与状态非法。
  'E_CLAIM_EXISTS',
  'E_CLAIM_PREP_FAILED',
  'E_CLAIM_UNCERTAIN',
  'E_CLAIM_RETRY_EXHAUSTED',
  'E_CLAIM_STATE_INVALID',
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
