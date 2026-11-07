import { z } from 'zod';

/**
 * 验收标准三型，判别字段 type。criterionId 的唯一性在任务书级校验
 * （见 task-spec.ts 的 parseTaskSpec），单条标准不做跨标准检查。
 */

export const commandCriterionSchema = z.strictObject({
  type: z.literal('command'),
  criterionId: z.string().min(1),
  config: z.strictObject({
    command: z.array(z.string()),
    cwd: z.literal('review-workspace'),
    expectedExit: z.literal(0),
  }),
});

export const artifactCriterionSchema = z.strictObject({
  type: z.literal('artifact'),
  criterionId: z.string().min(1),
  config: z.strictObject({
    // 仓库相对路径的形状（绝对路径、.. 段、空段）在 parseTaskSpec 统一拒绝，
    // 这里只保证非空字符串。
    path: z.string().min(1),
    minBytes: z.number().int().min(1),
    maxBytes: z.number().int(),
  }),
});

export const manualCriterionSchema = z.strictObject({
  type: z.literal('manual'),
  criterionId: z.string().min(1),
  config: z.strictObject({
    description: z.string().min(1),
  }),
});

export const acceptanceCriterionSchema = z.discriminatedUnion('type', [
  commandCriterionSchema,
  artifactCriterionSchema,
  manualCriterionSchema,
]);

export type CommandCriterion = z.infer<typeof commandCriterionSchema>;
export type ArtifactCriterion = z.infer<typeof artifactCriterionSchema>;
export type ManualCriterion = z.infer<typeof manualCriterionSchema>;
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;
