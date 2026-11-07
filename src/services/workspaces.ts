/**
 * 工作区准备与宿主信任预置（T3.1，设计 §8.1 claim 第 2–4 步）：
 * jj workspace → 一次性执行环境 → 信任条目，严格顺序推进，每步经 StepLedger
 * 落 operations 回执；确定失败按逆序清理已建资源，结果不确定（超时/被杀）不做
 * 任何清理，交上层置 UNCERTAIN。
 */
import { randomBytes } from 'node:crypto';
import { mkdirSync, realpathSync, rmSync } from 'node:fs';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { EnvConnectionReceipt } from '../adapters/environment.ts';
import type { GovConfig } from '../config.ts';
import { GovError } from '../domain/errors.ts';
import type { TaskSpec } from '../domain/task-spec.ts';
import type { EnvPort, JjPort, TrustHandle, TrustProvision } from './ports.ts';
import { isUncertainOutcome } from './ports.ts';

/** 认领准备阶段名（错误消息、blockedReason 语义与 operations.current_step 共用）。 */
export type PrepStage = 'workspace' | 'env' | 'trust';

/**
 * 每步回执账本：把 operations 表的确定性幂等键（claim:<claimId>:<stage>）包成
 * begin/confirm/fail/uncertain 四个动作。claims.ts 持有实现；本模块只消费。
 */
export interface StepLedger {
  begin(stage: string, refs: Record<string, unknown>): string;
  confirm(operationId: string, stage: string, refs: Record<string, unknown>): void;
  fail(operationId: string, stage: string, code: string, message: string): void;
  uncertain(operationId: string, stage: string, message: string): void;
}

export interface PreparedWorkspace {
  readonly workspaceId: string;
  readonly claimId: string;
  readonly jjName: string;
  /** realpath 归一后的宿主工作区路径（Orca path: 选择器与信任条目都用它）。 */
  readonly hostPath: string;
  /** 容器内可写区相对名（同时是宿主工作区下的子目录名）。 */
  readonly taskDirRel: string;
  readonly envInstanceId: string;
  readonly envConnection: EnvConnectionReceipt;
  readonly trustHandle: TrustHandle;
  /** 逆序清理已建资源（trust → env → jj workspace + 宿主目录）；尽力而为，失败追加进 errors。 */
  cleanup(errors: string[]): Promise<void>;
}

export interface PrepareWorkspaceDeps {
  readonly db: DatabaseSync;
  readonly jj: JjPort;
  readonly env: EnvPort;
  readonly config: GovConfig;
  readonly trustProvision: TrustProvision;
  readonly ledger: StepLedger;
}

function randomSuffix(): string {
  return randomBytes(4).toString('hex');
}

/** jj workspace 名只允许 [A-Za-z0-9._-]（T2.2 适配器门卫）；taskId 中的其余字符折叠为 '-'。 */
function slugify(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]/g, '-');
}

/**
 * 落工作区行的环境/清理状态。env_status 受 CHECK 约束
 * （running/suspended/destroying/uncertain）：容器确认销毁后置 NULL 表示
 * 「无附着容器」，销毁未证实置 'uncertain' 留待人工；完成语义由 cleanup_status 承载。
 */
