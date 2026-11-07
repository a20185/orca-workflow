import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { formatZodIssues, GovError } from './domain/errors.ts';

/**
 * hostPath 必须是绝对路径。macOS 上 /tmp 是 /private/tmp 的符号链接：
 * 比较或展示 hostPath 前应先做 realpath 归一化，否则同一仓库会被
 * /tmp/... 与 /private/tmp/... 两种写法识别成两个不同路径。
 */
export const repoConfigSchema = z.strictObject({
  repoId: z.string().min(1),
  hostPath: z
    .string()
    .min(1)
    .refine((p) => p.startsWith('/'), { message: 'hostPath 必须是以 / 开头的绝对路径' }),
  targets: z
    .array(z.string().min(1))
    .min(1)
    .refine((targets) => new Set(targets).size === targets.length, {
      message: 'targets 内不得有重复项',
    }),
});

export const govConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  // 空仓清单没有可治理对象，视为配置错误而非合法空态。
  repos: z.array(repoConfigSchema).min(1),
  // 归档根（T3.3）：任务收尾时 evidence 产物与回执快照落盘位置，必须是绝对路径。
  archiveRoot: z
    .string()
    .min(1)
    .refine((p) => p.startsWith('/'), { message: 'archiveRoot 必须是以 / 开头的绝对路径' }),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;
export type GovConfig = z.infer<typeof govConfigSchema>;

/** 读取并 strict 解析配置文件；读取失败、非法 JSON、结构不符均抛 E_CONFIG_INVALID。 */
export async function loadConfig(path: string): Promise<GovConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    throw new GovError('E_CONFIG_INVALID', `无法读取配置文件 ${path}: ${errorMessage(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new GovError('E_CONFIG_INVALID', `配置文件不是合法 JSON: ${errorMessage(err)}`);
  }

  const parsed = govConfigSchema.safeParse(json);
  if (!parsed.success) {
    throw new GovError('E_CONFIG_INVALID', `配置校验失败: ${formatZodIssues(parsed.error)}`);
  }
  return parsed.data;
}

/** Node 主版本低于 24（LTS 基线）即拒绝；版本串可注入，便于测试不依赖真实降级。 */
export function assertRuntime(version: string = process.version): void {
  const majorText = version.replace(/^v/, '').split('.')[0] ?? '';
  const major = Number.parseInt(majorText, 10);
  if (!Number.isInteger(major) || major < 24) {
    throw new GovError('E_RUNTIME_UNSUPPORTED', `需要 Node.js >= 24，实际版本: ${version}`);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
