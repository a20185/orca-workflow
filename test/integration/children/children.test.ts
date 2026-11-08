/**
 * T4.2 父子任务集成测试（fail-loud：Orca / jj / Docker 不可用直接红）。
 *
 * 场景对齐验证门（简报定死；每场景独立 rail，结束回基准）：
 * ① 拆分全链：父 ACTIVE → 快照锁版 → WAITING_CHILD + 父环境暂停 → 子声明/认领
 *    /接受/提交/评审真实走 → completeChildTask（不动顶层 bookmark，记 pending
 *    快进，子归档清理 COMPLETED）→ resumeParent（父版本快进 + 环境恢复 + 恢复
 *    消息 + split 操作 CONFIRMED，原 requestId 查询即得）＋拆分期重复拆分拒。
 * ② 重复 resumeParent 以 parentRevision 幂等（外键计数与 commitId 不变）。
 * ③ 父环境暂停失败 → 不建子任务、认领 UNCERTAIN、split FAILED；重试续跑成功，
 *    子失败收口 → 父恢复不快进（terminated）。
 * ④ 等待期父 replaceExecutor / supersedeTask 被拒（T4.1 接口门）。
 * ⑤ 子路径越界拒（E_CHILD_SCOPE_INVALID）＋ 子基线与父锁定版本不符拒
 *    （E_PARENT_DIVERGED）——父任务不动。
 * ⑥ 父工作区被外部改动 → E_WORKSPACE_DIVERGED 不覆盖、转人工。
 * ⑦ 子任务退回（changes_requested）→ 父仍等待；修正重提 → 合入快进。
 * ⑧ 三层深度限制（第 4 层拆分拒）。
 */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { GovError } from '../../../src/domain/errors.ts';
import { OrcaAdapterError, predictWorktreePath } from '../../../src/adapters/orca.ts';
import { createRecoveryService } from '../../../src/services/recovery.ts';
import { createSubmissionService } from '../../../src/services/submissions.ts';
import { archiveTask, cleanupItems, consumeCleanupIntents, runCleanup, scheduleCleanup, type CleanupServiceDeps } from '../../../src/services/cleanup.ts';
import { RecoveryOrca } from '../recovery/fixture.ts';
import {
  buildChildrenRail,
  childRound,
  childSpecFor,
  childrenJj,
  childrenServiceFor,
  claimStatusOf,
  createChildrenSharedContext,
  dockerPaused,
  driveChildActive,
  driveParentActive,
  envExists,
  EXEC_SESSION,
  expectGovErrorLike,
  OPERATOR_SESSION,
  blockedReasonOf,
  opReceiptOf,
  opStatusOf,
  rawCommitId,
  taskEvents,
  taskStatusOf,
  type ChildrenRail,
  type ChildrenSharedContext,
} from './fixture.ts';
import { dockerPsNames, execJj, removeClaudeWorkspaceTrustSeeds } from '../lifecycle/fixture.ts';

const shared: ChildrenSharedContext = await createChildrenSharedContext();

function cleanupDepsFor(rail: ChildrenRail): CleanupServiceDeps {
  return {
    db: shared.db,
    config: rail.config,
    jj: rail.jj,
    env: shared.env,
    orca: rail.orca,
    stepTimeoutMs: 120_000,
  };
}

/** 子任务失败收口（编排面：fail → 归档 → 意图消费 → 全量清理）。 */
async function terminateChild(rail: ChildrenRail, childTaskId: string): Promise<void> {
  const submissions = createSubmissionService({ db: shared.db, config: rail.config, jj: rail.jj, stepTimeoutMs: 120_000 });
  await submissions.fail({ taskId: childTaskId, session: EXEC_SESSION, reason: 'T4.2 集成测试：子任务失败收口' });
  archiveTask(cleanupDepsFor(rail), { taskId: childTaskId, actor: 'gov-it' });
  consumeCleanupIntents(cleanupDepsFor(rail), { taskId: childTaskId, actor: 'gov-it' });
  scheduleCleanup(cleanupDepsFor(rail), childTaskId, { kind: 'full' }, 'gov-it');
  const cleanup = await runCleanup(cleanupDepsFor(rail), { taskId: childTaskId, actor: 'gov-it' });
  assert.equal(cleanup.failed, 0, `子任务失败清理应全绿: ${JSON.stringify(cleanup.items)}`);
}

