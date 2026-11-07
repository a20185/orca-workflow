/**
 * T3.3 真实生命周期集成测试（fail-loud：Orca / jj / Docker 不可用直接红）。
 *
 * 八场景（简报定死）：
 * ① 正常完成全链：declare→claim→(worker 消失路径)→accept→写文件→submit→
 *    评审真实走 T3.2 服务（评审派工脚本化）→ merge → archive → cleanup →
 *    COMPLETED + 资源零残留；评审资源在结论受理后即销毁（不依赖任务结局）。
 * ② 合并前目标移动（外部前移 bookmark）→ E_JJ_TARGET_MOVED、旧签核失效回
 *    CHANGES_REQUESTED；cancel 后全量清理回执。
 * ③ 合并后恢复前 devWs 被外部改动 → WORKSPACE_DIVERGED 且合并不回滚。
 * ④ 归档失败（archiveRoot 只读）→ E_ARCHIVE_FAILED、cleanup_pending、资源保留；
 *    修复后重跑 completeTask 幂等续走到 COMPLETED。
 * ⑤ 环境删除失败（destroy 注入抛错）→ 单项 failed 可重试、dispatch 项照常。
 * ⑥ 重复 runCleanup 幂等（全 done、零新调用）。
 * ⑦ 失败任务（task fail）→ 全量清理回执。
 * ⑧ worker 自然 done（check 一次 + worker_done --outcome succeeded）后收尾清理。
 *
 * 资源边界：临时 colocated 仓 + 临时 gov 库 + 临时 Run + 一次性容器；结束回基准
 * （docker ps -a / jj workspace list / Orca worktree+repo 清单 / 信任种子）。
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { GovConfig } from '../../../src/config.ts';
import { GovError } from '../../../src/domain/errors.ts';
import { createMergeService } from '../../../src/services/merges.ts';
import {
  archiveTask,
  cleanupItems,
  consumeCleanupIntents,
  runCleanup,
  scheduleCleanup,
  type CleanupServiceDeps,
} from '../../../src/services/cleanup.ts';
import { createSubmissionService } from '../../../src/services/submissions.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import { OrcaAdapterError, predictWorktreePath } from '../../../src/adapters/orca.ts';
import {
  buildRail,
  createSharedContext,
  driveToActive,
  driveToApproved,
  envExists,
  blockedReason,
  claimStatus,
  dockerPsNames,
  execJj,
  expectGovError,
  OPERATOR_SESSION,
  rawCommitId,
  removeClaudeWorkspaceTrustSeeds,
  taskEvents,
  taskStatus,
  type ApprovedState,
  type Rail,
  type SharedContext,
} from './fixture.ts';

const shared: SharedContext = await createSharedContext();

function cleanupDepsFor(rail: Rail): CleanupServiceDeps {
  return {
    db: shared.db,
    config: rail.config,
    jj: rail.jj,
    env: shared.env,
    orca: rail.orca,
    stepTimeoutMs: 120_000,
  };
}

function mergeServiceFor(rail: Rail, config: GovConfig = rail.config) {
  return createMergeService({
    db: shared.db,
    config,
    jj: rail.jj,
    env: shared.env,
    orca: rail.orca,
    stepTimeoutMs: 120_000,
  });
}

/** 评审工作区行事实（env id 等）。 */
function reviewEnvId(reviewWorkspaceId: string): string {
  const row = shared.db.prepare('SELECT env_instance_id FROM workspaces WHERE workspace_id = ?').get(reviewWorkspaceId);
  if (row?.env_instance_id === null || row?.env_instance_id === undefined) {
    throw new Error(`评审工作区缺环境: ${reviewWorkspaceId}`);
  }
  return String(row.env_instance_id);
}

async function jjWorkspaceNames(rail: Rail): Promise<string[]> {
  const { stdout } = await execJj(rail.repoDir, ['workspace', 'list', '-T', 'name ++ "\\n"']);
  return stdout.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
}

