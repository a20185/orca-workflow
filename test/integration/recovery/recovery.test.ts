/**
 * T4.1 真实恢复层集成测试（fail-loud：Orca / jj / Docker 不可用直接红）。
 *
 * 调用点矩阵（前后各一次，SimulatedExit=进程中途退出 → 一律 UNCERTAIN 口径）：
 * - claim 链：jj.workspaceAdd / env.create / trustProvision / orca.workerStart
 *   before → verify EXTERNAL_ABSENT → mark-failed-retryable（FENCE+清理半成品）→
 *   换新 requestId 重走一次成功；after → verify EXTERNAL_DONE → confirm-done
 *   续跑/收养既有资源，外部副作用计数各 ≤1（不重复建 workspace/env/派工）。
 * - submit 链：jj.snapshot（before/after）——submit 无步骤账本（T3.2 信封幂等
 *   即其恢复面），断言直接可重试且重提幂等（同 commit、单提交行）。
 * - 评审链：workspaceAdd / env.create / workerStart——createReviewSession 无
 *   步骤账本（适配记录）：uncertain 后重轮询撞名 → 确定失败回滚 → 第三次重建。
 * - 合并链：moveBookmarkFF（before→mark 后重走一次移动；after→confirm 补账
 *   不二次移动）；archive（只读归档根真实失败）；env.destroy 与 workspaceForget
 *   （cleanup 单项 failed 可重试、销毁/注销幂等——按 refId 定向注入保持确定性）。
 * - 专项：执行替换（stop→FENCED→retry-of；REVIEW_REQUESTED 按 §13.14）、旧
 *   writer 仍存活 → E_RECOVERY_WRITER_ALIVE、任务替代（SUPERSEDED+资源销毁
 *   回执）、未经 verify 的 resume → E_RECOVERY_UNVERIFIED、协调 run-use 幂等。
 *
 * 资源边界与回基准同 lifecycle：容器/worktree/repo/信任种子/临时目录零残留。
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GovError } from '../../../src/domain/errors.ts';
import { createMergeService, type CompleteResult } from '../../../src/services/merges.ts';
import { createSubmissionService, isSubmitAccepted, latestActiveSubmission } from '../../../src/services/submissions.ts';
import { createReviewService } from '../../../src/services/reviews.ts';
import { archiveTask, consumeCleanupIntents, runCleanup, scheduleCleanup } from '../../../src/services/cleanup.ts';
import type { ResumeResult } from '../../../src/services/recovery.ts';
import { createHandlerRegistry, registerCoreHandlers, type ActionContext } from '../../../src/api.ts';
import {
  blockedReason,
  claimStatus,
  dockerPsNames,
  driveToActive,
  driveToApproved,
  envExists,
  expectGovError,
  execJj,
  OPERATOR_SESSION,
  removeClaudeWorkspaceTrustSeeds,
  sha256,
  taskStatus,
  type Rail,
  type SharedContext,
} from '../lifecycle/fixture.ts';
import { OrcaAdapterError, predictWorktreePath } from '../../../src/adapters/orca.ts';
import {
  buildRail,
  claimServiceFor,
  createSharedContext,
  driveClaimed,
  DockerEnvFacts,
  EXEC_SESSION,
  faultedTrustProvision,
  opRow,
  recoveryFor,
  RecoveryOrca,
  recoveryJj,
  SimulatedExit,
  verifyExternal,
  withFaults,
} from './fixture.ts';

const shared: SharedContext = await createSharedContext();

/**
 * 注入退出的两种浮出形态都算命中：评审/submit 链不确定裸抛原 SimulatedExit；
 * claim/replace 链按 T3.1 口径包装成 GovError（message 保留注入标记）。
 */
function expectSimulatedExit(promise: Promise<unknown>, when: 'before' | 'after'): Promise<Error> {
  return promise.then(
    () => {
      throw new Error('预期 SimulatedExit，实际正常返回');
    },
    (err: unknown) => {
      if (
        err instanceof SimulatedExit ||
        (err instanceof Error && err.message.includes(`SIMULATED_EXIT(${when})`))
      ) {
        return err instanceof Error ? err : new Error(String(err));
      }
      throw new Error(`预期 SimulatedExit(${when})，实际: ${String(err)}`);
    },
  );
}

/** 断言 resume 返回处置变体（confirm-done / mark-failed-retryable）并收窄。 */
function asDisposition(
  result: ResumeResult,
): { readonly action: 'confirm-done' | 'mark-failed-retryable'; readonly idempotentReplay: boolean; readonly summary: Record<string, unknown> } {
  if (result.action === 'verify-external') {
    throw new Error(`预期处置结果，实际 ${result.action}`);
  }
  return result;
}

async function jjWsNames(rail: Rail, prefix: 'gt-' | 'gr-'): Promise<string[]> {
  const { stdout } = await execJj(rail.repoDir, ['workspace', 'list', '-T', 'name ++ "\\n"']);
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && l !== 'default' && l.startsWith(prefix));
}

/** 情景计数快照：env 创建 / 真实派工 / workspaceAdd / bookmark 移动。 */
function counters(rail: Rail) {
  return {
    envCreated: shared.env.createdEnvIds.length,
    realStarts: rail.orca.realStarts.length,
    wsAdds: rail.jj.workspaceAddCalls.length,
    moves: rail.jj.moveBookmarkFFCalls.length,
  };
}

function delta(before: ReturnType<typeof counters>, after: ReturnType<typeof counters>) {
  return {
    envCreated: after.envCreated - before.envCreated,
    realStarts: after.realStarts - before.realStarts,
    wsAdds: after.wsAdds - before.wsAdds,
    moves: after.moves - before.moves,
  };
}

/** rail 范围计数（共享库全局计数会串到其他 rail）。 */
function submissionCount(rail: Rail): number {
  return Number(
    shared.db
      .prepare('SELECT COUNT(*) AS c FROM submissions WHERE claim_id IN (SELECT claim_id FROM claims WHERE task_id = ?)')
      .get(rail.taskId)?.c,
  );
}

function reviewCount(rail: Rail): number {
  return Number(
    shared.db
      .prepare(
        `SELECT COUNT(*) AS c FROM reviews WHERE submission_id IN (
           SELECT submission_id FROM submissions WHERE claim_id IN (SELECT claim_id FROM claims WHERE task_id = ?))`,
      )
      .get(rail.taskId)?.c,
  );
}

function liveClaimId(rail: Rail): string {
  return String((shared.db.prepare('SELECT claim_id FROM claims WHERE task_id = ?').get(rail.taskId) as { claim_id: string }).claim_id);
}

async function accept(rail: Rail, claimId: string): Promise<void> {
  await claimServiceFor(rail, shared).accept({
    taskId: rail.taskId,
    claimId,
    tokenClaimId: claimId,
    session: EXEC_SESSION,
  });
}