test('① 拆分全链：父版本锁定→子完成→父快进恢复；原 requestId 返回结果', async () => {
  const rail = await buildChildrenRail(shared, 'ch1');
  const children = childrenServiceFor(rail, shared);
  // 活派工：恢复消息送达断言需要存活的 dispatch 邮箱（Orca 对已结算派工拒发）。
  const parent = await driveParentActive(rail, shared, { keepDispatchAlive: true });

  // 父未提交 WIP：锁定版本应包含它（快进后仍在父工作副本中）。
  fs.writeFileSync(join(parent.parentWsPath, 'src', 'a', 'parent-wip-ch1.ts'), 'export const wip = true;\n');
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;

  const split = await children.taskSplit({
    taskId: rail.parentTaskId,
    childSpec: childSpecFor({ scenario: 'ch1', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision }),
    session: EXEC_SESSION,
  });
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD');
  assert.equal(split.parentRevision, parentRevision);
  assert.equal(claimStatusOf(shared, parent.claimId), 'ACTIVE', '父认领保持 ACTIVE（阻塞在任务面）');
  assert.equal(await dockerPaused(parent.parentEnvId), true, '拆分即暂停父环境');
  assert.equal(taskStatusOf(shared, split.childTaskId), 'DECLARED', '子任务声明待接受');
  assert.equal(
    shared.db.prepare('SELECT parent_task_id FROM tasks WHERE task_id = ?').get(split.childTaskId)?.parent_task_id,
    rail.parentTaskId,
  );
  assert.equal(opStatusOf(shared, split.splitRequestId), 'IN_FLIGHT', 'split 操作应保持 IN_FLIGHT');
  assert.equal(
    (await rail.jj.bookmarkCurrent('main')).commitId,
    rail.baseCommit,
    '拆分不得动顶层 bookmark',
  );

  // 单阻塞：等待期重复拆分（另一子任务书）→ E_CHILD_EXISTS。
  await expectGovErrorLike(
    children.taskSplit({
      taskId: rail.parentTaskId,
      childSpec: childSpecFor({ scenario: 'ch1', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision, gen: 'c2' }),
      session: EXEC_SESSION,
    }),
    'E_CHILD_EXISTS',
  );

  // 子任务全链（接受→写文件→submit→评审真实走→approved）。
  const childWs = await driveChildActive(rail, shared, split);
  const round = await childRound(
    rail,
    shared,
    { taskId: split.childTaskId, claimId: split.childClaimId },
    childWs.childWsPath,
    'ch1',
    'approved',
  );
  assert.equal(round.taskStatus, 'APPROVED');

  const completed = await children.completeChildTask({ childTaskId: split.childTaskId, session: 'gov-it' });
  assert.equal(completed.taskStatus, 'COMPLETED');
  assert.equal(completed.childCommitId, round.commitId);
  assert.equal(completed.parentRevision, parentRevision);
  assert.ok(completed.cleanup.total > 0 && completed.cleanup.failed === 0 && completed.cleanup.pending === 0, '子任务清理回执应全 done');
  assert.ok(cleanupItems(shared.db, split.childTaskId).every((item) => item.status === 'done'), '子任务清理项全 done');
  assert.equal(claimStatusOf(shared, split.childClaimId), 'RELEASED', '子认领正常收尾 RELEASED');
  assert.equal(await envExists(childWs.childEnvId), false, '子容器应销毁');
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD', '子完成不等同父恢复');
  assert.equal(await dockerPaused(parent.parentEnvId), true, '恢复前父环境保持暂停');
  assert.ok(taskEvents(shared, rail.parentTaskId, 'child_advance_pending').length === 1, '父任务应记录待应用快进');
  assert.equal(
    (await rail.jj.bookmarkCurrent('main')).commitId,
    rail.baseCommit,
    '子任务确认合入不动顶层 bookmark',
  );

  const resumed = await children.resumeParent({ childTaskId: split.childTaskId, session: 'gov-it' });
  assert.equal(resumed.outcome, 'merged');
  if (resumed.outcome !== 'merged') {
    throw new Error('unreachable');
  }
  assert.equal(resumed.messageSent, true, '活派工下恢复消息应送达');
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'ACTIVE');
  assert.equal(resumed.childCommitId, round.commitId);
  assert.equal(await rawCommitId(parent.parentWsPath, '@'), round.commitId, '父工作副本应快进到子提交');
  // 父 WIP 保留（锁定版本在子提交祖先链内）且子改动可见。
  assert.ok(fs.existsSync(join(parent.parentWsPath, 'src', 'a', 'parent-wip-ch1.ts')), '父 WIP 不得丢失');
  assert.ok(fs.existsSync(join(parent.parentWsPath, 'src', 'a', 'child-ch1.ts')), '子改动应进入父工作副本');
  assert.equal(await dockerPaused(parent.parentEnvId), false, '恢复即解除暂停');
  assert.equal(claimStatusOf(shared, parent.claimId), 'ACTIVE');
  assert.equal(shared.env.resumeCalls.filter((id) => id === parent.parentEnvId).length, 1, '父环境恰恢复一次');
  assert.equal(rail.sentMessages.length, 1, '应恰发一条恢复消息');
  assert.equal(rail.sentMessages[0]?.dispatch, parent.dispatchId);
  assert.ok(rail.sentMessages[0]?.body.includes(split.childTaskId), '消息含子任务摘要');
  assert.ok(rail.sentMessages[0]?.body.includes('返回父任务继续处理'));

  // 原 requestId 查询即得（split 操作 CONFIRMED + 回执携带恢复结果）。
  assert.equal(opStatusOf(shared, split.splitRequestId), 'CONFIRMED');
  const receipt = opReceiptOf(shared, split.splitRequestId);
  const result = (receipt?.['body'] as { result?: { advancedTo?: string; outcome?: string } } | undefined)?.result;
  assert.equal(result?.outcome, 'merged');
  assert.equal(result?.advancedTo, round.commitId);
  assert.ok(taskEvents(shared, rail.parentTaskId, 'parent_resumed').length === 1, '恢复事实以事件留档');
});

