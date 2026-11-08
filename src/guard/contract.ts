/**
 * T5.1 受限启动器契约常量：gov 侧 guard-authorize 与镜像内 guard.mjs 共用的
 * 白名单真源（TS 面）。容器侧 guard.mjs 逐字镜像本表（无构建步骤，纯静态
 * 文件进镜像）；两层的偏差由隔离测试同时断言「容器拒 + gov 拒」兜住。
 *
 * guard-authorize 不进 GOV_ACTIONS_BY_ROLE：它是 guard 协议的引导型动作
 *（与 token-issue 同类），只有 executor/reviewer 令牌可调，由 handler 内
 * 双重校验（角色 + 认领/评审绑定），见 guard-authorize.ts。
 */

/** guard 允许代理的 Orca 动词（orchestration 子命令）；管理动词一律拒绝。 */
export const GUARD_ORCA_VERBS = ['check', 'ask', 'reply', 'send'] as const;

export type GuardOrcaVerb = (typeof GUARD_ORCA_VERBS)[number];

/** guard orca send 允许的消息类型（按角色）；其余类型（handoff/question/…）拒绝。 */
export const GUARD_SEND_TYPES_BY_ROLE = {
  executor: ['heartbeat', 'status', 'escalation', 'merge_ready', 'worker_done'],
  reviewer: ['heartbeat', 'status', 'escalation', 'worker_done'],
} as const;

/** guard orca 各动词允许的 CLI 标志；true = 消费一个值，false = 布尔开关。--json 由 guard 注入。 */
export const GUARD_ORCA_FLAGS_BY_VERB: Readonly<Record<GuardOrcaVerb, Readonly<Record<string, boolean>>>> = {
  check: { '--wait': false, '--timeout-ms': true, '--ack': true, '--types': true },
  ask: { '--question': true, '--options': true, '--timeout-ms': true },
  reply: { '--id': true, '--body': true },
  send: { '--type': true, '--subject': true, '--body': true, '--phase': true, '--outcome': true, '--priority': true },
};

/** 调用者传入即被剥除的身份/寻址标志：guard 只使用 gov 校验过的回执值。 */
export const GUARD_STRIPPED_CALLER_FLAGS = [
  '--from',
  '--terminal',
  '--to',
  '--run',
  '--task-id',
  '--dispatch-id',
  '--pairing-code',
  '--environment',
] as const;

/** 参数注入黑名单（即使 execFile 无 shell 也拒绝，契约可测）。 */
export const GUARD_ARG_FORBIDDEN_PATTERN = /[\n\r\0`;]|\$\(/;

/** worker_done 的 --outcome 合法值。 */
export const GUARD_WORKER_DONE_OUTCOMES = ['succeeded', 'failed'] as const;

/**
 * guard 身份文件（容器内 /var/lib/orca-broker/identity.json，broker 0600）的
 * 字段面。由 T3.1 claim / T3.2 review 流程经 env userData 注入——任务用户与
 * Agent 环境变量都不是其来源。
 */
export interface GuardIdentity {
  /** gov 令牌（govt_，绑 claim/review）。 */
  readonly token: string;
  /** gov API 基址（容器视角，如 http://host.docker.internal:7788）。 */
  readonly govBaseUrl: string;
  readonly taskId: string;
  readonly claimId?: string | undefined;
  readonly reviewId?: string | undefined;
  readonly terminalHandle: string;
  readonly dispatchId: string;
  /** 桌面 runtime 的 CLI 远端配对码（orca://pair?...；探针候选 A 通道）。 */
  readonly orcaPairingCode: string;
}
