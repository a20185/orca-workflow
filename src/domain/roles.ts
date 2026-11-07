/** gov 的五个角色；dev 是仓库开发者视角，不持有任何 gov 动作。 */
export const GOV_ROLES = ['coordinator', 'executor', 'dev', 'reviewer', 'operator'] as const;

export type GovRole = (typeof GOV_ROLES)[number];

/** 角色 → 可执行的 gov 动作（设计 §9.1/§9.2）。只读映射，运行期不得扩展。 */
export const GOV_ACTIONS_BY_ROLE = {
  coordinator: ['declare', 'claim', 'status'],
  executor: ['accept', 'submit', 'fail', 'split', 'rebase', 'review-request', 'status'],
  reviewer: ['review-accept', 'review-submit', 'status'],
  operator: ['cancel', 'manual-approve', 'operation-show', 'operation-resume', 'serve', 'doctor', 'status'],
  dev: [],
} as const satisfies Readonly<Record<GovRole, readonly string[]>>;