// 跨场景锚（node:test 同文件按声明序串行执行）。
const anchors: {
  s1?: { rail: Rail; approved: ApprovedState; reviewEnv: string; reviewWsId: string };
} = {};

test('① 正常完成全链：merge→archive→cleanup→COMPLETED + 资源零残留', async () => {
  const rail = await buildRail(shared, 's1');
  const approved = await driveToApproved(rail, shared);
  const reviewWsId = String(
    shared.db.prepare('SELECT workspace_id FROM reviews WHERE review_id = ?').get(approved.reviewId)?.workspace_id,
  );
  const reviewEnv = reviewEnvId(reviewWsId);

  // 触发点：评审结论受理 → 评审侧资源销毁（不依赖任务结局；认领侧不动）。
  const consumed = consumeCleanupIntents(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(consumed.consumed, 1, '应消费评审结论的清理意图');
  const reviewRun = await runCleanup(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(reviewRun.total, 3, '评审侧应登记 3 项（dispatch/env/workspace）');
  assert.equal(reviewRun.failed, 0);
  assert.equal(await envExists(reviewEnv), false, '评审容器应已销毁');
  assert.equal(await envExists(approved.devEnvId), true, '正常路径开发环境不得被评审清理删除');
  const namesAfterReview = await jjWorkspaceNames(rail);
  assert.ok(namesAfterReview.includes('default') && !namesAfterReview.some((n) => n.startsWith('gr-')), '评审工作区应已注销');

  const result = await mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' });
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.merge.to, approved.commitId);
  assert.equal(result.merge.from, rail.baseCommit);
  assert.equal(result.merge.dispatchSettlement?.alreadySettled, true, 'worker 消失路径的派工结算应幂等 alreadySettled');
  assert.equal(claimStatus(shared, approved.claimId), 'RELEASED', '正常完成后认领应 RELEASED');

  // 合并读回确认证据：operations 行 CONFIRMED + merges 行。
  const mergeOp = shared.db
    .prepare("SELECT status FROM operations WHERE request_id LIKE 'merge:%' AND status = 'CONFIRMED'")
    .get();
  assert.ok(mergeOp !== undefined, '应存在 CONFIRMED 的合并账本行');
  const mergeRow = shared.db.prepare('SELECT expected_target_commit, result_commit FROM merges WHERE submission_id = ?').get(approved.submissionId);
  assert.equal(String(mergeRow?.result_commit), approved.commitId);

  // 归档产物：任务书全文 + 回执快照 + evidence 产物（哈希校验后落盘）。
  assert.equal(result.archive.evidenceCopied, 1);
  const dir = result.archive.dir;
  for (const name of ['task-spec.json', 'db-snapshot.json', 'operations.json', 'archive-manifest.json', 'evidence/art-1__report.md']) {
    assert.ok(fs.existsSync(join(dir, name)), `归档缺文件: ${name}`);
  }
  const spec = JSON.parse(fs.readFileSync(join(dir, 'task-spec.json'), 'utf8')) as { taskId: string };
  assert.equal(spec.taskId, rail.taskId);
  const manifest = JSON.parse(fs.readFileSync(join(dir, 'archive-manifest.json'), 'utf8')) as {
    evidence: Array<{ criterionId: string; status: string }>;
  };
  assert.equal(manifest.evidence.find((e) => e.criterionId === 'art-1')?.status, 'copied');

  // 资源零残留。
  assert.equal(await envExists(approved.devEnvId), false, '开发容器应已销毁');
  assert.deepEqual(await jjWorkspaceNames(rail), ['default'], 'jj 工作区应只剩 default');
  const items = cleanupItems(shared.db, rail.taskId);
  assert.ok(items.every((item) => item.status === 'done'), `清理项应全 done: ${JSON.stringify(items)}`);
  const releases = rail.orca.releaseCalls.filter((r) => r.dispatch === approved.dispatchId);
  assert.equal(releases.length, 1, '执行派工应经 workerRelease 结算释放');
  assert.equal(taskStatus(shared, rail.taskId), 'COMPLETED');

  anchors.s1 = { rail, approved, reviewEnv, reviewWsId };
});

test('⑥ 重复 runCleanup 幂等：全 done、零新外部调用', async () => {
  const { rail } = anchors.s1 ?? {};
  assert.ok(rail !== undefined, '依赖场景 ①');
  const destroyBefore = shared.env.destroyCalls.length;
  const forgetBefore = rail.jj.workspaceForgetCalls.length;
  const stopBefore = rail.orca.stopCalls.length;
  const releaseBefore = rail.orca.releaseCalls.length;

  const rerun = await runCleanup(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(rerun.total, rerun.done);
  assert.equal(rerun.failed, 0);
  assert.equal(rerun.pending, 0);
  assert.equal(shared.env.destroyCalls.length, destroyBefore, '重复清理不得再调 destroy');
  assert.equal(rail.jj.workspaceForgetCalls.length, forgetBefore);
  assert.equal(rail.orca.stopCalls.length, stopBefore);
  assert.equal(rail.orca.releaseCalls.length, releaseBefore);
  assert.equal(taskStatus(shared, rail.taskId), 'COMPLETED', '重复清理不得重开任务');
});

test('② 合并前目标移动：旧签核失效回 CHANGES_REQUESTED；cancel 后全量清理', async () => {
  const rail = await buildRail(shared, 's2');
  const approved = await driveToApproved(rail, shared);

  // 外部前移 bookmark（根工作副本提交一次 + 前移 main）。
  fs.writeFileSync(join(rail.repoDir, 'src', 'a', 'external-move.txt'), 'external\n');
  await execJj(rail.repoDir, ['commit', '-m', 'external target move']);
  const moved = await rawCommitId(rail.repoDir, '@-');
  await execJj(rail.repoDir, ['bookmark', 'move', 'main', '--to', moved]);

  await expectGovError(
    mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_JJ_TARGET_MOVED',
    '旧签核失效',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'CHANGES_REQUESTED');
  const bookmarkNow = (await rail.jj.bookmarkCurrent('main')).commitId;
  assert.equal(bookmarkNow, moved, 'gov 不得移动已被外部前移的目标');

  // cancel → 全量清理（归档先行）。
  await createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj }).cancel({
    taskId: rail.taskId,
    session: OPERATOR_SESSION,
  });
  assert.equal(taskStatus(shared, rail.taskId), 'CANCELLED');
  const archived = archiveTask(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(archived.idempotentReplay, false);
  consumeCleanupIntents(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  scheduleCleanup(cleanupDepsFor(rail), rail.taskId, { kind: 'full' }, 'gov-it');
  const cleanup = await runCleanup(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(cleanup.failed, 0);
  assert.equal(cleanup.total, cleanup.done);
  assert.equal(claimStatus(shared, approved.claimId), 'FENCED', '取消后清理应把认领 FENCED');
  assert.equal(await envExists(approved.devEnvId), false);
  assert.deepEqual(await jjWorkspaceNames(rail), ['default']);
  assert.ok(taskEvents(shared, rail.taskId, 'cleanup_receipt').length > 0, '应有清理回执事件');
});

test('③ 合并后恢复前分叉：WORKSPACE_DIVERGED 且合并不回滚', async () => {
  const rail = await buildRail(shared, 's3');
  const approved = await driveToApproved(rail, shared);

  // 一次性钩子：下一次 devWs 快照前写入外部改动（即合并后恢复的 snapshot 读到分叉）。
  rail.jj.divergeBeforeSnapshotAt = approved.devWsPath;
  await expectGovError(
    mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_WORKSPACE_DIVERGED',
    '不回滚',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'MERGED', '合并已确认，任务停在 MERGED');
  assert.equal(blockedReason(shared, rail.taskId), 'workspace_diverged');
  const bookmarkNow = (await rail.jj.bookmarkCurrent('main')).commitId;
  assert.notEqual(bookmarkNow, rail.baseCommit, '已确认合并不回滚到基线');
  assert.equal(
    shared.db.prepare('SELECT result_commit FROM merges WHERE submission_id = ?').get(approved.submissionId)?.result_commit,
    approved.commitId,
    '合并行保留（版本分叉不自动回滚已确认合并）',
  );
  assert.equal(taskEvents(shared, rail.taskId, 'task_archived').length, 0, '恢复受阻不得继续归档');
  assert.equal(await envExists(approved.devEnvId), true, '资源保留（转人工）');
  const settled = taskEvents(shared, rail.taskId, 'merge_dispatch_settled');
  assert.equal(settled.length, 1, '恢复前应先幂等结算执行派工');
  assert.equal(settled[0]?.['alreadySettled'], true);
});

test('④ 归档失败（archiveRoot 只读）：cleanup_pending、资源保留；修复后幂等续走', async () => {
  const rail = await buildRail(shared, 's4');
  const approved = await driveToApproved(rail, shared);

  const roRoot = join(rail.tmpRoot, 'archive-ro');
  fs.mkdirSync(roRoot, { recursive: true });
  fs.chmodSync(roRoot, 0o500);
  const badConfig: GovConfig = { ...rail.config, archiveRoot: roRoot };

  await expectGovError(
    mergeServiceFor(rail, badConfig).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_ARCHIVE_FAILED',
    '资源保留',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'MERGED', '合并已确认');
  assert.equal(blockedReason(shared, rail.taskId), 'cleanup_pending');
  assert.equal(await envExists(approved.devEnvId), true, '归档失败不得删任何资源');
  const reviewWsId = String(
    shared.db.prepare('SELECT workspace_id FROM reviews WHERE review_id = ?').get(approved.reviewId)?.workspace_id,
  );
  assert.equal(await envExists(reviewEnvId(reviewWsId)), true, '评审资源同样保留');
  assert.ok((await jjWorkspaceNames(rail)).length > 1, '工作区保留');
  assert.equal(rail.orca.releaseCalls.length, 0, '未确认完成不得释放派工');

  fs.chmodSync(roRoot, 0o755);
  const result = await mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' });
  assert.equal(result.taskStatus, 'COMPLETED');
  assert.equal(result.merge.idempotentReplay, true, '重入 confirmMerge 走回放路径');
  assert.equal(result.archive.idempotentReplay, false, '修复后归档应真实执行');
  assert.equal(await envExists(approved.devEnvId), false);
  assert.deepEqual(await jjWorkspaceNames(rail), ['default']);
  assert.equal(blockedReason(shared, rail.taskId), null);
});

test('⑤ 环境删除失败注入：单项 failed 可重试、dispatch 项照常', async () => {
  const rail = await buildRail(shared, 's5');
  const approved = await driveToApproved(rail, shared);

  shared.env.failDestroyFor.add(approved.devEnvId);
  await expectGovError(
    mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' }),
    'E_CLEANUP_FAILED',
    'cleanup_pending',
  );
  assert.equal(taskStatus(shared, rail.taskId), 'MERGED');
  assert.equal(blockedReason(shared, rail.taskId), 'cleanup_pending');

  const items = cleanupItems(shared.db, rail.taskId);
  const failedEnv = items.find((item) => item.kind === 'env' && item.refId === approved.devEnvId);
  assert.ok(failedEnv !== undefined && failedEnv.status === 'failed', '开发环境项应 failed');
  assert.match(failedEnv?.lastError ?? '', /注入/);
  assert.ok(
    items.filter((item) => item.kind === 'dispatch' || item.kind === 'terminal').every((item) => item.status === 'done'),
    'dispatch/terminal 项应照常完成',
  );
  assert.ok(
    items.filter((item) => item.kind === 'workspace').every((item) => item.status === 'done'),
    '单项失败不阻塞其他项（workspace 项应完成）',
  );
  assert.ok(rail.orca.releaseCalls.some((r) => r.dispatch === approved.dispatchId), 'dispatch 项应已释放');
  assert.equal(await envExists(approved.devEnvId), true, '失败项保留待重试');

  shared.env.failDestroyFor.delete(approved.devEnvId);
  const retried = await mergeServiceFor(rail).completeTask({ taskId: rail.taskId, session: 'gov-it' });
  assert.equal(retried.taskStatus, 'COMPLETED');
  assert.equal(await envExists(approved.devEnvId), false, '重试后销毁');
  assert.ok(cleanupItems(shared.db, rail.taskId).every((item) => item.status === 'done'));
});

test('⑦ 失败任务（task fail）：全量清理回执 + 资源归零', async () => {
  const rail = await buildRail(shared, 's7');
  const active = await driveToActive(rail, shared);

  await createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj }).fail({
    taskId: rail.taskId,
    session: 'gov-it-exec',
    reason: '集成测试业务失败',
  });
  assert.equal(taskStatus(shared, rail.taskId), 'FAILED');

  const archived = archiveTask(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(archived.evidenceCopied, 0, '无评审证据时不得伪造产物');
  const manifest = JSON.parse(fs.readFileSync(join(archived.dir, 'archive-manifest.json'), 'utf8')) as {
    evidence: Array<{ criterionId: string; status: string }>;
  };
  assert.equal(manifest.evidence.find((e) => e.criterionId === 'art-1')?.status, 'missing', '未产出的 artifact 如实记 missing');

  consumeCleanupIntents(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  scheduleCleanup(cleanupDepsFor(rail), rail.taskId, { kind: 'full' }, 'gov-it');
  const cleanup = await runCleanup(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(cleanup.failed, 0);
  assert.equal(cleanup.total, cleanup.done);
  assert.equal(claimStatus(shared, active.claimId), 'FENCED', '失败清理应把认领 FENCED');
  assert.equal(await envExists(active.devEnvId), false);
  assert.deepEqual(await jjWorkspaceNames(rail), ['default']);
  assert.ok(rail.orca.releaseCalls.some((r) => r.dispatch === active.dispatchId));
});

test('⑧ worker 自然 done：worker_done succeeded 后收尾清理（dispatch 已结算直接释放）', async () => {
  const rail = await buildRail(shared, 's8');
  // 不走提前结算：让受控 worker 自然跑完 check + worker_done succeeded。
  await declareTask({ db: shared.db, config: rail.config, orca: rail.orca }, { spec: rail.spec, session: 'gov-it-decl' });
  const claims = createClaimService({
    db: shared.db,
    config: rail.config,
    orca: rail.orca,
    jj: rail.jj,
    env: shared.env,
    trustProvision: async () => ({ cleanup: async () => {} }),
    stepTimeoutMs: 120_000,
  });
  const claim = await claims.claim('gov-it-coord', { taskId: rail.taskId });
  const ws = shared.db
    .prepare('SELECT host_path, env_instance_id FROM workspaces WHERE workspace_id = ?')
    .get(claim.workspace.workspaceId) as { host_path: string; env_instance_id: string };
  await claims.accept({
    taskId: rail.taskId,
    claimId: claim.claimId,
    tokenClaimId: claim.claimId,
    session: 'gov-it-exec',
  });

  // 等待自然结束：先轮询 workerShow（不依赖 Run 绑定，避免与其他集成文件争用
  // 协调者终端的 Run 绑定），再对账 worker_done 消息。实测 worker.state 时间线：
  // ready（工作中，dispatch.status=dispatched）→ succeeded（自然完成）。
  const ACTIVE_WORKER_STATES = new Set(['ready', 'running', 'pending', 'starting']);
  const settleDeadline = Date.now() + 300_000;
  let workerState = '';
  let owningRun = '';
  for (;;) {
    const shown = await shared.orcaReal.workerShow(claim.dispatchId);
    workerState = shown.raw.worker.state;
    owningRun = String((shown.raw.dispatch as { runId?: unknown }).runId ?? '');
    if (!ACTIVE_WORKER_STATES.has(workerState)) {
      break;
    }
    if (Date.now() > settleDeadline) {
      throw new Error(`等待 worker 自然结束超时(state=${workerState}): ${claim.dispatchId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  assert.equal(workerState, 'succeeded', `worker 应自然结束于 succeeded: ${workerState}`);
  assert.match(owningRun, /^run_/, 'worker-show 应携带派工归属 Run');

  // worker_done 消息对账：消息落在派工归属 Run 的收件箱；并发集成文件可能已把
  // 共享终端重绑到别的 Run（consumer_fenced），先 run-use 绑定归属 Run 再查。
  await shared.orcaReal.runUse(owningRun);
  let donePayload: string | null = null;
  const messageDeadline = Date.now() + 120_000;
  while (donePayload === null) {
    const waited = await shared.orcaReal.checkRun({
      runId: owningRun,
      wait: true,
      types: ['worker_done', 'escalation', 'question'],
      timeoutMs: Math.min(60_000, Math.max(1_000, messageDeadline - Date.now())),
    });
    const hit = waited.raw.messages.find(
      (m) => m.type === 'worker_done' && (m.payload ?? '').includes(claim.dispatchId),
    );
    if (hit !== undefined) {
      donePayload = String(hit.payload ?? '');
      break;
    }
    if (waited.raw.deliveryId !== null) {
      await shared.orcaReal.checkRun({ runId: owningRun, ackDeliveryId: String(waited.raw.deliveryId) });
    }
    if (Date.now() > messageDeadline) {
      throw new Error(`对账 worker_done 消息超时: ${claim.dispatchId}`);
    }
  }
  assert.match(donePayload, /"outcome":"succeeded"/, 'worker_done 应为 succeeded');

  // 收尾：cancel → 归档 → 全量清理；dispatch 项 stop 应 alreadySettled（自然结算）。
  await createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj }).cancel({
    taskId: rail.taskId,
    session: OPERATOR_SESSION,
  });
  archiveTask(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  consumeCleanupIntents(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  scheduleCleanup(cleanupDepsFor(rail), rail.taskId, { kind: 'full' }, 'gov-it');
  const cleanup = await runCleanup(cleanupDepsFor(rail), { taskId: rail.taskId, actor: 'gov-it' });
  assert.equal(cleanup.failed, 0);
  const firstStop = rail.orca.stopCalls.find((s) => s.dispatch === claim.dispatchId);
  assert.equal(firstStop?.alreadySettled, true, '自然结算后清理的 stop 应 alreadySettled');
  assert.ok(rail.orca.releaseCalls.some((r) => r.dispatch === claim.dispatchId));
  assert.equal(claimStatus(shared, claim.claimId), 'FENCED');
  assert.equal(await envExists(String(ws.env_instance_id)), false);
  assert.deepEqual(await jjWorkspaceNames(rail), ['default']);
});

// ---------------------------------------------------------------------------
// 回基准：容器 / jj 工作区 / Orca 工作树与注册仓 / 信任种子 / 临时目录
// ---------------------------------------------------------------------------

after(async () => {
  const errors: unknown[] = [];
  // 1. 容器安全网：销毁本测试全部 env（幂等），断言 docker ps -a 无残留。
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

  // 2. jj 工作区安全网：注销仍登记的 gt-*/gr-* 工作区。
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

  // 3. Orca：释放真实派工、删自建工作树、注销注册仓。
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

  // 4. 基准断言：repo 已注销、全局工作树无本测试残留。
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

  // 5. 信任种子与临时目录（含只读归档根的权限恢复）。
  const prefixes: string[] = shared.tmpRoots.map((root) => fs.realpathSync(root));
  for (const rail of shared.rails) {
    for (const name of rail.orca.realWorktreeNames) {
      prefixes.push(predictWorktreePath(rail.repoDisplayName, name));
    }
    try {
      fs.chmodSync(join(rail.tmpRoot, 'archive-ro'), 0o755);
    } catch {
      // 目录不存在（未走到该分支）时忽略。
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
