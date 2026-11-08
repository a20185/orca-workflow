/**
 * T4.2 单测：拆分三道门（范围/深度/单阻塞）+ 子基线冲突 + 暂停失败续跑 +
 * SUPERSEDED 改绑等待 + T4.1 接口对 WAITING_CHILD 父任务的拒绝（简报「本任务
 * 补单测」项）。全链真实适配器行为归 test/integration/children/。
 *
 * 端口为假适配器（同 test/unit/claims 先例）：结构满足端口签名，外部副作用
 * 逐段可脚本化；假 jj 的 snapshot 恒回 BASE_COMMIT，故子任务书基线用它构造。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/db/database.ts';
import { migrate } from '../../../src/db/migrations.ts';
import type { GovConfig } from '../../../src/config.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { applyTaskTransition } from '../../../src/state/task-machine.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { createChildrenService, MAX_CHILD_DEPTH, type SplitResult } from '../../../src/services/children.ts';
import { createRecoveryService } from '../../../src/services/recovery.ts';
import type {
  EnvLifecyclePort,
  JjChildAdvancePort,
  JjMergePort,
  JjFactsPort,
  OrcaFactsPort,
  OrcaSettlementPort,
  TrustProvision,
} from '../../../src/services/ports.ts';
import type { WorkerSettleReceipt, WorkerShowReceipt } from '../../../src/adapters/orca.ts';
import { FakeEnv, FakeJj, FakeOrca } from '../claims/testing.ts';

const BASE_COMMIT = 'a'.repeat(40);
const SESSION = 'gt-unit-exec';

const noOpTrust: TrustProvision = async () => ({ cleanup: async () => {} });

// ---------------------------------------------------------------------------
// 假端口：在 claims 测试假件上补齐 T3.2/T3.3/T4.1/T4.2 扩展面
// ---------------------------------------------------------------------------

class SettlementOrca extends FakeOrca implements OrcaSettlementPort, OrcaFactsPort {
  readonly sentMessages: Array<{ dispatch: string; subject: string; body: string }> = [];

  private settle(dispatchId: string, state: string): { ok: true; raw: WorkerSettleReceipt } {
    return { ok: true, raw: { dispatchId, state, alreadySettled: true, processAction: 'none' } };
  }

  async workerStop(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    return this.settle(dispatch, 'stopped');
  }

  async workerShow(dispatch: string): Promise<{ ok: true; raw: WorkerShowReceipt }> {
    return {
      ok: true,
      raw: { dispatch: { id: dispatch, taskId: '', status: 'stopped' }, worker: { dispatchId: dispatch, state: 'stopped' } },
    };
  }

  async workerAbandon(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    return this.settle(dispatch, 'abandoned');
  }

  async workerRelease(dispatch: string): Promise<{ ok: true; raw: WorkerSettleReceipt }> {
    return this.settle(dispatch, 'released');
  }

  async sendToDispatch(input: {
    readonly dispatch: string;
    readonly type: 'status' | 'merge_ready' | 'question';
    readonly subject: string;
    readonly body: string;
  }): Promise<{ ok: true; raw: unknown }> {
    this.sentMessages.push({ dispatch: input.dispatch, subject: input.subject, body: input.body });
    return { ok: true, raw: {} };
  }

  async runUse(): Promise<{ ok: true; raw: never }> {
    throw new Error('单测不应触达 runUse');
  }

  async runCurrent(): Promise<{ ok: true; raw: never }> {
    throw new Error('单测不应触达 runCurrent');
  }

  async workerList(): Promise<{ ok: true; raw: never }> {
    throw new Error('单测不应触达 workerList');
  }
}

class ChildJj extends FakeJj implements JjMergePort, JjChildAdvancePort, JjFactsPort {
  readonly advanceCalls: Array<{ dir: string; rev: string; expectedCurrent: string }> = [];
  failAdvance = false;

  async snapshot(): Promise<{ ok: true; commitId: string; treeId: string; opIds: string[] }> {
    return { ok: true, commitId: BASE_COMMIT, treeId: 'tree-1', opIds: ['op-snap'] };
  }

  async diffPaths(): Promise<{ ok: true; paths: string[] }> {
    return { ok: true, paths: [] };
  }

  async conflictList(): Promise<{ ok: true; conflicts: string[] }> {
    return { ok: true, conflicts: [] };
  }

  async bookmarkCurrent(): Promise<{ ok: true; commitId: string }> {
    return { ok: true, commitId: BASE_COMMIT };
  }

  async rebase(input: { readonly newBase: string }): Promise<{ ok: true; newCommitId: string; conflicts: string[]; opIds: string[] }> {
    return { ok: true, newCommitId: input.newBase, conflicts: [], opIds: ['op-rebase'] };
  }

  async moveBookmarkFF(input: { readonly expectedCurrent: string; readonly toCommit: string }): Promise<{ ok: true; from: string; to: string; opIds: string[] }> {
    return { ok: true, from: input.expectedCurrent, to: input.toCommit, opIds: ['op-move'] };
  }

  async opLogReceipt(): Promise<{ ok: true; opIds: string[] }> {
    return { ok: true, opIds: ['op-log'] };
  }

  async workspaceList(): Promise<{ ok: true; workspaces: never[] }> {
    return { ok: true, workspaces: [] };
  }

  async isAncestorOrEqual(): Promise<{ ok: true; result: boolean }> {
    return { ok: true, result: true };
  }

  async advanceWorkingCopy(input: { readonly dir: string; readonly rev: string; readonly expectedCurrent: string }): Promise<{ ok: true; commitId: string; opIds: string[] }> {
    if (this.failAdvance) {
      throw new GovError('E_JJ_CALL_FAILED', '注入的快进失败');
    }
    this.advanceCalls.push(input);
    return { ok: true, commitId: input.rev, opIds: ['op-adv'] };
  }
}

class LifecycleEnv extends FakeEnv implements EnvLifecyclePort {
  readonly suspendCalls: string[] = [];
  readonly resumeCalls: string[] = [];
  readonly failSuspendFor = new Set<string>();

  async suspend(envId: string): Promise<{ ok: true; suspended: boolean; resourceId: string; existed: boolean }> {
    this.suspendCalls.push(envId);
    if (this.failSuspendFor.has(envId)) {
      throw new GovError('E_ENV_LIFECYCLE_FAILED', `注入的 suspend 失败(单测): ${envId}`);
    }
    return { ok: true, suspended: true, resourceId: envId, existed: true };
  }

  async resume(envId: string): Promise<{ ok: true; resourceId: string; connection: { type: 'ssh'; host: string; port: number; username: string; projectRoot: string } }> {
    this.resumeCalls.push(envId);
    return {
      ok: true,
      resourceId: envId,
      connection: { type: 'ssh', host: '127.0.0.1', port: 2222, username: 'dev', projectRoot: '/work' },
    };
  }
}

// ---------------------------------------------------------------------------
// 测试宿主
// ---------------------------------------------------------------------------

interface Host {
  readonly db: DatabaseSync;
  readonly config: GovConfig;
  readonly orca: SettlementOrca;
  readonly jj: ChildJj;
  readonly env: LifecycleEnv;
  readonly children: ReturnType<typeof createChildrenService>;
  dispose(): void;
}

function topSpec(taskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    taskId,
    problem: `单测任务 ${taskId}`,
    inScope: ['src/a'],
    outOfScope: ['src/b'],
    nonGoals: ['不引入新框架'],
    ownedPaths: ['src/a'],
    repoId: 'demo',
    target: { kind: 'top-level', bookmark: 'main' },
    baseCommitId: BASE_COMMIT,
    acceptanceCriteria: [
      { type: 'command', criterionId: 'cmd-1', config: { command: ['pnpm', 'test'], cwd: 'review-workspace', expectedExit: 0 } },
      { type: 'manual', criterionId: 'man-1', config: { description: '人工核验' } },
    ],
    agentPolicy: { executor: 'opencode', reviewer: 'claude' },
    budget: { maxReviewRounds: 2, maxWallSeconds: 3600, maxEvidenceBytes: 1_048_576 },
    ...extra,
  };
}

function childSpecOf(parentTaskId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  // parentClaimId 按 T1.2 冻结 schema 携带父任务 id（锚定其当前认领）。
  return topSpec(`${parentTaskId}-c1`, {
    target: { kind: 'parent-claim', parentClaimId: parentTaskId },
    parentTaskId,
    ...extra,
  });
}

function createHost(): Host {
  const rawRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-children-test-'));
  const config: GovConfig = {
    schemaVersion: 1,
    repos: [{ repoId: 'demo', hostPath: path.join(rawRoot, 'repo'), targets: ['main'] }],
    archiveRoot: path.join(rawRoot, 'archive'),
  };
  const db = openDatabase(':memory:');
  migrate(db);
  const orca = new SettlementOrca();
  const jj = new ChildJj();
  const env = new LifecycleEnv();
  const children = createChildrenService({ db, config, orca, jj, env, trustProvision: noOpTrust, stepTimeoutMs: 50 });
  return {
    db,
    config,
    orca,
    jj,
    env,
    children,
    dispose() {
      db.close();
      for (const dir of jj.createdDirs) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.rmSync(rawRoot, { recursive: true, force: true });
    },
  };
}

/** 声明并认领接受到 ACTIVE（假端口全成功路径）。 */
async function driveActive(host: Host, spec: Record<string, unknown>): Promise<{ taskId: string; claimId: string; envId: string }> {
  await declareTask({ db: host.db, config: host.config, orca: host.orca }, { spec, session: SESSION });
  const taskId = String((spec as { taskId: string }).taskId);
  const claims = createClaimService({
    db: host.db,
    config: host.config,
    orca: host.orca,
    jj: host.jj,
    env: host.env,
    trustProvision: noOpTrust,
    stepTimeoutMs: 50,
  });
  const claimed = await claims.claim(SESSION, { taskId });
  await claims.accept({ taskId, claimId: claimed.claimId, tokenClaimId: claimed.claimId, session: SESSION });
  const ws = host.db
    .prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(claimed.workspace.workspaceId) as { env_instance_id: string } | undefined;
  if (ws === undefined) {
    throw new Error('测试工作区行缺失');
  }
  return { taskId, claimId: claimed.claimId, envId: String(ws.env_instance_id) };
}

