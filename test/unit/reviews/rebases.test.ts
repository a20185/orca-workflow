/**
 * T3.2 rebase 单测：无冲突 rebase 旧提交/证据作废与新基线生效、REVIEW_REQUESTED
 * 场景 target_moved 回 ACTIVE、冲突清单返回与 submit 冲突兜底/解决后重评审。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { isSubmitAccepted, latestActiveSubmission } from '../../../src/services/submissions.ts';
import {
  BASE_COMMIT,
  MOVED_TARGET,
  REBASED_COMMIT,
  SECOND_COMMIT,
  approveManual,
  createReviewHost,
  expectGovError,
  fullReviewEvidence,
  makeRebaseService,
  makeReviewService,
  makeSubmissionService,
  sampleReviewSpec,
  setupActiveTask,
  setupInReview,
  submitForReview,
  taskEvents,
  taskStatus,
  defaultManifest,
  EXEC_SESSION,
} from './testing.ts';

function reviewSubmitOf(h: ReturnType<typeof createReviewHost>, args: {
  taskId: string;
  reviewId: string;
  evidence: Array<Record<string, unknown>>;
}): Promise<unknown> {
  return makeReviewService(h).reviewSubmit({
    taskId: args.taskId,
    reviewId: args.reviewId,
    tokenReviewId: args.reviewId,
    session: 'rev-session',
    payload: { verdict: 'approved', findings: [], evidence: args.evidence as never, reportRef: 'report://r' },
  });
}

test('无冲突 rebase（CHANGES_REQUESTED 场景）：旧提交/证据作废、任务原地、新基线下重新提交受审', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-rebase1' }));
    const md = approveManual(h, task.taskId, 'man-1');
    await makeReviewService(h).reviewSubmit({
      taskId: task.taskId,
      reviewId: review.reviewId,
      tokenReviewId: review.reviewId,
      session: 'rev-session',
      payload: {
        verdict: 'changes_requested',
        reasonClass: 'code',
        findings: [],
        evidence: fullReviewEvidence(md),
        reportRef: 'report://reject',
      },
    });
    assert.equal(taskStatus(h, task.taskId), 'CHANGES_REQUESTED');

    h.jj.bookmarkCommit = MOVED_TARGET;
    const result = await makeRebaseService(h).rebase({ taskId: task.taskId, session: EXEC_SESSION });

    assert.equal(result.taskStatus, 'CHANGES_REQUESTED', 'CHANGES_REQUESTED 场景原地待新提交');
    assert.equal(result.newBase, MOVED_TARGET);
    assert.equal(result.newCommitId, REBASED_COMMIT);
    assert.deepEqual(result.conflicts, []);
    assert.deepEqual(h.jj.rebaseCalls, [{ rev: BASE_COMMIT, newBase: MOVED_TARGET }], '重放对象是受审提交');
    const rebaseEvents = taskEvents(h, task.taskId, 'task_rebase');
    assert.deepEqual(rebaseEvents[rebaseEvents.length - 1]?.supersededSubmissionIds, [review.submissionId]);

    // 旧提交作废：最新有效提交为空，旧证据行只属于已作废提交。
    assert.equal(latestActiveSubmission(h.db, task.taskId), undefined);

    // 新基线生效：执行者在新版本上重新提交（bookmark == 最近 rebase 基线）。
    h.jj.advanceHead(task.devWsPath, SECOND_COMMIT);
    const second = await makeSubmissionService(h).submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: EXEC_SESSION,
      evidenceManifest: defaultManifest(),
    });
    if (!isSubmitAccepted(second)) {
      throw new Error(`rebase 后重新提交应被受理: ${JSON.stringify(second)}`);
    }
    assert.equal(second.commitId, SECOND_COMMIT);
    assert.equal(latestActiveSubmission(h.db, task.taskId)?.submissionId, second.submissionId);

    // 新评审钉在新提交上（旧证据不可再用）。
    const session = await makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' });
    const addCall = h.jj.workspaceAddCalls.find((call) => call.name === 'gr-gt-unit-rebase1-2');
    assert.equal(addCall?.rev, SECOND_COMMIT);
    await makeReviewService(h).reviewAccept({
      taskId: task.taskId,
      reviewId: session.reviewId,
      tokenReviewId: session.reviewId,
      session: 'rev-session',
    });
    const final = (await reviewSubmitOf(h, {
      taskId: task.taskId,
      reviewId: session.reviewId,
      evidence: fullReviewEvidence(approveManual(h, task.taskId, 'man-1')),
    })) as { taskStatus: string };
    assert.equal(final.taskStatus, 'APPROVED');
  } finally {
    h.dispose();
  }
});

test('REVIEW_REQUESTED 场景 rebase：target_moved 回 ACTIVE，在飞评审发销毁意图', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-rebase2' }));
    const submission = await submitForReview(h, task);
    await makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' });
    assert.equal(taskStatus(h, task.taskId), 'REVIEW_REQUESTED');

    h.jj.bookmarkCommit = MOVED_TARGET;
    const result = await makeRebaseService(h).rebase({ taskId: task.taskId, session: EXEC_SESSION });
    assert.equal(result.taskStatus, 'ACTIVE');
    assert.equal(taskStatus(h, task.taskId), 'ACTIVE');
    assert.deepEqual(taskEvents(h, task.taskId, 'target_moved').length, 1);
    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'submission_superseded');
    assert.equal(latestActiveSubmission(h.db, task.taskId), undefined);
    assert.equal(submission.commitId, BASE_COMMIT);
  } finally {
    h.dispose();
  }
});

test('冲突 rebase：返回冲突清单；未解决 submit 被 E_JJ_CONFLICT 兜底拒绝；解决后重新提交并重评审', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-rebase3' }));
    h.jj.bookmarkCommit = MOVED_TARGET;
    const submitResult = await makeSubmissionService(h).submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: EXEC_SESSION,
      evidenceManifest: defaultManifest(),
    });
    assert.ok('requiresRebase' in submitResult, '目标移动应先返回 requiresRebase');

    h.jj.rebaseScript.push({ newCommitId: REBASED_COMMIT, conflicts: ['src/a/merge.rs'] });
    const rebased = await makeRebaseService(h).rebase({ taskId: task.taskId, session: EXEC_SESSION });
    assert.deepEqual(rebased.conflicts, ['src/a/merge.rs']);
    assert.deepEqual(h.jj.rebaseCalls, [{ rev: BASE_COMMIT, newBase: MOVED_TARGET }], '无提交时重放工作副本');

    // 冲突未解决就提交：兜底拒绝。
    const resolvedCommit = SECOND_COMMIT;
    h.jj.advanceHead(task.devWsPath, resolvedCommit);
    h.jj.conflictsByRev.set(resolvedCommit, ['src/a/merge.rs']);
    await expectGovError(
      makeSubmissionService(h).submit({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: task.claimId,
        session: EXEC_SESSION,
        evidenceManifest: defaultManifest(),
      }),
      'E_JJ_CONFLICT',
    );

    // 冲突解决（新提交不再带冲突）后：提交过、评审过。
    h.jj.conflictsByRev.delete(resolvedCommit);
    const submitted = await makeSubmissionService(h).submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: EXEC_SESSION,
      evidenceManifest: defaultManifest(),
    });
    if (!isSubmitAccepted(submitted)) {
      throw new Error(`冲突解决后提交应被受理: ${JSON.stringify(submitted)}`);
    }
    assert.equal(submitted.commitId, resolvedCommit);
    const session = await makeReviewService(h).onMergeReady({ taskId: task.taskId, session: 'gov-poll' });
    await makeReviewService(h).reviewAccept({
      taskId: task.taskId,
      reviewId: session.reviewId,
      tokenReviewId: session.reviewId,
      session: 'rev-session',
    });
    const final = (await reviewSubmitOf(h, {
      taskId: task.taskId,
      reviewId: session.reviewId,
      evidence: fullReviewEvidence(approveManual(h, task.taskId, 'man-1')),
    })) as { taskStatus: string };
    assert.equal(final.taskStatus, 'APPROVED', '冲突解决后完成重评审');
  } finally {
    h.dispose();
  }
});
