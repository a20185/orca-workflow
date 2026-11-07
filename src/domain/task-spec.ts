import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { GovConfig } from '../config.ts';
import { acceptanceCriterionSchema } from './acceptance.ts';
import { formatZodIssues, GovError } from './errors.ts';

const nonEmptyText = z.string().min(1);
const gtTaskId = nonEmptyText.regex(/^gt-.+$/);
const baseCommitId = nonEmptyText.regex(/^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/);

/**
 * 目标为 kind 判别联合：top-level 必填 bookmark、出现 parentClaimId 即拒；
 * parent-claim 必填 gt- 前缀的 parentClaimId、出现 bookmark 即拒。分支内
 * 其余键由 strict 直接拒收；bookmark 是否属于 repo.targets 由 parseTaskSpec
 * 结合配置校验。
 */
export const taskTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('top-level'),
    bookmark: nonEmptyText,
  }),
  z.strictObject({
    kind: z.literal('parent-claim'),
    parentClaimId: gtTaskId,
  }),
]);

export const taskSpecSchema = z.strictObject({
  schemaVersion: z.literal(1),
  taskId: gtTaskId,
  problem: nonEmptyText,
  inScope: z.array(nonEmptyText).min(1),
  outOfScope: z.array(nonEmptyText).min(1),
  nonGoals: z.array(nonEmptyText).min(1),
  ownedPaths: z.array(nonEmptyText).min(1),
  repoId: nonEmptyText,
  target: taskTargetSchema,
  baseCommitId,
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
  parentTaskId: gtTaskId.optional(),
  supersedesTaskId: gtTaskId.optional(),
  agentPolicy: z.strictObject({
    executor: z.literal('opencode'),
    reviewer: z.enum(['claude', 'codex']),
  }),
  budget: z.strictObject({
    maxReviewRounds: z.number().int().min(1),
    maxWallSeconds: z.number().int().min(60),
    maxEvidenceBytes: z.number().int().min(1024),
  }),
});

export type TaskTarget = z.infer<typeof taskTargetSchema>;
export type TaskSpec = z.infer<typeof taskSpecSchema>;

/**
 * 仓库相对路径：非空、不以 / 开头、无 `..` 段、无空段（拒绝 `a/`、`a//b`）。
 * ownedPaths 与 artifact 验收标准 path 共用同一口径，禁止逃逸到宿主任意路径。
 */
export function isRepoRelativePath(p: string): boolean {
  if (p.length === 0 || p.startsWith('/')) {
    return false;
  }
  return p.split('/').every((segment) => segment.length > 0 && segment !== '..');
}

/**
 * 解析并校验任务书。结构/格式问题（含 target 各分支的字段配置）抛
 * E_SPEC_INVALID；跨字段约束使用各自的专属错误码，供上游按码分诊：路径逃逸
 * E_PATH_OUT_OF_SCOPE、仓库未配置 E_REPO_NOT_CONFIGURED、bookmark 不属于
 * repo.targets 时 E_TARGET_INVALID、criterionId 重复 E_CRITERIA_INVALID。
 * repoId/target 的校验依赖调用方传入的 GovConfig。
 */
export function parseTaskSpec(input: unknown, config: GovConfig): TaskSpec {
  const parsed = taskSpecSchema.safeParse(input);
  if (!parsed.success) {
    throw new GovError('E_SPEC_INVALID', `任务书校验失败: ${formatZodIssues(parsed.error)}`);
  }
  const spec = parsed.data;

  for (const p of spec.ownedPaths) {
    if (!isRepoRelativePath(p)) {
      throw new GovError('E_PATH_OUT_OF_SCOPE', `ownedPaths 含非仓库相对路径: ${p}`);
    }
  }
  for (const criterion of spec.acceptanceCriteria) {
    if (criterion.type === 'artifact' && !isRepoRelativePath(criterion.config.path)) {
      throw new GovError(
        'E_PATH_OUT_OF_SCOPE',
        `artifact 验收标准 path 非仓库相对路径: ${criterion.config.path}`,
      );
    }
  }

  const repo = config.repos.find((r) => r.repoId === spec.repoId);
  if (!repo) {
    throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在 GovConfig.repos 中配置: ${spec.repoId}`);
  }

  if (spec.target.kind === 'top-level' && !repo.targets.includes(spec.target.bookmark)) {
    throw new GovError(
      'E_TARGET_INVALID',
      `top-level bookmark 不在 repo.targets 中: ${spec.target.bookmark}`,
    );
  }

  const seenCriterionIds = new Set<string>();
  for (const criterion of spec.acceptanceCriteria) {
    if (seenCriterionIds.has(criterion.criterionId)) {
      throw new GovError('E_CRITERIA_INVALID', `criterionId 重复: ${criterion.criterionId}`);
    }
    seenCriterionIds.add(criterion.criterionId);
  }

  return spec;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortKeysDeep(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * 任务书规范化：递归键排序后的稳定 JSON 与其 sha256（specHash）。
 * specHash 是内容的确定性指纹，与原始键序无关，用于幂等比对与缓存键。
 */
export function normalizeTaskSpec(spec: TaskSpec): { canonical: string; specHash: string } {
  const canonical = JSON.stringify(sortKeysDeep(spec));
  const specHash = createHash('sha256').update(canonical, 'utf8').digest('hex');
  return { canonical, specHash };
}