async function expectGovError(promise: Promise<unknown>, code: string, needle?: string): Promise<GovError> {
  let threw: unknown;
  try {
    await promise;
  } catch (err) {
    threw = err;
  }
  if (!(threw instanceof GovError)) {
    throw new Error(`预期 GovError(${code})，实际: ${String(threw)}`);
  }
  assert.equal(threw.code, code);
  if (needle !== undefined) {
    assert.ok(threw.message.includes(needle), `message 应含 "${needle}": ${threw.message}`);
  }
  return threw;
}

function statusOf(host: Host, taskId: string): string {
  return String(host.db.prepare('SELECT status FROM tasks WHERE task_id = ?').get(taskId)?.status);
}

function blockedOf(host: Host, taskId: string): string | null {
  const value = host.db.prepare('SELECT blocked_reason FROM tasks WHERE task_id = ?').get(taskId)?.blocked_reason;
  return value === null || value === undefined ? null : String(value);
}

function eventCount(host: Host, taskId: string, type: string): number {
  return Number(host.db.prepare('SELECT COUNT(*) AS c FROM events WHERE task_id = ? AND type = ?').get(taskId, type)?.c ?? 0);
}

// ---------------------------------------------------------------------------
// 场景
// ---------------------------------------------------------------------------

test('子任务路径越界 → E_CHILD_SCOPE_INVALID，父任务不动', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    await expectGovError(
      host.children.taskSplit({
        taskId: parent.taskId,
        childSpec: childSpecOf(parent.taskId, { ownedPaths: ['src/b'] }),
        session: SESSION,
      }),
      'E_CHILD_SCOPE_INVALID',
      'src/b',
    );
    assert.equal(statusOf(host, parent.taskId), 'ACTIVE', '校验失败不得改父任务状态');
    assert.equal(
      host.db.prepare("SELECT COUNT(*) AS c FROM operations WHERE kind = 'split'").get()?.c,
      0,
      '校验失败不得开拆分账本',
    );
  } finally {
    host.dispose();
  }
});

