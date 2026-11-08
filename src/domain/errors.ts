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
  // T3.2 提交/评审服务层：提交状态非法、评审身份禁止、评审 tree 改动、人工回执
  // 无效、补证据重送非法、轮数预算耗尽、退回恢复工作区分叉与无可用评审者。
  'E_SUBMIT_INVALID',
  'E_REVIEW_FORBIDDEN',
  'E_REVIEW_TREE_CHANGED',
  'E_MANUAL_RECEIPT_INVALID',
  'E_REVIEW_REQUEST_INVALID',
  'E_BUDGET_EXCEEDED',
  'E_WORKSPACE_DIVERGED',
  'E_NO_REVIEWER',
  // T3.3 合并/归档/清理服务层：合并结果不确定（读回不一致或外部步骤超时，绝不
  // 回滚不清理）、归档失败（cleanup_pending，资源全保留）与清理失败（单项 failed
  // 可重试）。目标移动复用 E_JJ_TARGET_MOVED（适配器已按同一语义抛出）。
  'E_MERGE_UNCERTAIN',
  'E_ARCHIVE_FAILED',
  'E_CLEANUP_FAILED',
  // T4.1 恢复层：未经查明外部事实的恢复处置、旧 writer 仍存活时禁止替换、
  // 以及操作/任务/认领处于不可恢复处置的状态。
  'E_RECOVERY_UNVERIFIED',
  'E_RECOVERY_WRITER_ALIVE',
  'E_RECOVERY_STATE_INVALID',
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