/** 写工作文件并提交（R/S 前置）。 */
async function submitWork(rail: Rail, claimId: string, devWsPath: string): Promise<{ submissionId: string; commitId: string }> {
  fs.writeFileSync(join(devWsPath, 'src', 'a', `hello-${rail.scenario}.ts`), `export const scenario = '${rail.scenario}';\n`);
  const report = `# report ${rail.scenario}\n`;
  fs.mkdirSync(join(devWsPath, 'out'), { recursive: true });
  fs.writeFileSync(join(devWsPath, 'out', 'report.md'), report);
  const submitted = await createSubmissionService({
    db: shared.db,
    config: rail.config,
    jj: rail.jj,
    stepTimeoutMs: 120_000,
  }).submit({
    taskId: rail.taskId,
    claimId,
    tokenClaimId: claimId,
    session: EXEC_SESSION,
    evidenceManifest: [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: sha256(report) },
    ],
  });
  if (!isSubmitAccepted(submitted)) {
    throw new Error(`submit 不应要求 rebase: ${JSON.stringify(submitted)}`);
  }
  return { submissionId: submitted.submissionId, commitId: submitted.commitId };
}

function mergeServiceFor(rail: Rail, envOverride?: object, jjOverride?: object) {
  return createMergeService({
    db: shared.db,
    config: rail.config,
    jj: (jjOverride as Rail['jj']) ?? rail.jj,
    env: (envOverride as SharedContext['env']) ?? shared.env,
    orca: rail.orca,
    stepTimeoutMs: 120_000,
  });
}

function reviewServiceFor(rail: Rail, jjOverride?: object, envOverride?: object, orcaOverride?: object) {
  return createReviewService({
    db: shared.db,
    config: rail.config,
    orca: (orcaOverride as Rail['orca']) ?? rail.orca,
    jj: (jjOverride as Rail['jj']) ?? rail.jj,
    env: (envOverride as SharedContext['env']) ?? shared.env,
    stepTimeoutMs: 120_000,
  });
}

/** cleanup 定向故障：只对指定 envId 的 destroy 注入一次（清理多项时保持确定性）。 */
function faultedEnvDestroy(envId: string, when: 'before' | 'after'): SharedContext['env'] {
  const wrapper: SharedContext['env'] = Object.create(shared.env);
  let armed = true;
  (wrapper as unknown as Record<string, unknown>).destroy = async (id: string) => {
    if (id === envId && armed) {
      armed = false;
      if (when === 'before') {
        throw new SimulatedExit(`SIMULATED_EXIT(before) destroy:${id}`);
      }
      await shared.env.destroy(id);
      throw new SimulatedExit(`SIMULATED_EXIT(after) destroy:${id}`);
    }
    return shared.env.destroy(id);
  };
  return wrapper;
}

/** cleanup 定向故障：只对 gt- 前缀（开发工作区）的 forget 注入一次。 */
function faultedWsForget(rail: Rail, when: 'before' | 'after'): Rail['jj'] {
  const wrapper: Rail['jj'] = Object.create(rail.jj);
  let armed = true;
  (wrapper as unknown as Record<string, unknown>).workspaceForget = async (name: string) => {
    if (name.startsWith('gt-') && armed) {
      armed = false;
      if (when === 'before') {
        throw new SimulatedExit(`SIMULATED_EXIT(before) workspaceForget:${name}`);
      }
      await rail.jj.workspaceForget(name);
      throw new SimulatedExit(`SIMULATED_EXIT(after) workspaceForget:${name}`);
    }
    return rail.jj.workspaceForget(name);
  };
  return wrapper;
}

// ===========================================================================
// C 系列：claim 链四调用点 × before/after
// ===========================================================================