test('子任务基线与父锁定版本不符 → E_PARENT_DIVERGED', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    await expectGovError(
      host.children.taskSplit({
        taskId: parent.taskId,
        childSpec: childSpecOf(parent.taskId, { baseCommitId: 'b'.repeat(40) }),
        session: SESSION,
      }),
      'E_PARENT_DIVERGED',
      '子任务基线',
    );
    assert.equal(statusOf(host, parent.taskId), 'ACTIVE');
  } finally {
    host.dispose();
  }
});

test('三层深度限制 → 深度 3 任务的拆分 E_CHILD_DEPTH_EXCEEDED', async () => {
  const host = createHost();
  try {
    // 直接铺链（深度判定只读 tasks.parent_task_id，不依赖逐层真实拆分）：
    // c0(根)→c1→c2→c3，c3 深度 3，其子为 4，超限。
    const ids = ['gt-u-c0', 'gt-u-c1', 'gt-u-c2', 'gt-u-c3'];
    for (const id of ids) {
      await declareTask({ db: host.db, config: host.config, orca: host.orca }, { spec: topSpec(id), session: SESSION });
    }
    for (let i = 1; i < ids.length; i += 1) {
      const ancestorId = ids[i - 1] as string;
      const descendantId = ids[i] as string;
      host.db.prepare('UPDATE tasks SET parent_task_id = ? WHERE task_id = ?').run(ancestorId, descendantId);
    }
    const leaf = await driveActive(host, topSpec('gt-u-c3'));
    await expectGovError(
      host.children.taskSplit({
        taskId: leaf.taskId,
        childSpec: childSpecOf(leaf.taskId),
        session: SESSION,
      }),
      'E_CHILD_DEPTH_EXCEEDED',
      String(MAX_CHILD_DEPTH),
    );
  } finally {
    host.dispose();
  }
});

