/**
 * T3.2 评审 Session 单测：身份三拒（声明者/历史认领者/当前认领者换人）、无可用
 * 评审者、暂停失败 UNCERTAIN、轮数预算、onMergeReady 幂等与 review-accept。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import { createClaimService } from '../../../src/services/claims.ts';
import {
  BASE_COMMIT,
  COORD_SESSION,
  DECLARER_SESSION,
  DIVERGED_COMMIT,
  EXEC_SESSION,
  HIST_COORD_SESSION,
  createReviewHost,
  expectGovError,
  fullReviewEvidence,
  makeReviewService,
  sampleReviewSpec,
  setupActiveTask,
  setupInReview,
  submitForReview,
  taskEvents,
  taskStatus,
  blockedReason,
  type ReviewHost,
} from './testing.ts';

function reviewWorkerStarts(h: ReviewHost): number {
  return h.orca.workerStartCalls.filter((call) => call.agent === 'claude').length;
}

test('身份三拒全链：声明者/历史认领者/当前认领者依次被换，第 4 人当选', async () => {
  const h = createReviewHost();
  try {
    const taskId = 'gt-unit-identity';
    await declareTask(
      { db: h.db, config: h.config, orca: h.orca },
      { spec: sampleReviewSpec({ taskId }), session: DECLARER_SESSION },
    );
    const claims = createClaimService({
      db: h.db,
      config: h.config,
      orca: h.orca,
      jj: h.jj,
      env: h.env,
      trustProvision: h.trust.provision,
      stepTimeoutMs: h.stepTimeoutMs,
    });
    // 历史认领者：第一笔认领被释放（直接落终态，模拟人工/过期释放）。
    const first = await claims.claim(HIST_COORD_SESSION, { taskId });
    const now = new Date().toISOString();
    h.db.prepare("UPDATE claims SET status = 'RELEASED', updated_at = ? WHERE claim_id = ?").run(now, first.claimId);
    h.db.prepare('UPDATE tasks SET current_claim_id = NULL WHERE task_id = ?').run(taskId);
    const second = await claims.claim(COORD_SESSION, { taskId });
    await claims.accept({ taskId, claimId: second.claimId, tokenClaimId: second.claimId, session: EXEC_SESSION });
    await submitForReview(h, { taskId, claimId: second.claimId });

    h.orca.identitiesByAgent.set('claude', [DECLARER_SESSION, HIST_COORD_SESSION, COORD_SESSION, 'rev-clean-1']);
    const session = await makeReviewService(h).onMergeReady({ taskId, session: 'gov-poll' });

    assert.equal(reviewWorkerStarts(h), 4, '前三候选被拒后应派工四次');
    assert.deepEqual(h.orca.workerStopCalls.length, 3);
    const rejected = taskEvents(h, taskId, 'reviewer_rejected');
    assert.deepEqual(
      rejected.map((event) => event.rule),
      ['declarer', 'historical_claimer', 'current_claimer'],
    );
    assert.equal(session.reviewerSession, 'rev-clean-1');
    const row = h.db.prepare('SELECT reviewer_session, verdict, dispatch_id FROM reviews WHERE review_id = ?').get(session.reviewId);
    assert.equal(row?.reviewer_session, 'rev-clean-1');
    assert.equal(row?.verdict, 'aborted', '未出结论的评审行以 aborted 占位');
    assert.equal(row?.dispatch_id, session.dispatchId);
    assert.ok(session.reviewerToken !== null && session.reviewerToken.startsWith('govt_'));
  } finally {
    h.dispose();
  }
});

test('无可用评审者：E_NO_REVIEWER + blockedReason=no_reviewer，不落评审行并回收评审资源', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-norev' }));
    await submitForReview(h, task);
    // 候选上限内全部命中禁任身份（声明者反复出现）→ 无可用评审者。
    h.orca.identitiesByAgent.set(
      'claude',
      [DECLARER_SESSION, DECLARER_SESSION, DECLARER_SESSION, DECLARER_SESSION],
    );

    await expectGovError(makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' }), 'E_NO_REVIEWER');
    assert.equal(blockedReason(h, task.taskId), 'no_reviewer');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM reviews').get();
    assert.equal(Number(count?.c), 0);
    // 评审工作区已建则必须回收（destroy + forget），清理意图事件留档供 T3.3 对账。
    assert.ok(h.env.destroyCalls.length >= 1);
    assert.ok(h.jj.workspaceForgetCalls.includes('gr-gt-unit-norev-1'));
    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'no_reviewer');
  } finally {
    h.dispose();
  }
});

test('onMergeReady 暂停失败：认领 UNCERTAIN + blockedReason=env_suspend_failed，不建评审', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-suspend' }));
    await submitForReview(h, task);
    h.env.failSuspend = new GovError('E_ENV_LIFECYCLE_FAILED', 'docker pause 失败');

    await expectGovError(makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' }), 'E_ENV_LIFECYCLE_FAILED');
    const claim = h.db.prepare('SELECT status FROM claims WHERE claim_id = ?').get(task.claimId);
    assert.equal(claim?.status, 'UNCERTAIN');
    assert.equal(blockedReason(h, task.taskId), 'env_suspend_failed');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM reviews').get();
    assert.equal(Number(count?.c), 0);
    assert.equal(taskStatus(h, task.taskId), 'REVIEW_REQUESTED', '任务状态不动，等人工处置');
  } finally {
    h.dispose();
  }
});

test('轮数预算溢出（重建场景）：E_BUDGET_EXCEEDED + blockedReason=review_budget_exhausted', async () => {
  const h = createReviewHost();
  try {
    const spec = sampleReviewSpec({ taskId: 'gt-unit-budget', maxReviewRounds: 1 });
    const { task, review } = await setupInReview(h, spec);

    // 评审者改动了被审版本 → 评审作废回 REVIEW_REQUESTED（预算已消耗 1 轮）。
    h.jj.advanceHead(review.reviewWsPath, DIVERGED_COMMIT);
    await expectGovError(
      makeReviewService(h).reviewSubmit({
        taskId: task.taskId,
        reviewId: review.reviewId,
        tokenReviewId: review.reviewId,
        session: 'rev-1',
        payload: {
          verdict: 'approved',
          findings: [],
          evidence: fullReviewEvidence('gmd_any'),
          reportRef: 'report://r1',
        },
      }),
      'E_REVIEW_TREE_CHANGED',
    );
    assert.equal(taskStatus(h, task.taskId), 'REVIEW_REQUESTED');

    await expectGovError(makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' }), 'E_BUDGET_EXCEEDED');
    assert.equal(blockedReason(h, task.taskId), 'review_budget_exhausted');
  } finally {
    h.dispose();
  }
});

test('onMergeReady 幂等：重复轮询返回同一评审事实，不重复暂停/建资源', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-poll' }));
    await submitForReview(h, task);
    const service = makeReviewService(h);
    const first = await service.onMergeReady({ taskId: task.taskId, session: 'gov-poll' });
    const second = await service.onMergeReady({ taskId: task.taskId, session: 'gov-poll' });

    assert.equal(second.reviewId, first.reviewId);
    assert.equal(second.idempotentReplay, true);
    assert.equal(second.reviewerToken, null, '幂等分支不再返回明文令牌');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM reviews').get();
    assert.equal(Number(count?.c), 1);
    assert.equal(h.env.suspendCalls.length, 1, '开发环境只暂停一次');
    assert.equal(reviewWorkerStarts(h), 1);
  } finally {
    h.dispose();
  }
});

test('评审 Session 创建：工作区 base=受审提交、评审环境切可写、任务进 REVIEW_REQUESTED 后 accept 激活', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-session' }));
    await submitForReview(h, task);
    const service = makeReviewService(h);
    const session = await service.onMergeReady({ taskId: task.taskId, session: 'gov-poll' });

    const addCall = h.jj.workspaceAddCalls.find((call) => call.name === `gr-gt-unit-session-1`);
    assert.ok(addCall !== undefined, '评审工作区名应为 gr-<taskId>-<seq>');
    assert.equal(addCall.rev, BASE_COMMIT, '评审工作区 base 钉在受审提交');
    assert.ok(h.env.setWritableCalls.includes(session.envInstanceId), '评审环境无 0000 门，创建即切可写');
    // 开发环境在进入 REVIEW_REQUESTED 的建评审路径上被暂停。
    assert.ok(h.env.suspendCalls.includes(task.devEnvId));

    const accepted = await service.reviewAccept({
      taskId: task.taskId,
      reviewId: session.reviewId,
      tokenReviewId: session.reviewId,
      session: session.reviewerCapabilityId ?? 'rev',
    });
    assert.equal(accepted.taskStatus, 'IN_REVIEW');
    assert.equal(taskStatus(h, task.taskId), 'IN_REVIEW');

    // 令牌未绑定该评审：E_REVIEW_FORBIDDEN。
    await expectGovError(
      service.reviewAccept({
        taskId: task.taskId,
        reviewId: session.reviewId,
        tokenReviewId: 'grv_other',
        session: 'rev-2',
      }),
      'E_REVIEW_FORBIDDEN',
    );
  } finally {
    h.dispose();
  }
});