function settleWorkspaceRow(
  db: DatabaseSync,
  workspaceId: string,
  envStatus: string | null,
  cleanupStatus: string,
): void {
  db.prepare('UPDATE workspaces SET env_status = ?, cleanup_status = ? WHERE workspace_id = ?').run(
    envStatus,
    cleanupStatus,
    workspaceId,
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * claim 第 2–4 步。任一步：
 * - 确定失败 → 本步 ledger.fail + 逆序回滚已建资源 → 抛 E_CLAIM_PREP_FAILED（带阶段名）；
 * - 结果不确定 → 本步 ledger.uncertain、不清理 → 抛 E_CLAIM_UNCERTAIN（上层置认领 UNCERTAIN）。
 */
export async function prepareWorkspace(
  deps: PrepareWorkspaceDeps,
  input: {
    readonly claimId: string;
    readonly spec: TaskSpec;
    readonly repoHostPath: string;
  },
): Promise<PreparedWorkspace> {
  const { db, ledger } = deps;
  const repo = deps.config.repos.find((r) => r.repoId === input.spec.repoId);
  if (repo === undefined) {
    // parseTaskSpec 已保证 repoId 在配置内；此处防御库内声明载荷与配置漂移。
    throw new GovError('E_REPO_NOT_CONFIGURED', `repoId 未在配置中: ${input.spec.repoId}`);
  }
  const wsRoot = join(input.repoHostPath, '.gov-workspaces');

  // —— 第 2 步：jj workspace（base=spec.baseCommitId）——
  const jjName = `gt-${slugify(input.spec.taskId)}-${randomSuffix()}`;
  const wsPath = join(wsRoot, jjName);
  const workspaceId = `gws_${randomBytes(12).toString('base64url')}`;
  let workspaceInserted = false;
  const wsOp = ledger.begin('workspace', {
    taskId: input.spec.taskId,
    name: jjName,
    path: wsPath,
    base: input.spec.baseCommitId,
  });
  let hostPath: string | undefined;
  try {
    mkdirSync(wsRoot, { recursive: true });
    const added = await deps.jj.workspaceAdd({
      name: jjName,
      path: wsPath,
      rev: input.spec.baseCommitId,
    });
    hostPath = realpathSync(added.path);
    db.prepare(
      'INSERT INTO workspaces (workspace_id, jj_workspace_name, host_path, base_commit_id) VALUES (?, ?, ?, ?)',
    ).run(workspaceId, jjName, hostPath, input.spec.baseCommitId);
    workspaceInserted = true;
  } catch (err) {
    const message = errorMessage(err);
    if (isUncertainOutcome(err)) {
      ledger.uncertain(wsOp, 'workspace', message);
      throw new GovError('E_CLAIM_UNCERTAIN', `认领准备结果不确定(阶段 workspace): ${message}`);
    }
    ledger.fail(wsOp, 'workspace', err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED', message);
    if (workspaceInserted) {
      db.prepare('UPDATE workspaces SET cleanup_status = ? WHERE workspace_id = ?').run(
        'rolled_back',
        workspaceId,
      );
    } else if (hostPath !== undefined && hostPath.startsWith(wsRoot)) {
      // workspaceAdd 建目录后、写库前失败：目录是唯一残留，直接删。
      rmSync(hostPath, { recursive: true, force: true });
    }
    throw new GovError('E_CLAIM_PREP_FAILED', `认领准备失败(阶段 workspace, 已回滚): ${message}`);
  }
  ledger.confirm(wsOp, 'workspace', {
    workspaceId,
    name: jjName,
    path: hostPath,
    base: input.spec.baseCommitId,
  });

  // —— 第 3 步：一次性执行环境（双层挂载 + 遮蔽 + 0000 只读）——
  const taskDirRel = `${slugify(input.claimId)}-w`;
  const envOp = ledger.begin('env', { workspaceId, taskDirRel });
  let envInstanceId: string | undefined;
  let envConnection: EnvConnectionReceipt | undefined;
  try {
    // 环境适配器要求可写子目录已存在（T2.3 契约：create 不负责建宿主目录）。
    mkdirSync(join(hostPath, taskDirRel), { recursive: true });
    const created = await deps.env.create({ workspaceHostPath: hostPath, taskDirRel });
    envInstanceId = created.envInstanceId;
    envConnection = created.connection;
    db.prepare('UPDATE workspaces SET env_instance_id = ?, env_status = ? WHERE workspace_id = ?').run(
      envInstanceId,
      'running',
      workspaceId,
    );
  } catch (err) {
    const message = errorMessage(err);
    if (isUncertainOutcome(err)) {
      ledger.uncertain(envOp, 'env', message);
      throw new GovError('E_CLAIM_UNCERTAIN', `认领准备结果不确定(阶段 env): ${message}`);
    }
    const rollbackErrors: string[] = [];
    // create 确定失败也可能已留下容器（T2.3：resourceId 在错误 detail 中保留）。
    const residualId =
      envInstanceId ?? (err as { detail?: { resourceId?: string } } | null)?.detail?.resourceId;
    let envSettled = false;
    if (residualId !== undefined) {
      try {
        await deps.env.destroy(residualId);
        envSettled = true;
      } catch (cleanupErr) {
        rollbackErrors.push(`env.destroy(${residualId}): ${errorMessage(cleanupErr)}`);
      }
    }
    try {
      await deps.jj.workspaceForget(jjName);
    } catch (cleanupErr) {
      rollbackErrors.push(`jj.workspaceForget(${jjName}): ${errorMessage(cleanupErr)}`);
    }
    if (hostPath.startsWith(wsRoot)) {
      rmSync(hostPath, { recursive: true, force: true });
    }
    // env_status 受 CHECK 约束（running/suspended/destroying/uncertain）：容器已
    // 确认销毁则置 NULL（无附着容器），销毁未证实则 'uncertain' 留待人工。
    settleWorkspaceRow(db, workspaceId, envSettled ? null : 'uncertain', 'rolled_back');
    ledger.fail(envOp, 'env', err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED', message);
    throw new GovError(
      'E_CLAIM_PREP_FAILED',
      `认领准备失败(阶段 env, 已回滚${rollbackErrors.length > 0 ? `; 回滚残误: ${rollbackErrors.join('; ')}` : ''}): ${message}`,
    );
  }
  ledger.confirm(envOp, 'env', { envInstanceId, taskDirRel });

  // —— 第 4 步：宿主信任预置（worker 启动前完成；幂等）——
  const trustOp = ledger.begin('trust', { workspaceId, hostPath });
  let trustHandle: TrustHandle | undefined;
  try {
    trustHandle = await deps.trustProvision(hostPath);
  } catch (err) {
    const message = errorMessage(err);
    const rollbackErrors: string[] = [];
    if (isUncertainOutcome(err)) {
      ledger.uncertain(trustOp, 'trust', message);
      throw new GovError('E_CLAIM_UNCERTAIN', `认领准备结果不确定(阶段 trust): ${message}`);
    }
    let envSettled = false;
    try {
      await deps.env.destroy(envInstanceId);
      envSettled = true;
    } catch (cleanupErr) {
      rollbackErrors.push(`env.destroy(${envInstanceId}): ${errorMessage(cleanupErr)}`);
    }
    try {
      await deps.jj.workspaceForget(jjName);
    } catch (cleanupErr) {
      rollbackErrors.push(`jj.workspaceForget(${jjName}): ${errorMessage(cleanupErr)}`);
    }
    if (hostPath.startsWith(wsRoot)) {
      rmSync(hostPath, { recursive: true, force: true });
    }
    settleWorkspaceRow(db, workspaceId, envSettled ? null : 'uncertain', 'rolled_back');
    ledger.fail(trustOp, 'trust', err instanceof GovError ? err.code : 'E_CLAIM_PREP_FAILED', message);
    throw new GovError(
      'E_CLAIM_PREP_FAILED',
      `认领准备失败(阶段 trust, 已回滚${rollbackErrors.length > 0 ? `; 回滚残误: ${rollbackErrors.join('; ')}` : ''}): ${message}`,
    );
  }
  ledger.confirm(trustOp, 'trust', { hostPath });

  const finalEnvId = envInstanceId;
  const finalConnection = envConnection;
  if (finalEnvId === undefined || finalConnection === undefined) {
    throw new GovError('E_CLAIM_PREP_FAILED', '环境回执缺失（内部不变量破坏）');
  }

  return {
    workspaceId,
    claimId: input.claimId,
    jjName,
    hostPath,
    taskDirRel,
    envInstanceId: finalEnvId,
    envConnection: finalConnection,
    trustHandle,
    async cleanup(errors: string[]): Promise<void> {
      try {
        await trustHandle.cleanup();
      } catch (cleanupErr) {
        errors.push(`trust.cleanup: ${errorMessage(cleanupErr)}`);
      }
      let envSettled = false;
      try {
        await deps.env.destroy(finalEnvId);
        envSettled = true;
      } catch (cleanupErr) {
        errors.push(`env.destroy(${finalEnvId}): ${errorMessage(cleanupErr)}`);
      }
      try {
        await deps.jj.workspaceForget(jjName);
      } catch (cleanupErr) {
        errors.push(`jj.workspaceForget(${jjName}): ${errorMessage(cleanupErr)}`);
      }
      // 宿主目录删除前先确认仍在锁定的 workspace 根下：适配器返回异位路径时宁可残留也不误删。
      if (hostPath.startsWith(wsRoot)) {
        rmSync(hostPath, { recursive: true, force: true });
      }
      settleWorkspaceRow(db, workspaceId, envSettled ? null : 'uncertain', 'released');
    },
  };
}

// ---------------------------------------------------------------------------
// 默认信任预置：向宿主 CLAUDE_CONFIG_DIR/.claude.json 的 projects 信任表写入
// hasTrustDialogAccepted 条目（与 T2.1 集成测试 seedClaudeWorkspaceTrust 同一口径）。
// 接口化以便单测注入假实现；真实全链行为由 T6.x 校准。
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const TRUST_FLAG = 'hasTrustDialogAccepted';

function resolveClaudeConfigFile(): string {
  const configDir = process.env['CLAUDE_CONFIG_DIR'];
  const dir = configDir !== undefined && configDir.length > 0 ? configDir : join(homedir(), '.claude');
  return join(dir, '.claude.json');
}

async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.gov-tmp-${randomBytes(6).toString('hex')}`;
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8');
  await rename(tmp, file);
}

/**
 * 默认信任预置（幂等）：
 * - 条目已带 hasTrustDialogAccepted:true → 不写盘，返回 no-op 句柄；
 * - 否则补写条目（不覆盖条目内其他键、不动其他条目），原子替换写盘；
 * - cleanup 只撤销本次增量：本次新建的条目整体删除，本次补写的 flag 移除。
 */
export function createDefaultTrustProvision(): TrustProvision {
  return async (workspaceRealPath: string) => {
    const file = resolveClaudeConfigFile();
    let doc: Record<string, unknown>;
    let fileExisted: boolean;
    let raw: string | null = null;
    try {
      raw = await readFile(file, 'utf8');
      fileExisted = true;
    } catch {
      fileExisted = false;
    }
    if (fileExisted) {
      const parsed: unknown = JSON.parse(raw as string);
      if (!isRecord(parsed)) {
        throw new Error(`${file} 不是 JSON 对象，拒绝改写宿主配置`);
      }
      doc = parsed;
    } else {
      doc = {};
    }
    const projects = isRecord(doc['projects']) ? (doc['projects'] as Record<string, unknown>) : {};
    const entry = isRecord(projects[workspaceRealPath]) ? (projects[workspaceRealPath] as Record<string, unknown>) : undefined;
    if (entry !== undefined && entry[TRUST_FLAG] === true) {
      return { cleanup: async () => {} };
    }
    const entryExisted = entry !== undefined;
    const nextProjects = { ...projects, [workspaceRealPath]: { ...entry, [TRUST_FLAG]: true } };
    await writeJsonAtomic(file, { ...doc, projects: nextProjects });

    return {
      async cleanup(): Promise<void> {
        let current: Record<string, unknown>;
        try {
          current = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        } catch {
          // 配置被外部改写/删除：本次增量已随之消失或无法定位，不强行恢复。
          return;
        }
        if (!isRecord(current)) {
          return;
        }
        const currentProjects = current['projects'];
        if (!isRecord(currentProjects)) {
          return;
        }
        const currentEntry = currentProjects[workspaceRealPath];
        if (!entryExisted) {
          if (isRecord(currentEntry) && currentEntry[TRUST_FLAG] === true && Object.keys(currentEntry).length === 1) {
            delete currentProjects[workspaceRealPath];
            await writeJsonAtomic(file, current);
          }
          return;
        }
        if (isRecord(currentEntry) && currentEntry[TRUST_FLAG] === true) {
          const restored = { ...currentEntry };
          delete restored[TRUST_FLAG];
          currentProjects[workspaceRealPath] = restored;
          await writeJsonAtomic(file, current);
        }
      },
    };
  };
}