test('单阻塞：父已有活动子任务 → E_CHILD_EXISTS；拆分成功后父 WAITING_CHILD + 环境暂停 + 子已认领', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    const split = await host.children.taskSplit({
      taskId: parent.taskId,
      childSpec: childSpecOf(parent.taskId),
      session: SESSION,
    });
    assert.equal(split.parentStatus, 'WAITING_CHILD');
    assert.equal(split.parentRevision, BASE_COMMIT);
    assert.equal(statusOf(host, parent.taskId), 'WAITING_CHILD');
    assert.equal(statusOf(host, split.childTaskId), 'DECLARED', '子任务声明后待接受');
    assert.equal(
      host.db.prepare('SELECT parent_task_id FROM tasks WHERE task_id = ?').get(split.childTaskId)?.parent_task_id,
      parent.taskId,
      '子任务应回填 parent_task_id',
    );
    assert.deepEqual(host.env.suspendCalls, [parent.envId], '拆分即暂停父环境');
    assert.equal(
      host.db.prepare('SELECT status FROM operations WHERE request_id = ?').get(split.splitRequestId)?.status,
      'IN_FLIGHT',
      'split 操作应保持 IN_FLIGHT（子终态前）',
    );

    await expectGovError(
      host.children.taskSplit({
        taskId: parent.taskId,
        childSpec: childSpecOf(parent.taskId, { taskId: 'gt-u-parent-c2' }),
        session: SESSION,
      }),
      'E_CHILD_EXISTS',
    );
  } finally {
    host.dispose();
  }
});