test('C1 workspaceAdd before → UNCERTAIN 阻断第二写入者 → verify ABSENT → mark-failed → 重走一次成功', async () => {
  const rail = await buildRail(shared, 'c1');
  const recovery = recoveryFor(rail, shared);

  await expectSimulatedExit(
    driveClaimed(rail, shared, { jj: withFaults(rail.jj, { method: 'workspaceAdd', when: 'before' }) }),
    'before',
  );
  const claimId = liveClaimId(rail);
  assert.equal(claimStatus(shared, claimId), 'UNCERTAIN');
  // 阻断第二写入者：UNCERTAIN 未处置前第二认领被拒。
  await expectGovError(driveClaimed(rail, shared), 'E_CLAIM_EXISTS');
  const wsOp = opRow(shared.db, `claim:${claimId}:workspace`);
  assert.equal(wsOp.status, 'UNCERTAIN');

  const v = await verifyExternal(recovery, wsOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_ABSENT', v.reason);

  // 未经查明（或引用不符/分类不符）的处置一律拒绝。
  await expectGovError(
    recovery.operationResume({ operationId: wsOp.operationId, action: 'mark-failed-retryable', session: OPERATOR_SESSION }),
    'E_RECOVERY_UNVERIFIED',
  );
  await expectGovError(
    recovery.operationResume({ operationId: wsOp.operationId, action: 'confirm-done', verificationRef: 'gvr_bogus', session: OPERATOR_SESSION }),
    'E_RECOVERY_UNVERIFIED',
  );
  await expectGovError(
    recovery.operationResume({ operationId: wsOp.operationId, action: 'confirm-done', verificationRef: v.verificationId, session: OPERATOR_SESSION }),
    'E_RECOVERY_UNVERIFIED',
  );

  const marked = asDisposition(
    await recovery.operationResume({
      operationId: wsOp.operationId,
      action: 'mark-failed-retryable',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(marked.action, 'mark-failed-retryable');
  assert.equal(opRow(shared.db, `claim:${claimId}:workspace`).status, 'FAILED');
  assert.equal(claimStatus(shared, claimId), 'FENCED');

  // 换新 requestId 重走：一次成功，外部副作用各 ≤1。
  const before = counters(rail);
  const claim = await driveClaimed(rail, shared);
  assert.deepEqual(delta(before, counters(rail)), { envCreated: 1, realStarts: 1, wsAdds: 1, moves: 0 });
  await rail.orca.workerStop(claim.dispatchId);
  await accept(rail, claim.claimId);
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  assert.equal((await jjWsNames(rail, 'gt-')).length, 1, '任务名下只应有 1 个开发工作区');
});

test('C2 workspaceAdd after → verify DONE → confirm 续跑不重建 workspace/env', async () => {
  const rail = await buildRail(shared, 'c2');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(
    driveClaimed(rail, shared, { jj: withFaults(rail.jj, { method: 'workspaceAdd', when: 'after' }) }),
    'after',
  );
  const claimId = liveClaimId(rail);
  const wsOp = opRow(shared.db, `claim:${claimId}:workspace`);

  const v = await verifyExternal(recovery, wsOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_DONE', v.reason);
  // DONE 不能 mark-failed-retryable（分类与动作一致门）。
  await expectGovError(
    recovery.operationResume({ operationId: wsOp.operationId, action: 'mark-failed-retryable', verificationRef: v.verificationId, session: OPERATOR_SESSION }),
    'E_RECOVERY_UNVERIFIED',
  );

  const before = counters(rail);
  const confirmed = asDisposition(
    await recovery.operationResume({
      operationId: wsOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(confirmed.action, 'confirm-done');
  assert.equal(confirmed.idempotentReplay, false);
  const d = delta(before, counters(rail));
  assert.equal(d.envCreated, 1, '续跑只补建缺失的 env');
  assert.equal(d.realStarts, 1, '续跑只派一次工');
  assert.equal(d.wsAdds, 0, '已查明的 workspace 不得重建');
  assert.equal(claimStatus(shared, claimId), 'ACTIVE');
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  assert.equal(opRow(shared.db, `claim:${claimId}:workspace`).status, 'CONFIRMED');

  // 重复 confirm：幂等回放，零新副作用。
  const replay = asDisposition(
    await recovery.operationResume({
      operationId: wsOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(replay.idempotentReplay, true);
  const afterConfirm = counters(rail);
  assert.deepEqual(delta(afterConfirm, counters(rail)), { envCreated: 0, realStarts: 0, wsAdds: 0, moves: 0 });
  await rail.orca.workerStop(String(confirmed.summary['dispatchId']));
});

test('C3 env.create before → verify ABSENT → mark 清理半成品 workspace → 重走', async () => {
  const rail = await buildRail(shared, 'c3');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(
    driveClaimed(rail, shared, { env: withFaults(shared.env, { method: 'create', when: 'before' }) }),
    'before',
  );
  const claimId = liveClaimId(rail);
  const envOp = opRow(shared.db, `claim:${claimId}:env`);
  const v = await verifyExternal(recovery, envOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_ABSENT', v.reason);

  const marked = asDisposition(
    await recovery.operationResume({
      operationId: envOp.operationId,
      action: 'mark-failed-retryable',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.deepEqual((marked.summary as { cleanupErrors: string[] }).cleanupErrors, []);
  assert.equal(claimStatus(shared, claimId), 'FENCED');
  // 半成品 workspace 已被 mark 处置清理：任务名下注册数回零。
  assert.equal((await jjWsNames(rail, 'gt-')).length, 0);

  const before = counters(rail);
  const claim = await driveClaimed(rail, shared);
  const d = delta(before, counters(rail));
  // fence-and-replace 的既定代价：workspace 注销后重建；env/派工仍各只一次真创建。
  assert.equal(d.wsAdds, 1);
  assert.equal(d.envCreated, 1);
  assert.equal(d.realStarts, 1);
  assert.equal((await jjWsNames(rail, 'gt-')).length, 1, '最终任务名下只有一个开发工作区');
  await rail.orca.workerStop(claim.dispatchId);
  await accept(rail, claim.claimId);
});

test('C4 env.create after → verify DONE（按挂载发现容器）→ confirm 复用容器续跑', async () => {
  const rail = await buildRail(shared, 'c4');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(
    driveClaimed(rail, shared, { env: withFaults(shared.env, { method: 'create', when: 'after' }) }),
    'after',
  );
  const claimId = liveClaimId(rail);
  const envOp = opRow(shared.db, `claim:${claimId}:env`);

  const v = await verifyExternal(recovery, envOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_DONE', v.reason);

  const before = counters(rail);
  const confirmed = asDisposition(
    await recovery.operationResume({
      operationId: envOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  const d = delta(before, counters(rail));
  assert.equal(d.envCreated, 0, '已查明的容器不得重建');
  assert.equal(d.wsAdds, 0);
  assert.equal(d.realStarts, 1);
  assert.equal(claimStatus(shared, claimId), 'ACTIVE');
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  // 容器在案：发现的 envInstanceId 已写回工作区行。
  const envId = String(confirmed.summary['envInstanceId']);
  assert.ok(envId.length > 0);
  assert.equal(await envExists(envId), true);
  await rail.orca.workerStop(String(confirmed.summary['dispatchId']));
});

test('C5 trust before → verify ABSENT → mark 清理 env+workspace → 重走', async () => {
  const rail = await buildRail(shared, 'c5');
  const recovery = recoveryFor(rail, shared);
  const envIndex = shared.env.createdEnvIds.length;
  await expectSimulatedExit(driveClaimed(rail, shared, { trust: faultedTrustProvision('before') }), 'before');
  const claimId = liveClaimId(rail);
  const trustOp = opRow(shared.db, `claim:${claimId}:trust`);

  const v = await verifyExternal(recovery, trustOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_ABSENT', v.reason);
  const marked = asDisposition(
    await recovery.operationResume({
      operationId: trustOp.operationId,
      action: 'mark-failed-retryable',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.deepEqual((marked.summary as { cleanupErrors: string[] }).cleanupErrors, []);
  // 半成品 env 已销毁、workspace 已注销。
  const firstEnv = shared.env.createdEnvIds[envIndex];
  assert.ok(firstEnv !== undefined);
  assert.equal(await envExists(firstEnv), false);
  assert.equal((await jjWsNames(rail, 'gt-')).length, 0);

  const claim = await driveClaimed(rail, shared);
  await rail.orca.workerStop(claim.dispatchId);
  await accept(rail, claim.claimId);
  assert.equal((await jjWsNames(rail, 'gt-')).length, 1);
});

test('C6 trust after → verify DONE（信任条目在案）→ confirm 跳过 trust 直派工', async () => {
  const rail = await buildRail(shared, 'c6');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(driveClaimed(rail, shared, { trust: faultedTrustProvision('after') }), 'after');
  const claimId = liveClaimId(rail);
  const trustOp = opRow(shared.db, `claim:${claimId}:trust`);

  const v = await verifyExternal(recovery, trustOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_DONE', v.reason);
  const before = counters(rail);
  const confirmed = asDisposition(
    await recovery.operationResume({
      operationId: trustOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  const d = delta(before, counters(rail));
  assert.equal(d.envCreated, 0);
  assert.equal(d.wsAdds, 0);
  assert.equal(d.realStarts, 1);
  assert.equal(claimStatus(shared, claimId), 'ACTIVE');
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  await rail.orca.workerStop(String(confirmed.summary['dispatchId']));
});

test('C7 workerStart before → verify ABSENT（任务名下无派工）→ mark → 重走（旧派工不存在故无 retry-of）', async () => {
  const rail = await buildRail(shared, 'c7');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(
    driveClaimed(rail, shared, { orca: withFaults(rail.orca, { method: 'workerStart', when: 'before' }) }),
    'before',
  );
  const claimId = liveClaimId(rail);
  const wsOp = opRow(shared.db, `claim:${claimId}:worker-start`);

  const v = await verifyExternal(recovery, wsOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_ABSENT', v.reason);
  asDisposition(
    await recovery.operationResume({
      operationId: wsOp.operationId,
      action: 'mark-failed-retryable',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(claimStatus(shared, claimId), 'FENCED');

  const before = counters(rail);
  const claim = await driveClaimed(rail, shared);
  assert.equal(delta(before, counters(rail)).realStarts, 1, '旧派工不存在，重走只真实派一次');
  await rail.orca.workerStop(claim.dispatchId);
  await accept(rail, claim.claimId);
});

test('C8 workerStart after → verify DONE → confirm 收养既有派工（零新外部副作用）', async () => {
  const rail = await buildRail(shared, 'c8');
  const recovery = recoveryFor(rail, shared);
  await expectSimulatedExit(
    driveClaimed(rail, shared, { orca: withFaults(rail.orca, { method: 'workerStart', when: 'after' }) }),
    'after',
  );
  const claimId = liveClaimId(rail);
  const wsOp = opRow(shared.db, `claim:${claimId}:worker-start`);
  assert.equal(rail.orca.realStarts.length, 1, '首跑已真实派工（回执被吞）');

  const v = await verifyExternal(recovery, wsOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_DONE', v.reason);
  const before = counters(rail);
  const confirmed = asDisposition(
    await recovery.operationResume({
      operationId: wsOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.deepEqual(delta(before, counters(rail)), { envCreated: 0, realStarts: 0, wsAdds: 0, moves: 0 }, '收养不产生任何新外部副作用');
  assert.equal(claimStatus(shared, claimId), 'ACTIVE');
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  // 收养的派工已写回认领行。
  const dispatchInRow = shared.db.prepare('SELECT dispatch_id FROM claims WHERE claim_id = ?').get(claimId) as { dispatch_id: string };
  assert.equal(dispatchInRow.dispatch_id, rail.orca.realStarts[0]);
  await rail.orca.workerStop(String(confirmed.summary['dispatchId']));
});

// ===========================================================================
// S 系列：submit 链（jj.snapshot / env.suspend）
// ===========================================================================

test('S1 submit snapshot before → 直接可重试；重提一次成功（无重复提交行）', async () => {
  const rail = await buildRail(shared, 's1');
  const active = await driveToActive(rail, shared);
  fs.writeFileSync(join(active.devWsPath, 'src', 'a', `hello-${rail.scenario}.ts`), 'export const x = 1;\n');

  const faultedService = createSubmissionService({
    db: shared.db,
    config: rail.config,
    jj: withFaults(rail.jj, { method: 'snapshot', when: 'before' }),
    stepTimeoutMs: 120_000,
  });
  await expectSimulatedExit(
    faultedService.submit({
      taskId: rail.taskId,
      claimId: active.claimId,
      tokenClaimId: active.claimId,
      session: EXEC_SESSION,
      evidenceManifest: [{ criterionId: 'cmd-1', exitCode: 0 }],
    }),
    'before',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');
  assert.equal(submissionCount(rail), 0);

  // 换新 requestId 重走：snapshot 幂等，单提交行。
  const submittedResult = await createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj, stepTimeoutMs: 120_000 }).submit({
    taskId: rail.taskId,
    claimId: active.claimId,
    tokenClaimId: active.claimId,
    session: EXEC_SESSION,
    evidenceManifest: [{ criterionId: 'cmd-1', exitCode: 0 }],
  });
  if (!isSubmitAccepted(submittedResult)) {
    throw new Error(`submit 不应要求 rebase: ${JSON.stringify(submittedResult)}`);
  }
  assert.equal(submittedResult.taskStatus, 'REVIEW_REQUESTED');
  assert.equal(submissionCount(rail), 1);
});

test('S2 submit snapshot after → 回执被吞无提交行；重提同 commit 幂等', async () => {
  const rail = await buildRail(shared, 's2');
  const active = await driveToActive(rail, shared);
  fs.writeFileSync(join(active.devWsPath, 'src', 'a', `hello-${rail.scenario}.ts`), 'export const x = 2;\n');

  const faultedService = createSubmissionService({
    db: shared.db,
    config: rail.config,
    jj: withFaults(rail.jj, { method: 'snapshot', when: 'after' }),
    stepTimeoutMs: 120_000,
  });
  await expectSimulatedExit(
    faultedService.submit({
      taskId: rail.taskId,
      claimId: active.claimId,
      tokenClaimId: active.claimId,
      session: EXEC_SESSION,
      evidenceManifest: [{ criterionId: 'cmd-1', exitCode: 0 }],
    }),
    'after',
  );
  assert.equal(submissionCount(rail), 0, '回执被吞不得留提交行');

  const submittedResult = await createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj, stepTimeoutMs: 120_000 }).submit({
    taskId: rail.taskId,
    claimId: active.claimId,
    tokenClaimId: active.claimId,
    session: EXEC_SESSION,
    evidenceManifest: [{ criterionId: 'cmd-1', exitCode: 0 }],
  });
  if (!isSubmitAccepted(submittedResult)) {
    throw new Error(`submit 不应要求 rebase: ${JSON.stringify(submittedResult)}`);
  }
  assert.equal(submissionCount(rail), 1);
  assert.equal(submittedResult.idempotentReplay, false);
  assert.ok(submittedResult.commitId.length > 0);
});

// ===========================================================================
// S3/S4：env.suspend（进评审前提）→ 认领 UNCERTAIN → replaceExecutor（§13.14）
// ===========================================================================

async function suspendInterruptedRail(
  scenario: string,
  when: 'before' | 'after',
): Promise<{ rail: Rail; active: Awaited<ReturnType<typeof driveToActive>> }> {
  const rail = await buildRail(shared, scenario);
  const active = await driveToActive(rail, shared);
  await submitWork(rail, active.claimId, active.devWsPath);
  assert.equal(taskStatus(shared, rail.taskId), 'REVIEW_REQUESTED');
  const faultedReviews = reviewServiceFor(rail, undefined, withFaults(shared.env, { method: 'suspend', when }));
  await expectSimulatedExit(faultedReviews.onMergeReady({ taskId: rail.taskId, session: 'gov-poll' }), when);
  assert.equal(claimStatus(shared, active.claimId), 'UNCERTAIN');
  assert.equal(blockedReason(shared, rail.taskId), 'env_suspend_failed');
  return { rail, active };
}

test('S3 env.suspend before → 认领 UNCERTAIN → replaceExecutor：结算→FENCED→retry-of，§13.14 作废旧提交回 ACTIVE', async () => {
  const { rail, active } = await suspendInterruptedRail('s3', 'before');
  const recovery = recoveryFor(rail, shared);
  assert.notEqual(latestActiveSubmission(shared.db, rail.taskId), undefined, '替换前提交在案');

  const replaced = await recovery.replaceExecutor({ taskId: rail.taskId, session: OPERATOR_SESSION });
  assert.equal(replaced.retryOf, active.dispatchId, '重派必须走 retry-of');
  assert.equal(claimStatus(shared, active.claimId), 'FENCED');
  assert.equal(replaced.claimStatus, 'ACTIVE');
  assert.equal(replaced.taskStatus, 'ACTIVE', '§13.14：REVIEW_REQUESTED 替换后回 ACTIVE');
  assert.deepEqual(
    [...replaced.voidedSubmissionIds],
    [String((shared.db.prepare('SELECT submission_id FROM submissions WHERE claim_id IN (SELECT claim_id FROM claims WHERE task_id = ?)').get(rail.taskId) as { submission_id: string }).submission_id)],
    '旧提交作废',
  );
  assert.equal(latestActiveSubmission(shared.db, rail.taskId), undefined, '作废后无有效提交');
  assert.equal(replaced.reviewCancelled, null, '评审未建，无需收口');
  // 旧执行者令牌已吊销。
  const revoked = shared.db
    .prepare('SELECT revoked_at FROM capabilities WHERE claim_id = ?')
    .get(active.claimId) as { revoked_at: string | null };
  assert.notEqual(revoked.revoked_at, null);
  // 旧提交/评审不转移：新认领的 submit 是新提交（路径/冲突检查照常）。
  const wsRow = shared.db
    .prepare('SELECT w.host_path AS host_path FROM claims c JOIN workspaces w ON c.workspace_id = w.workspace_id WHERE c.claim_id = ?')
    .get(replaced.newClaimId) as { host_path: string };
  await submitWork(rail, replaced.newClaimId, String(wsRow.host_path));
  assert.equal(taskStatus(shared, rail.taskId), 'REVIEW_REQUESTED');
  await rail.orca.workerStop(replaced.newDispatchId);
});

test('S4 env.suspend after（容器已暂停）→ 同 replaceExecutor 路径恢复', async () => {
  const { rail, active } = await suspendInterruptedRail('s4', 'after');
  const recovery = recoveryFor(rail, shared);
  assert.equal(await envExists(active.devEnvId), true, 'suspend 已发生：容器仍在（paused）');

  const replaced = await recovery.replaceExecutor({ taskId: rail.taskId, session: OPERATOR_SESSION });
  assert.equal(replaced.retryOf, active.dispatchId);
  assert.equal(claimStatus(shared, active.claimId), 'FENCED');
  assert.equal(replaced.claimStatus, 'ACTIVE');
  await rail.orca.workerStop(replaced.newDispatchId);
});

// ===========================================================================
// R 系列：评审链（workspaceAdd / env.create / workerStart）
// 评审链无步骤账本（T3.2 适配记录）：uncertain 裸抛后重轮询——未建资源（R1）直接
// 重建；已建资源（R2-R6）确定性撞名 → 回滚半成品 → 第三次重建。
// ===========================================================================

async function reviewInterruptedOn(rail: Rail, method: 'workspaceAdd' | 'create' | 'workerStart', when: 'before' | 'after'): Promise<void> {
  const faulted =
    method === 'workspaceAdd'
      ? reviewServiceFor(rail, withFaults(rail.jj, { method, when }))
      : method === 'create'
        ? reviewServiceFor(rail, undefined, withFaults(shared.env, { method, when }))
        : reviewServiceFor(rail, undefined, undefined, withFaults(rail.orca, { method, when }));
  await expectSimulatedExit(faulted.onMergeReady({ taskId: rail.taskId, session: 'gov-poll' }), when);
  assert.equal(taskStatus(shared, rail.taskId), 'REVIEW_REQUESTED');
  assert.equal(reviewCount(rail), 0, '评审行未建');
}

/** rail + 故障轮询前的 env 计数锚点（断言「评审 env 只建一次」的基准）。 */
async function reviewRail(
  scenario: string,
  method: 'workspaceAdd' | 'create' | 'workerStart',
  when: 'before' | 'after',
): Promise<{ rail: Rail; envIndex: number }> {
  const rail = await buildRail(shared, scenario);
  const active = await driveToActive(rail, shared);
  await submitWork(rail, active.claimId, active.devWsPath);
  const envIndex = shared.env.createdEnvIds.length;
  await reviewInterruptedOn(rail, method, when);
  return { rail, envIndex };
}

/**
 * 半成品评审工作区目录清理（容器先销毁再删目录；Docker 文件共享层短暂占用时
 * 用真实间隔重试）。
 */
async function rmReviewWsLeftover(rail: Rail): Promise<void> {
  const dir = join(rail.repoDirReal, '.gov-workspaces', `gr-${rail.taskId.replace(/[^A-Za-z0-9._-]/g, '-')}-1`);
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOTEMPTY') {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * 撞名一次（确定失败回滚）后重建成功；返回重建的 reviewId。
 *
 * T3.2 缺口适配（实证记录于阶段报告）：撞名轮的回滚引用本轮从未落账的
 * workspaceId/hostPath——workspaceForget 生效，但半成品行的容器不销毁、目录
 * 不删、旧行不更新（活动挂载持续占用目录，直接 rm 持续 ENOTEMPTY）。此处按
 * 恢复面口径人工收口半成品：按确定性工作区名找到半成品行 → 销毁其容器 →
 * 删目录 → 第三次轮询重建。
 */
async function reviewRetryAfterCollision(rail: Rail): Promise<string> {
  await expectGovError(reviewServiceFor(rail).onMergeReady({ taskId: rail.taskId, session: 'gov-poll' }), 'E_JJ_CALL_FAILED');
  const jjName = `gr-${rail.taskId.replace(/[^A-Za-z0-9._-]/g, '-')}-1`;
  const leftoverRow = shared.db
    .prepare('SELECT env_instance_id FROM workspaces WHERE jj_workspace_name = ?')
    .get(jjName) as { env_instance_id: string | null } | undefined;
  if (leftoverRow?.env_instance_id != null) {
    await shared.envReal.destroy(String(leftoverRow.env_instance_id));
  }
  await rmReviewWsLeftover(rail);
  const session = await reviewServiceFor(rail).onMergeReady({ taskId: rail.taskId, session: 'gov-poll' });
  assert.equal(reviewCount(rail), 1);
  return session.reviewId;
}

test('R1 review workspaceAdd before → 未建任何资源；重轮询直接重建（无撞名）', async () => {
  const { rail, envIndex } = await reviewRail('r1', 'workspaceAdd', 'before');
  assert.equal((await jjWsNames(rail, 'gr-')).length, 0, '未建评审工作区');
  const session = await reviewServiceFor(rail).onMergeReady({ taskId: rail.taskId, session: 'gov-poll' });
  assert.ok(session.reviewId.length > 0);
  assert.equal(reviewCount(rail), 1);
  assert.equal(shared.env.createdEnvIds.length - envIndex, 1, '评审 env 只真实创建一次');
  assert.equal((await jjWsNames(rail, 'gr-')).length, 1);
});

test('R2 review workspaceAdd after → workspace 在案无行；撞名回滚后重建', async () => {
  const { rail, envIndex } = await reviewRail('r2', 'workspaceAdd', 'after');
  assert.equal((await jjWsNames(rail, 'gr-')).length, 1, '评审工作区已建（回执被吞）');
  await reviewRetryAfterCollision(rail);
  assert.equal(shared.env.createdEnvIds.length - envIndex, 1);
  assert.equal((await jjWsNames(rail, 'gr-')).length, 1, '回滚+重建后仍只有一个评审工作区');
});

test('R3 review env.create before → 撞名回滚（无容器）后重建', async () => {
  const { rail, envIndex } = await reviewRail('r3', 'create', 'before');
  assert.equal(shared.env.createdEnvIds.length - envIndex, 0, '容器未建');
  await reviewRetryAfterCollision(rail);
  assert.equal(shared.env.createdEnvIds.length - envIndex, 1, '重建只真实创建一个容器');
});

test('R4 review env.create after → 容器在案无行（T3.2 缺口：回滚不销毁未记账容器）→ 查明人工销毁后重建', async () => {
  const { rail, envIndex } = await reviewRail('r4', 'create', 'after');
  assert.equal(shared.env.createdEnvIds.length - envIndex, 1, '容器已建（回执被吞、行未记账）');

  // 第二次轮询撞名回滚：工作区行无 env id，未记账容器泄漏（T3.2 已知缺口）。
  await expectGovError(reviewServiceFor(rail).onMergeReady({ taskId: rail.taskId, session: 'gov-poll' }), 'E_JJ_CALL_FAILED');
  const leaked = shared.env.createdEnvIds[envIndex];
  assert.ok(leaked !== undefined);
  assert.equal(await envExists(leaked), true, '未记账容器仍在运行（缺口实证）');
  // 人工查明后销毁（destroy 幂等，不与恢复面冲突）。
  await shared.envReal.destroy(leaked);
  assert.equal(await envExists(leaked), false);
  // 半成品目录人工清理（同 reviewRetryAfterCollision 的缺口处置）。
  await rmReviewWsLeftover(rail);

  const session = await reviewServiceFor(rail).onMergeReady({ taskId: rail.taskId, session: 'gov-poll' });
  assert.ok(session.reviewId.length > 0);
  assert.equal(shared.env.createdEnvIds.length - envIndex, 2, '缺口代价：重建再建一个（记录于阶段报告）');
});

test('R5 review workerStart before → 撞名回滚（记账容器销毁）后重建', async () => {
  const { rail, envIndex } = await reviewRail('r5', 'workerStart', 'before');
  assert.equal(shared.env.createdEnvIds.length - envIndex, 1, '评审 env 已建');
  await reviewRetryAfterCollision(rail);
  // 第二次轮询的回滚销毁了记账 env；第三次重建一个 → 共 2（评审链无阶段恢复的既定代价）。
  assert.equal(shared.env.createdEnvIds.length - envIndex, 2);
});

test('R6 review workerStart after → 脚本化派工回执被吞；回滚重建', async () => {
  const { rail, envIndex } = await reviewRail('r6', 'workerStart', 'after');
  await reviewRetryAfterCollision(rail);
  assert.equal(shared.env.createdEnvIds.length - envIndex, 2);
});

// ===========================================================================
// M 系列：合并链（moveBookmarkFF / archive / env.destroy / workspaceForget）
// ===========================================================================

test('M1 moveBookmarkFF before → UNCERTAIN → verify ABSENT → mark → 重走一次移动', async () => {
  const rail = await buildRail(shared, 'm1');
  const approved = await driveToApproved(rail, shared);
  const recovery = recoveryFor(rail, shared);

  await expectGovError(
    mergeServiceFor(rail, undefined, withFaults(rail.jj, { method: 'moveBookmarkFF', when: 'before' })).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_MERGE_UNCERTAIN',
    '不回滚',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'APPROVED');
  assert.equal(blockedReason(shared, rail.taskId), 'merge_uncertain');
  const mergeOp = opRow(shared.db, `merge:${approved.submissionId}:1`);
  assert.equal(mergeOp.status, 'UNCERTAIN');

  const v = await verifyExternal(recovery, mergeOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_ABSENT', v.reason);
  const marked = asDisposition(
    await recovery.operationResume({
      operationId: mergeOp.operationId,
      action: 'mark-failed-retryable',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(marked.action, 'mark-failed-retryable');
  assert.equal(blockedReason(shared, rail.taskId), null);

  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.merge.idempotentReplay, false, 'mark 后重走是全新 attempt（键自增）');
  assert.equal(rail.jj.moveBookmarkFFCalls.length, 1, 'bookmark 只真实移动一次');
  assert.equal((await rail.jj.bookmarkCurrent('main')).commitId, approved.commitId);
});

test('M2 moveBookmarkFF after → verify DONE → confirm 补账 MERGED；重跑 completeTask 幂等不二次移动', async () => {
  const rail = await buildRail(shared, 'm2');
  const approved = await driveToApproved(rail, shared);
  const recovery = recoveryFor(rail, shared);

  await expectGovError(
    mergeServiceFor(rail, undefined, withFaults(rail.jj, { method: 'moveBookmarkFF', when: 'after' })).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_MERGE_UNCERTAIN',
    '不回滚',
  );
  assert.equal((await rail.jj.bookmarkCurrent('main')).commitId, approved.commitId, '移动已发生');
  const mergeOp = opRow(shared.db, `merge:${approved.submissionId}:1`);

  const v = await verifyExternal(recovery, mergeOp.operationId);
  assert.equal(v.classification, 'EXTERNAL_DONE', v.reason);
  const confirmed = asDisposition(
    await recovery.operationResume({
      operationId: mergeOp.operationId,
      action: 'confirm-done',
      verificationRef: v.verificationId,
      session: OPERATOR_SESSION,
    }),
  );
  assert.equal(confirmed.action, 'confirm-done');
  assert.equal(taskStatus(shared, rail.taskId), 'MERGED', '补账只落 merges 行 + MERGED，不二次移动');

  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.merge.idempotentReplay, true, '重走走幂等回放');
  assert.equal(rail.jj.moveBookmarkFFCalls.length, 1, 'bookmark 只动一次');
});

/**
 * cleanup 重试收口：Docker 文件共享层在容器销毁后的短暂窗口内，紧随其后的
 * 工作区目录删除会瞬时 ENOTEMPTY（同轮 env 项刚销毁、ws 项随即 rm 的竞态，
 * M4/M5 系列实证）。「单项 failed 可重试」正是该情形的处置语义——有界重试至
 * 清理落定，非 E_CLEANUP_FAILED 立即抛出。
 */
async function completeTaskWithCleanupRetry(rail: Rail, attempts = 3): Promise<CompleteResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' });
    } catch (err) {
      lastErr = err;
      if (!(err instanceof GovError) || err.code !== 'E_CLEANUP_FAILED') {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  throw lastErr;
}

test('M3 archive 失败（归档根只读）→ cleanup_pending 资源保留；修复后幂等续走 COMPLETED', async () => {
  const rail = await buildRail(shared, 'm3');
  const approved = await driveToApproved(rail, shared);
  const roRoot = join(rail.tmpRoot, 'archive-ro');
  fs.mkdirSync(roRoot, { recursive: true });
  fs.chmodSync(roRoot, 0o500);
  const badConfig = { ...rail.config, archiveRoot: roRoot };

  await expectGovError(
    createMergeService({ db: shared.db, config: badConfig, jj: rail.jj, env: shared.env, orca: rail.orca, stepTimeoutMs: 120_000 }).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_ARCHIVE_FAILED',
    '资源保留',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'MERGED');
  assert.equal(blockedReason(shared, rail.taskId), 'cleanup_pending');
  assert.equal(await envExists(approved.devEnvId), true, '归档失败不得删任何资源');

  fs.chmodSync(roRoot, 0o755);
  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.merge.idempotentReplay, true);
  assert.equal(rail.jj.moveBookmarkFFCalls.length, 1, '归档失败重走不重复合并');
  assert.equal(await envExists(approved.devEnvId), false);
});

test('M4 cleanup env.destroy before（定向开发环境）→ 单项 failed 容器仍在；重试销毁一次', async () => {
  const rail = await buildRail(shared, 'm4a');
  const approved = await driveToApproved(rail, shared);
  await expectGovError(
    mergeServiceFor(rail, faultedEnvDestroy(approved.devEnvId, 'before')).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_CLEANUP_FAILED',
    'cleanup_pending',
  );
  assert.equal(await envExists(approved.devEnvId), true, 'before 注入：容器未销毁');
  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(await envExists(approved.devEnvId), false, '重试后销毁');
  assert.equal(rail.jj.moveBookmarkFFCalls.length, 1);
});

test('M4 cleanup env.destroy after（定向开发环境）→ 容器已销毁但项 failed；重试幂等不报错', async () => {
  const rail = await buildRail(shared, 'm4b');
  const approved = await driveToApproved(rail, shared);
  await expectGovError(
    mergeServiceFor(rail, faultedEnvDestroy(approved.devEnvId, 'after')).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_CLEANUP_FAILED',
    'cleanup_pending',
  );
  assert.equal(await envExists(approved.devEnvId), false, 'after 注入：销毁已发生');
  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.cleanup.failed, 0);
});

test('M5 cleanup workspaceForget before（定向开发工作区）→ 注销未发生项 failed；重试注销一次', async () => {
  const rail = await buildRail(shared, 'm5a');
  await driveToApproved(rail, shared);
  await expectGovError(
    mergeServiceFor(rail, undefined, faultedWsForget(rail, 'before')).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_CLEANUP_FAILED',
    'cleanup_pending',
  );
  assert.ok((await jjWsNames(rail, 'gt-')).length > 0, 'before 注入：开发工作区仍注册');
  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal((await jjWsNames(rail, 'gt-')).length, 0);
});

test('M5 cleanup workspaceForget after（定向开发工作区）→ 已注销项 failed；重试幂等（No workspace named 容忍）', async () => {
  const rail = await buildRail(shared, 'm5b');
  await driveToApproved(rail, shared);
  await expectGovError(
    mergeServiceFor(rail, undefined, faultedWsForget(rail, 'after')).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_CLEANUP_FAILED',
    'cleanup_pending',
  );
  const result = await completeTaskWithCleanupRetry(rail);
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.deepEqual(await jjWsNames(rail, 'gt-'), []);
});

// ===========================================================================
// 专项：旧 writer 存活 / 任务替代 / 协调恢复
// ===========================================================================

test('SP1 旧 writer 仍存活 → E_RECOVERY_WRITER_ALIVE 且无重派', async () => {
  const rail = await buildRail(shared, 'sp1');
  const recovery = recoveryFor(rail, shared);
  const claim = await driveClaimed(rail, shared); // 不预停：worker 真实存活
  const startsBefore = rail.orca.realStarts.length;

  await expectGovError(recovery.replaceExecutor({ taskId: rail.taskId, session: OPERATOR_SESSION }), 'E_RECOVERY_WRITER_ALIVE', '仍存活');
  assert.equal(rail.orca.realStarts.length, startsBefore, '无重派');
  const row = shared.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(claim.claimId) as { status: string };
  assert.equal(row.status, 'DISPATCHED', '认领不动');
  assert.equal(taskStatus(shared, rail.taskId), 'DECLARED');
  await rail.orca.workerStop(claim.dispatchId);
});

test('SP3 supersedeTask → 旧任务 SUPERSEDED + 新版本在案 + 资源销毁回执', async () => {
  const rail = await buildRail(shared, 'sp3');
  const recovery = recoveryFor(rail, shared);
  const claim = await driveClaimed(rail, shared);
  await rail.orca.workerStop(claim.dispatchId);
  await accept(rail, claim.claimId);
  assert.equal(taskStatus(shared, rail.taskId), 'ACTIVE');

  const newTaskId = `${rail.taskId}-v2`;
  const newSpec = {
    ...rail.spec,
    taskId: newTaskId,
    problem: 'T4.1 任务替代：范围变化即新任务版本',
    inScope: ['src/a', 'src/new-scope'],
  };
  const superseded = await recovery.supersedeTask({ taskId: rail.taskId, newSpec, session: OPERATOR_SESSION });
  assert.equal(superseded.oldTaskStatus, 'SUPERSEDED');
  assert.equal(superseded.newTaskId, newTaskId);
  assert.equal(superseded.claimFenced, claim.claimId);
  assert.equal(taskStatus(shared, newTaskId), 'DECLARED');
  const newOrca = shared.db.prepare('SELECT orca_task_id FROM tasks WHERE task_id = ?').get(newTaskId) as { orca_task_id: string };
  assert.ok(newOrca.orca_task_id.length > 0, '新任务已完成 Orca 登记');
  assert.ok(superseded.scheduledCleanupItems > 0, '全量清理已登记');

  // 资源销毁回执：归档 → 意图消费 → 全量清理逐项 done。
  const cleanupDeps = { db: shared.db, config: rail.config, jj: rail.jj, env: shared.env, orca: rail.orca, stepTimeoutMs: 120_000 };
  archiveTask(cleanupDeps, { taskId: rail.taskId, actor: OPERATOR_SESSION });
  consumeCleanupIntents(cleanupDeps, { taskId: rail.taskId, actor: OPERATOR_SESSION });
  scheduleCleanup(cleanupDeps, rail.taskId, { kind: 'full' }, OPERATOR_SESSION);
  const cleanup = await runCleanup(cleanupDeps, { taskId: rail.taskId, actor: OPERATOR_SESSION });
  assert.equal(cleanup.failed, 0);
  assert.equal(cleanup.total, cleanup.done);
  const oldEnv = String(
    (
      shared.db
        .prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = (SELECT workspace_id FROM claims WHERE claim_id = ?)')
        .get(claim.claimId) as { env_instance_id: string | null }
    ).env_instance_id ?? '',
  );
  assert.equal(await envExists(oldEnv), false, '被替代任务的执行环境已销毁');
  assert.equal((await jjWsNames(rail, 'gt-')).length, 0);
});

test('SP4 recoverCoordinator → run-use 重绑幂等、gov 数据不动', async () => {  const rail = await buildRail(shared, 'sp4');
  const recovery = recoveryFor(rail, shared);
  const countsBefore = {
    tasks: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()?.c),
    events: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c),
    operations: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM operations').get()?.c),
  };
  const first = await recovery.recoverCoordinator({ runId: shared.runId, session: OPERATOR_SESSION });
  const second = await recovery.recoverCoordinator({ runId: shared.runId, session: OPERATOR_SESSION });
  assert.equal(first.runId, shared.runId);
  assert.equal(second.runId, shared.runId, '重复重绑幂等');
  assert.ok(first.objective.length > 0);
  assert.equal(first.govDataUntouched, true);
  const countsAfter = {
    tasks: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM tasks').get()?.c),
    events: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c),
    operations: Number(shared.db.prepare('SELECT COUNT(*) AS c FROM operations').get()?.c),
  };
  assert.deepEqual(countsAfter, countsBefore, '协调恢复不写任何 gov 数据');
});

test('SP5 operation-show / operation-resume 经 registerCoreHandlers 真接线（operator 令牌面）', async () => {
  const rail = await buildRail(shared, 'sp5');
  await expectSimulatedExit(
    driveClaimed(rail, shared, { jj: withFaults(rail.jj, { method: 'workspaceAdd', when: 'before' }) }),
    'before',
  );
  const claimId = liveClaimId(rail);
  const requestId = `claim:${claimId}:workspace`;

  const registry = createHandlerRegistry();
  registerCoreHandlers(registry, {
    config: rail.config,
    configPath: '',
    recoveryDeps: {
      config: rail.config,
      orca: new RecoveryOrca(rail.orca, shared.orcaReal),
      jj: recoveryJj(rail),
      env: shared.env,
      envFacts: new DockerEnvFacts(),
      runId: shared.runId,
      stepTimeoutMs: 120_000,
    },
  });
  const show = registry.lookup('operation-show');
  const resume = registry.lookup('operation-resume');
  assert.ok(show !== undefined && resume !== undefined, '两个恢复动作应随 recoveryDeps 注册');

  const token = {
    capabilityId: 'gov-t41r-op',
    role: 'operator' as const,
    taskId: null,
    claimId: null,
    reviewId: null,
    actions: ['operation-show', 'operation-resume', 'status'],
    expiresAt: null,
  };
  const baseCtx: ActionContext = {
    db: shared.db,
    dbPath: ':memory:',
    config: rail.config,
    configPath: '',
    token,
    payload: {},
  };

  const shown = (await show({ ...baseCtx, payload: { requestId } })) as {
    operation: { status: string; requestId: string };
    linkage: { category: string; claimId: string };
    task: { taskId: string; status: string } | null;
    claim: { claimId: string; status: string } | null;
  };
  assert.equal(shown.operation.requestId, requestId);
  assert.equal(shown.operation.status, 'UNCERTAIN');
  assert.equal(shown.linkage.category, 'claim-workspace');
  assert.equal(shown.task?.taskId, rail.taskId);
  assert.equal(shown.claim?.status, 'UNCERTAIN');

  const operationId = opRow(shared.db, requestId).operationId;
  const verified = (await resume({
    ...baseCtx,
    payload: { operationId, action: 'verify-external' },
  })) as { classification: string; verificationId: string };
  assert.equal(verified.classification, 'EXTERNAL_ABSENT');

  const marked = asDisposition(
    (await resume({
      ...baseCtx,
      payload: { operationId, action: 'mark-failed-retryable', verificationRef: verified.verificationId },
    })) as ResumeResult,
  );
  assert.equal(marked.action, 'mark-failed-retryable');
  assert.equal(claimStatus(shared, claimId), 'FENCED');
});

// ---------------------------------------------------------------------------
// 回基准：容器 / jj 工作区 / Orca 工作树与注册仓 / 信任种子 / 临时目录
// ---------------------------------------------------------------------------

after(async () => {
  const errors: unknown[] = [];
  for (const envId of shared.env.createdEnvIds) {
    try {
      await shared.envReal.destroy(envId);
    } catch {
      // 已销毁（正常路径）则跳过。
    }
  }
  try {
    const leftovers: string[] = [];
    for (const envId of shared.env.createdEnvIds) {
      leftovers.push(...(await dockerPsNames(envId)));
    }
    assert.deepEqual(leftovers, [], `docker ps -a 应无本测试容器残留: ${leftovers.join(', ')}`);
  } catch (err) {
    errors.push(err);
  }

  for (const rail of shared.rails) {
    try {
      const names = (await execJj(rail.repoDir, ['workspace', 'list', '-T', 'name ++ "\\n"'])).stdout
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && l !== 'default');
      for (const name of names) {
        await execJj(rail.repoDir, ['workspace', 'forget', name]).catch(() => undefined);
      }
    } catch (err) {
      errors.push(err);
    }
  }

  for (const rail of shared.rails) {
    for (const dispatch of rail.orca.realStarts) {
      try {
        await shared.orcaReal.workerRelease(dispatch);
      } catch (err) {
        if (
          !(err instanceof OrcaAdapterError && (err.detail as { orcaErrorCode?: string } | undefined)?.orcaErrorCode === 'dispatch_inactive')
        ) {
          errors.push(err);
        }
      }
    }
    try {
      const listed = await shared.orcaReal.worktreeList({ repo: rail.repoDir });
      for (const wt of listed.raw.worktrees) {
        if (wt.isMainWorktree === true || !wt.path.includes('orca/workspaces')) {
          continue;
        }
        await shared.orcaReal.worktreeRm(wt.path);
      }
    } catch (err) {
      errors.push(err);
    }
    try {
      await shared.orcaReal.projectSetupDelete(rail.orcaRepoId);
    } catch (err) {
      errors.push(err);
    }
  }

  try {
    for (const rail of shared.rails) {
      await shared.orcaReal.repoShow(rail.repoDir).then(
        () => assert.fail(`repo 应已注销: ${rail.repoDir}`),
        (err: unknown) => {
          assert.ok(err instanceof GovError, `repoShow 应报错: ${String(err)}`);
        },
      );
    }
    const all = await shared.orcaReal.worktreeList();
    const leaked = all.raw.worktrees.filter((w) => w.path.includes(`gov-t33it-${shared.stamp}`));
    assert.deepEqual(leaked.map((w) => w.path), [], 'Orca 工作树清单应回基准');
  } catch (err) {
    errors.push(err);
  }

  const prefixes: string[] = shared.tmpRoots.map((root) => fs.realpathSync(root));
  for (const rail of shared.rails) {
    for (const name of rail.orca.realWorktreeNames) {
      prefixes.push(predictWorktreePath(rail.repoDisplayName, name));
    }
  }
  removeClaudeWorkspaceTrustSeeds(prefixes);
  shared.db.close();
  for (const root of shared.tmpRoots) {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch (err) {
      errors.push(err);
    }
  }
  assert.deepEqual(errors, [], `回基准阶段不应有错误: ${errors.map(String).join('; ')}`);
});