test('② 重复 resumeParent 幂等：零新外部动作、commitId 不变', async () => {
  const rail = shared.rails.find((r) => r.scenario === 'ch1');
  assert.ok(rail !== undefined, '依赖场景 ①');
  const children = childrenServiceFor(rail, shared);
  const claimId = String(shared.db.prepare('SELECT current_claim_id FROM tasks WHERE task_id = ?').get(rail.parentTaskId)?.current_claim_id);
  const parentWsPath = String(
    shared.db
      .prepare(
        'SELECT w.host_path FROM claims c JOIN workspaces w ON c.workspace_id = w.workspace_id WHERE c.claim_id = ?',
      )
      .get(claimId)?.host_path,
  );
  const beforeCommit = await rawCommitId(parentWsPath, '@');
  const resumeCountBefore = shared.env.resumeCalls.length;
  const messagesBefore = rail.sentMessages.length;
  const childTaskId = String(shared.db.prepare('SELECT task_id FROM tasks WHERE parent_task_id = ?').get(rail.parentTaskId)?.task_id);

  const replay = await children.resumeParent({ childTaskId, session: 'gov-it' });
  assert.equal(replay.outcome, 'merged');
  assert.equal(replay.idempotentReplay, true, '重复恢复应回放而非重做');
  assert.equal(await rawCommitId(parentWsPath, '@'), beforeCommit, '父工作副本不得再次移动');
  assert.equal(shared.env.resumeCalls.length, resumeCountBefore, '不得再次恢复环境');
  assert.equal(rail.sentMessages.length, messagesBefore, '不得重发恢复消息');
  assert.equal(taskEvents(shared, rail.parentTaskId, 'parent_resumed').length, 1, '事件表去重');
});