test('父环境暂停失败 → 不建子任务、认领 UNCERTAIN、split FAILED；重试续跑成功', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    host.env.failSuspendFor.add(parent.envId);
    await expectGovError(
      host.children.taskSplit({
        taskId: parent.taskId,
        childSpec: childSpecOf(parent.taskId),
        session: SESSION,
      }),
      'E_ENV_LIFECYCLE_FAILED',
    );
    assert.equal(statusOf(host, parent.taskId), 'WAITING_CHILD');
    assert.equal(
      String(host.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(parent.claimId)?.status),
      'UNCERTAIN',
    );
    assert.equal(blockedOf(host, parent.taskId), 'env_suspend_failed');
    assert.equal(
      host.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ?').get(parent.taskId)?.c,
      0,
      '暂停失败不得建子任务',
    );
    assert.equal(
      String(host.db.prepare("SELECT status FROM operations WHERE request_id = 'split:gt-u-parent:1'").get()?.status),
      'FAILED',
    );

    host.env.failSuspendFor.delete(parent.envId);
    const split = await host.children.taskSplit({
      taskId: parent.taskId,
      childSpec: childSpecOf(parent.taskId),
      session: SESSION,
    });
    assert.equal(split.retryContinuation, true, '重试应走续跑（不重复迁移）');
    assert.equal(statusOf(host, parent.taskId), 'WAITING_CHILD');
    assert.equal(
      String(host.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(parent.claimId)?.status),
      'ACTIVE',
      '续跑成功后父认领查明恢复 ACTIVE',
    );
    assert.equal(blockedOf(host, parent.taskId), null);
    assert.equal(
      String(host.db.prepare("SELECT status FROM operations WHERE request_id = 'split:gt-u-parent:2'").get()?.status),
      'IN_FLIGHT',
    );
  } finally {
    host.dispose();
  }
});

test('子 SUPERSEDED → 父 child_superseded 迁移 + 沿替代链等待（不重复迁移）', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    const split: SplitResult = await host.children.taskSplit({
      taskId: parent.taskId,
      childSpec: childSpecOf(parent.taskId),
      session: SESSION,
    });
    applyTaskTransition(host.db, split.childTaskId, 'supersede', { actor: SESSION });
    // 替代任务：声明即留在 DECLARED（非终态 → 父继续等待）。
    await declareTask(
      { db: host.db, config: host.config, orca: host.orca },
      {
        spec: topSpec('gt-u-parent-c1-rep', {
          supersedesTaskId: split.childTaskId,
          parentTaskId: parent.taskId,
          target: { kind: 'parent-claim', parentClaimId: parent.taskId },
        }),
        session: SESSION,
      },
    );

    const first = await host.children.resumeParent({ childTaskId: split.childTaskId, session: SESSION });
    if (first.outcome !== 'waiting') {
      assert.fail(`预期 waiting，实际 ${first.outcome}`);
    }
    assert.equal(first.successorChildTaskId, 'gt-u-parent-c1-rep');
    assert.equal(statusOf(host, parent.taskId), 'WAITING_CHILD');
    assert.equal(eventCount(host, parent.taskId, 'child_superseded'), 1);

    const second = await host.children.resumeParent({ childTaskId: split.childTaskId, session: SESSION });
    assert.equal(second.outcome, 'waiting');
    assert.equal(eventCount(host, parent.taskId, 'child_superseded'), 1, '重复调用不得重复迁移');
    assert.deepEqual(host.jj.advanceCalls, [], '等待期不得快进父工作副本');
    assert.equal(host.env.resumeCalls.length, 0, '等待期不得恢复父环境');
  } finally {
    host.dispose();
  }
});

test('T4.1 门：WAITING_CHILD 父任务的 replaceExecutor/supersedeTask → E_RECOVERY_STATE_INVALID', async () => {
  const host = createHost();
  try {
    const parent = await driveActive(host, topSpec('gt-u-parent'));
    await host.children.taskSplit({
      taskId: parent.taskId,
      childSpec: childSpecOf(parent.taskId),
      session: SESSION,
    });
    assert.equal(statusOf(host, parent.taskId), 'WAITING_CHILD');
    const recovery = createRecoveryService({
      db: host.db,
      config: host.config,
      orca: host.orca,
      jj: host.jj,
      env: host.env,
      trustProvision: noOpTrust,
      stepTimeoutMs: 50,
    });
    await expectGovError(
      recovery.replaceExecutor({ taskId: parent.taskId, session: 'gt-unit-op' }),
      'E_RECOVERY_STATE_INVALID',
    );
    await expectGovError(
      recovery.supersedeTask({ taskId: parent.taskId, newSpec: topSpec('gt-u-parent-v2'), session: 'gt-unit-op' }),
      'E_RECOVERY_STATE_INVALID',
      'WAITING_CHILD',
    );
  } finally {
    host.dispose();
  }
});
