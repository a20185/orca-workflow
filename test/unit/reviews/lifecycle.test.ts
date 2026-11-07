/**
 * T3.2 任务收尾出口与人工验收回执单测：task fail（ACTIVE/CHANGES_REQUESTED →
 * FAILED + 清理意图）、task cancel（含在飞评审销毁意图、终态拒）、manual-approve
 * 回执开具与校验入口。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { declareTask } from '../../../src/services/tasks.ts';
import { manualApprove } from '../../../src/services/evidence.ts';
import {
  OPERATOR_SESSION,
  approveManual,
  createReviewHost,
  expectGovError,
  fullReviewEvidence,
  makeReviewService,
  makeSubmissionService,
  sampleReviewSpec,
  setupActiveTask,
  setupInReview,
  taskEvents,
  taskStatus,
  defaultManifest,
  EXEC_SESSION,
} from './testing.ts';

test('task fail（ACTIVE）：迁移 FAILED、fail 事件带 reason、认领资源清理意图', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-fail1' }));
    const result = await makeSubmissionService(h).fail({
      taskId: task.taskId,
      session: EXEC_SESSION,
      reason: '上游依赖取消',
    });
    assert.equal(result.taskStatus, 'FAILED');
    assert.equal(taskStatus(h, task.taskId), 'FAILED');
    const failEvent = h.db
      .prepare('SELECT actor, payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
      .get(task.taskId, 'fail');
    assert.equal(failEvent?.actor, EXEC_SESSION);
    assert.equal((JSON.parse(String(failEvent?.payload_json)) as { reason: string }).reason, '上游依赖取消');
    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'task_failed');
  } finally {
    h.dispose();
  }
});

test('task fail 状态门：CHANGES_REQUESTED 可失败收尾；REVIEW_REQUESTED 拒绝（在飞评审走 cancel）', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-fail2' }));

    // 从 IN_REVIEW 先退回到 CHANGES_REQUESTED。
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
    const failed = await makeSubmissionService(h).fail({ taskId: task.taskId, session: EXEC_SESSION });
    assert.equal(failed.taskStatus, 'FAILED');

    // 另铺一局停在 REVIEW_REQUESTED：fail 拒绝。
    const task2 = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-fail3' }));
    await makeSubmissionService(h).submit({
      taskId: task2.taskId,
      claimId: task2.claimId,
      tokenClaimId: task2.claimId,
      session: EXEC_SESSION,
      evidenceManifest: defaultManifest(),
    });
    await expectGovError(
      makeSubmissionService(h).fail({ taskId: task2.taskId, session: EXEC_SESSION }),
      'E_SUBMIT_INVALID',
    );
    assert.equal(taskStatus(h, task2.taskId), 'REVIEW_REQUESTED');
  } finally {
    h.dispose();
  }
});

test('task cancel（IN_REVIEW）：CANCELLED + 在飞评审资源销毁意图；DECLARED 可取消；终态重复取消拒', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-cancel1' }));
    const result = await makeSubmissionService(h).cancel({
      taskId: task.taskId,
      session: OPERATOR_SESSION,
      reason: '需求下线',
    });
    assert.equal(result.taskStatus, 'CANCELLED');
    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    const lastIntent = intents[intents.length - 1];
    assert.equal(lastIntent?.reason, 'task_cancelled');
    assert.equal((lastIntent?.review as { reviewId?: string } | undefined)?.reviewId, review.reviewId);

    // 终态重复取消：状态机裁决拒绝。
    await expectGovError(
      makeSubmissionService(h).cancel({ taskId: task.taskId, session: OPERATOR_SESSION }),
      'E_TRANSITION_INVALID',
    );

    // DECLARED 也可取消。
    await declareTask(
      { db: h.db, config: h.config, orca: h.orca },
      { spec: sampleReviewSpec({ taskId: 'gt-unit-cancel2' }), session: 'cap-decl' },
    );
    const cancelled = await makeSubmissionService(h).cancel({ taskId: 'gt-unit-cancel2', session: OPERATOR_SESSION });
    assert.equal(cancelled.taskStatus, 'CANCELLED');
    assert.equal(taskStatus(h, 'gt-unit-cancel2'), 'CANCELLED');
  } finally {
    h.dispose();
  }
});

test('manual-approve：事件回执（manualDecisionId/操作者身份/note）；未知 criterion 与任务拒绝', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-manual-approve' }));
    const receipt = manualApprove(
      { db: h.db },
      { taskId: task.taskId, criterionId: 'man-1', session: OPERATOR_SESSION, note: '人工核对产物' },
    );
    assert.ok(receipt.manualDecisionId.startsWith('gmd_'));

    const event = h.db
      .prepare('SELECT actor, payload_json, type FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
      .get(task.taskId, 'manual_approve');
    assert.equal(event?.actor, OPERATOR_SESSION);
    const payload = JSON.parse(String(event?.payload_json)) as { manualDecisionId: string; criterionId: string; note: string };
    assert.equal(payload.manualDecisionId, receipt.manualDecisionId);
    assert.equal(payload.criterionId, 'man-1');
    assert.equal(payload.note, '人工核对产物');

    await expectGovError(
      (async () =>
        manualApprove({ db: h.db }, { taskId: task.taskId, criterionId: 'man-x', session: OPERATOR_SESSION }))(),
      'E_REQUEST_INVALID',
    );
    await expectGovError(
      (async () => manualApprove({ db: h.db }, { taskId: 'gt-missing', criterionId: 'man-1', session: OPERATOR_SESSION }))(),
      'E_NOT_FOUND',
    );
  } finally {
    h.dispose();
  }
});