test('③ 父环境暂停失败：不建子任务、认领 UNCERTAIN、split FAILED；重试续跑后子失败收口不快进', async () => {
  const rail = await buildChildrenRail(shared, 'ch2');
  const children = childrenServiceFor(rail, shared);
  // 默认 worker 消失路径（已结算派工）：本场景顺带实证恢复消息的尽力而为面
  //（Orca 对已结算派工拒发 dispatch_inactive，① 的活派工覆盖送达面）。
  const parent = await driveParentActive(rail, shared);
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;
  const spec = childSpecFor({ scenario: 'ch2', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision });

  shared.env.failSuspendFor.add(parent.parentEnvId);
  await expectGovErrorLike(
    children.taskSplit({ taskId: rail.parentTaskId, childSpec: spec, session: EXEC_SESSION }),
    'E_ENV_LIFECYCLE_FAILED',
  );
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD', '迁移已发生（锁定持久）');
  assert.equal(claimStatusOf(shared, parent.claimId), 'UNCERTAIN');
  assert.equal(blockedReasonOf(shared, rail.parentTaskId), 'env_suspend_failed');
  assert.equal(opStatusOf(shared, 'split:gt-t42-ch2-p:1'), 'FAILED');
  assert.equal(
    shared.db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE parent_task_id = ?').get(rail.parentTaskId)?.c,
    0,
    '暂停失败不得建子任务',
  );
  assert.equal(rail.orca.taskCreateCalls.length, 1, '不得为子任务登记 Orca 任务（仅父任务一次）');
  assert.equal(await dockerPaused(parent.parentEnvId), false, '暂停失败容器不得处于 paused');

  // 重试续跑：同任务书、无存活子认领 → 补建子任务。
  shared.env.failSuspendFor.delete(parent.parentEnvId);
  const split = await children.taskSplit({ taskId: rail.parentTaskId, childSpec: spec, session: EXEC_SESSION });
  assert.equal(split.retryContinuation, true);
  assert.equal(claimStatusOf(shared, parent.claimId), 'ACTIVE', '续跑成功后父认领恢复 ACTIVE');
  assert.equal(blockedReasonOf(shared, rail.parentTaskId), null);
  assert.equal(await dockerPaused(parent.parentEnvId), true, '续跑完成暂停');
  assert.equal(opStatusOf(shared, 'split:gt-t42-ch2-p:2'), 'IN_FLIGHT');

  // 子任务失败收口 → 父恢复不快进。
  const childWs = await driveChildActive(rail, shared, split);
  const beforeCommit = await rawCommitId(parent.parentWsPath, '@');
  await terminateChild(rail, split.childTaskId);
  assert.equal(taskStatusOf(shared, split.childTaskId), 'FAILED');
  assert.equal(claimStatusOf(shared, split.childClaimId), 'FENCED', '失败清理把子认领 FENCED');
  assert.equal(await envExists(childWs.childEnvId), false);

  const resumed = await children.resumeParent({ childTaskId: split.childTaskId, session: 'gov-it' });
  assert.equal(resumed.outcome, 'terminated');
  assert.equal(resumed.messageSent, false, '已结算派工的邮箱不可达：消息尽力而为跳过');
  assert.ok(taskEvents(shared, rail.parentTaskId, 'parent_resume_message_failed').length === 1, '消息失败应留审计事件');
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'ACTIVE');
  assert.equal(await rawCommitId(parent.parentWsPath, '@'), beforeCommit, '子失败恢复不得快进父版本');
  assert.equal(await dockerPaused(parent.parentEnvId), false);
  assert.equal(opStatusOf(shared, 'split:gt-t42-ch2-p:2'), 'CONFIRMED', 'terminated 也终态化 split 操作');
  const receipt = opReceiptOf(shared, 'split:gt-t42-ch2-p:2');
  const result = (receipt?.['body'] as { result?: { outcome?: string; messageSent?: boolean } } | undefined)?.result;
  assert.equal(result?.outcome, 'terminated');
  assert.equal(result?.messageSent, false);
});

test('④ 等待期父 replaceExecutor / supersedeTask 被拒（T4.1 接口门）', async () => {
  const rail = await buildChildrenRail(shared, 'ch3');
  const children = childrenServiceFor(rail, shared);
  const parent = await driveParentActive(rail, shared);
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;
  const split = await children.taskSplit({
    taskId: rail.parentTaskId,
    childSpec: childSpecFor({ scenario: 'ch3', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision }),
    session: EXEC_SESSION,
  });

  const recovery = createRecoveryService({
    db: shared.db,
    config: rail.config,
    orca: new RecoveryOrca(rail.orca, shared.orcaReal),
    jj: childrenJj(rail),
    env: shared.env,
    runId: shared.runId,
    stepTimeoutMs: 120_000,
  });
  await expectGovErrorLike(recovery.replaceExecutor({ taskId: rail.parentTaskId, session: 'gov-it-op' }), 'E_RECOVERY_STATE_INVALID', '不可替换');
  await expectGovErrorLike(
    recovery.supersedeTask({
      taskId: rail.parentTaskId,
      newSpec: { ...childSpecFor({ scenario: 'ch3', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision }), taskId: 'gt-t42-ch3-other' },
      session: 'gov-it-op',
    }),
    'E_RECOVERY_STATE_INVALID',
    'WAITING_CHILD',
  );
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD', '拒绝不得改变等待状态');
  assert.equal(split.childTaskId.length > 0, true);
});

test('⑤ 子路径越界与子基线不符均拒；父任务不动', async () => {
  const rail = await buildChildrenRail(shared, 'ch4');
  const children = childrenServiceFor(rail, shared);
  const parent = await driveParentActive(rail, shared);
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;

  await expectGovErrorLike(
    children.taskSplit({
      taskId: rail.parentTaskId,
      childSpec: childSpecFor({ scenario: 'ch4', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision, ownedPaths: ['src/b'] }),
      session: EXEC_SESSION,
    }),
    'E_CHILD_SCOPE_INVALID',
    'src/b',
  );
  await expectGovErrorLike(
    children.taskSplit({
      taskId: rail.parentTaskId,
      childSpec: childSpecFor({ scenario: 'ch4', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision: rail.baseCommit }),
      session: EXEC_SESSION,
    }),
    'E_PARENT_DIVERGED',
    '子任务基线',
  );
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'ACTIVE', '校验失败父任务不动');
  assert.equal(
    shared.db.prepare('SELECT COUNT(*) AS c FROM operations WHERE request_id LIKE ?').get(`split:${rail.parentTaskId}:%`)?.c,
    0,
    '不得开拆分账本',
  );
  assert.equal(await dockerPaused(parent.parentEnvId), false, '不得暂停父环境');
});

test('⑥ 父工作区被外部改动：E_WORKSPACE_DIVERGED 不覆盖、资源保留转人工', async () => {
  const rail = await buildChildrenRail(shared, 'ch5');
  const children = childrenServiceFor(rail, shared);
  const parent = await driveParentActive(rail, shared);
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;
  const split = await children.taskSplit({
    taskId: rail.parentTaskId,
    childSpec: childSpecFor({ scenario: 'ch5', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision }),
    session: EXEC_SESSION,
  });
  const childWs = await driveChildActive(rail, shared, split);
  const round = await childRound(
    rail,
    shared,
    { taskId: split.childTaskId, claimId: split.childClaimId },
    childWs.childWsPath,
    'ch5',
    'approved',
  );
  await children.completeChildTask({ childTaskId: split.childTaskId, session: 'gov-it' });

  // 外部改动注入：父等待期间宿主侧直接写入（未经 gov）。
  fs.writeFileSync(join(parent.parentWsPath, 'src', 'a', 'stray-resume.txt'), 'external edit while waiting\n');
  await expectGovErrorLike(
    children.resumeParent({ childTaskId: split.childTaskId, session: 'gov-it' }),
    'E_WORKSPACE_DIVERGED',
    '停止覆盖',
  );
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD', '分叉不得推进父状态');
  assert.equal(blockedReasonOf(shared, rail.parentTaskId), 'parent_workspace_diverged');
  assert.equal(await dockerPaused(parent.parentEnvId), true, '环境保持暂停（转人工）');
  assert.ok(fs.existsSync(join(parent.parentWsPath, 'src', 'a', 'stray-resume.txt')), '外部改动不得被覆盖删除');
  const nowAt = await rawCommitId(parent.parentWsPath, '@');
  assert.notEqual(nowAt, round.commitId, '父工作副本不得被快进覆盖');
  assert.notEqual(nowAt, parentRevision);
  assert.equal(rail.sentMessages.length, 0, '不得发恢复消息');
  assert.equal(opStatusOf(shared, split.splitRequestId), 'IN_FLIGHT', 'split 操作保持未决');
  assert.equal(taskEvents(shared, rail.parentTaskId, 'parent_resumed').length, 0);
});

test('⑦ 子任务退回：父仍等待；修正重提后合入快进', async () => {
  const rail = await buildChildrenRail(shared, 'ch7');
  const children = childrenServiceFor(rail, shared);
  const parent = await driveParentActive(rail, shared);
  const parentRevision = (await rail.jj.snapshot(parent.parentWsPath)).commitId;
  const split = await children.taskSplit({
    taskId: rail.parentTaskId,
    childSpec: childSpecFor({ scenario: 'ch7', repoId: rail.repoId, parentTaskId: rail.parentTaskId, parentRevision }),
    session: EXEC_SESSION,
  });
  const childWs = await driveChildActive(rail, shared, split);

  const rejected = await childRound(
    rail,
    shared,
    { taskId: split.childTaskId, claimId: split.childClaimId },
    childWs.childWsPath,
    'ch7-draft',
    'changes_requested',
  );
  assert.equal(rejected.taskStatus, 'CHANGES_REQUESTED', '子任务应被退回');

  const waiting = await children.resumeParent({ childTaskId: split.childTaskId, session: 'gov-it' });
  assert.equal(waiting.outcome, 'waiting', '退回不是终态：父继续等待');
  assert.equal(taskStatusOf(shared, rail.parentTaskId), 'WAITING_CHILD');
  assert.equal(await dockerPaused(parent.parentEnvId), true, '等待期父环境保持暂停');

  const fixed = await childRound(
    rail,
    shared,
    { taskId: split.childTaskId, claimId: split.childClaimId },
    childWs.childWsPath,
    'ch7-fix',
    'approved',
  );
  assert.equal(fixed.taskStatus, 'APPROVED');
  await children.completeChildTask({ childTaskId: split.childTaskId, session: 'gov-it' });
  const resumed = await children.resumeParent({ childTaskId: split.childTaskId, session: 'gov-it' });
  assert.equal(resumed.outcome, 'merged');
  assert.equal(await rawCommitId(parent.parentWsPath, '@'), fixed.commitId, '父快进到修正版子提交');
  assert.ok(fs.existsSync(join(parent.parentWsPath, 'src', 'a', 'child-ch7-fix.ts')), '子修正应可见');
});

test('⑧ 三层深度限制：第 4 层拆分 E_CHILD_DEPTH_EXCEEDED', async () => {
  const rail = await buildChildrenRail(shared, 'ch8');
  const children = childrenServiceFor(rail, shared);
  await driveParentActive(rail, shared);

  // 逐层拆分：root(深0) → c1(深1) → c2(深2) → c3(深3)；c3 的拆分即第 4 层，拒。
  let currentTaskId = rail.parentTaskId;
  let currentWsPath = String(
    shared.db
      .prepare(
        'SELECT w.host_path FROM claims c JOIN workspaces w ON c.workspace_id = w.workspace_id WHERE c.task_id = ? ORDER BY c.rowid DESC LIMIT 1',
      )
      .get(currentTaskId)?.host_path,
  );
  for (const gen of ['c1', 'c2', 'c3']) {
    const revision = (await rail.jj.snapshot(currentWsPath)).commitId;
    const split = await children.taskSplit({
      taskId: currentTaskId,
      childSpec: childSpecFor({ scenario: 'ch8', repoId: rail.repoId, parentTaskId: currentTaskId, parentRevision: revision, gen }),
      session: EXEC_SESSION,
    });
    const childWs = await driveChildActive(rail, shared, split);
    currentTaskId = split.childTaskId;
    currentWsPath = childWs.childWsPath;
  }
  assert.equal(taskStatusOf(shared, currentTaskId), 'ACTIVE', '第 3 层子任务可正常拆分到位');

  const revision3 = (await rail.jj.snapshot(currentWsPath)).commitId;
  await expectGovErrorLike(
    children.taskSplit({
      taskId: currentTaskId,
      childSpec: childSpecFor({ scenario: 'ch8', repoId: rail.repoId, parentTaskId: currentTaskId, parentRevision: revision3, gen: 'c4' }),
      session: EXEC_SESSION,
    }),
    'E_CHILD_DEPTH_EXCEEDED',
    '3',
  );
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
    const leaked = all.raw.worktrees.filter((w) => w.path.includes(`gov-t42it-${shared.stamp}`));
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
