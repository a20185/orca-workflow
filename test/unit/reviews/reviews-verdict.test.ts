/**
 * T3.2 review-submit 单测：结审 tree 检查、逐条证据核验（缺证据/命令非零/
 * artifact 哈希/人工回执伪造与跨引用）、问题分级签核门、退回恢复（resume +
 * 意见送达 / WORKSPACE_DIVERGED）与 review-request 同版本补证据。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { declareTask } from '../../../src/services/tasks.ts';
import {
  BASE_COMMIT,
  DIVERGED_COMMIT,
  approveManual,
  createReviewHost,
  expectGovError,
  fullReviewEvidence,
  makeReviewService,
  sampleReviewSpec,
  setupInReview,
  taskEvents,
  taskStatus,
  blockedReason,
  type InReview,
  type ReviewHost,
} from './testing.ts';

const REV_SESSION = 'rev-session-1';

function submitReview(
  h: ReviewHost,
  review: InReview,
  payload: {
    verdict: 'approved' | 'changes_requested';
    reasonClass?: 'code' | 'evidence' | 'process';
    findings?: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
    reportRef?: string;
  },
): Promise<unknown> {
  return makeReviewService(h).reviewSubmit({
    taskId: review.taskId,
    reviewId: review.reviewId,
    tokenReviewId: review.reviewId,
    session: REV_SESSION,
    payload: {
      verdict: payload.verdict,
      ...(payload.reasonClass !== undefined ? { reasonClass: payload.reasonClass } : {}),
      findings: payload.findings ?? [],
      evidence: payload.evidence,
      reportRef: payload.reportRef ?? 'report://default',
    } as never,
  });
}

test('approved 全证据通过：任务 APPROVED、reviewed_commit 钉版本、evidence 行、销毁意图', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-approve' }));
    const md = approveManual(h, task.taskId, 'man-1');
    const result = (await submitReview(h, review, {
      verdict: 'approved',
      evidence: fullReviewEvidence(md),
      reportRef: 'report://approve-1',
    })) as { verdict: string; taskStatus: string; returnDelivery: string | null };

    assert.equal(result.verdict, 'approved');
    assert.equal(result.taskStatus, 'APPROVED');
    assert.equal(result.returnDelivery, null, '通过路径无退回送达');
    assert.equal(taskStatus(h, task.taskId), 'APPROVED');

    const row = h.db.prepare('SELECT verdict, reviewed_commit_id, report_ref FROM reviews WHERE review_id = ?').get(review.reviewId);
    assert.equal(row?.verdict, 'approved');
    assert.equal(row?.reviewed_commit_id, BASE_COMMIT);
    assert.equal(row?.report_ref, 'report://approve-1');
    assert.equal(
      h.db.prepare('SELECT reviewed_commit_id FROM tasks WHERE task_id = ?').get(task.taskId)?.reviewed_commit_id,
      BASE_COMMIT,
    );

    const evidenceRows = h.db
      .prepare('SELECT criterion_id, produced_by, exit_code, content_hash, manual_decision_id FROM evidence WHERE review_id = ?')
      .all(review.reviewId);
    assert.equal(evidenceRows.length, 3);
    assert.ok(evidenceRows.every((r) => r.produced_by === 'reviewer'));

    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'review_approved');
    assert.equal(h.env.resumeCalls.length, 0, '通过路径不恢复开发环境');
  } finally {
    h.dispose();
  }
});

test('评审 tree 改动：E_REVIEW_TREE_CHANGED、结论不落库、作废回 REVIEW_REQUESTED 且该评审不可再接受', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-treechange' }));
    h.jj.advanceHead(review.reviewWsPath, DIVERGED_COMMIT);
    const md = approveManual(h, task.taskId, 'man-1');

    await expectGovError(
      submitReview(h, review, { verdict: 'approved', evidence: fullReviewEvidence(md) }),
      'E_REVIEW_TREE_CHANGED',
    );
    assert.equal(taskStatus(h, task.taskId), 'REVIEW_REQUESTED');
    const row = h.db.prepare('SELECT verdict FROM reviews WHERE review_id = ?').get(review.reviewId);
    assert.equal(row?.verdict, 'aborted', '评审者改了被审版本，结论不得落库');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM evidence').get();
    assert.equal(Number(count?.c), 0, '证据行也不得落库');
    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'review_tree_changed');
    await expectGovError(
      makeReviewService(h).reviewAccept({
        taskId: task.taskId,
        reviewId: review.reviewId,
        tokenReviewId: review.reviewId,
        session: REV_SESSION,
      }),
      'E_REQUEST_INVALID',
      '已被作废',
    );
  } finally {
    h.dispose();
  }
});

test('缺证据 / 命令 exitCode 非 0 / artifact 哈希不一致：均 E_REQUEST_INVALID 且结论不落库', async () => {
  const h = createReviewHost();
  try {
    let seq = 0;
    const cases: Array<{ readonly name: string; readonly mutate: (evidence: Array<Record<string, unknown>>) => void }> = [
      { name: '缺 manual 证据', mutate: (evidence) => void evidence.splice(2, 1) },
      { name: '命令 exitCode 非 0', mutate: (evidence) => void (evidence[0]!.exitCode = 1) },
      { name: 'artifact 哈希不一致', mutate: (evidence) => void (evidence[1]!.artifactHash = 'hash-other') },
    ];
    for (const testCase of cases) {
      seq += 1;
      const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: `gt-unit-evidence-${seq}` }));
      const decision = approveManual(h, task.taskId, 'man-1');
      const evidence = fullReviewEvidence(decision).map((item) => ({ ...item })) as Array<Record<string, unknown>>;
      testCase.mutate(evidence);
      await expectGovError(submitReview(h, review, { verdict: 'approved', evidence }), 'E_REQUEST_INVALID');
      assert.equal(
        h.db.prepare('SELECT verdict FROM reviews WHERE review_id = ?').get(review.reviewId)?.verdict,
        'aborted',
        `${testCase.name}: 结论不落库`,
      );
      assert.equal(taskStatus(h, task.taskId), 'IN_REVIEW', `${testCase.name}: 任务不动`);
    }
  } finally {
    h.dispose();
  }
});

test('人工回执伪造 / 跨 criterion / 跨任务引用：E_MANUAL_RECEIPT_INVALID', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(
      h,
      sampleReviewSpec({ taskId: 'gt-unit-manual', extraManual: true }),
    );
    // 跨任务：另一任务上开具的回执。
    await declareTask(
      { db: h.db, config: h.config, orca: h.orca },
      { spec: sampleReviewSpec({ taskId: 'gt-unit-manual-other' }), session: 'cap-decl' },
    );
    const otherTaskDecision = approveManual(h, 'gt-unit-manual-other', 'man-1');
    // 跨 criterion：本任务 man-2 的回执。
    const man2Decision = approveManual(h, task.taskId, 'man-2');

    const forged = [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: 'hash-art-1' },
      { criterionId: 'man-1', manualDecisionId: 'gmd_forged' },
      { criterionId: 'man-2', manualDecisionId: man2Decision },
    ];
    await expectGovError(submitReview(h, review, { verdict: 'approved', evidence: forged }), 'E_MANUAL_RECEIPT_INVALID');

    const crossCriterion = [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: 'hash-art-1' },
      { criterionId: 'man-1', manualDecisionId: man2Decision },
      { criterionId: 'man-2', manualDecisionId: man2Decision },
    ];
    await expectGovError(
      submitReview(h, review, { verdict: 'approved', evidence: crossCriterion }),
      'E_MANUAL_RECEIPT_INVALID',
      '归属其他 criterion',
    );

    const validMan = approveManual(h, task.taskId, 'man-1');
    const crossTask = [
      { criterionId: 'cmd-1', exitCode: 0 },
      { criterionId: 'art-1', artifactHash: 'hash-art-1' },
      { criterionId: 'man-1', manualDecisionId: validMan },
      { criterionId: 'man-2', manualDecisionId: otherTaskDecision },
    ];
    await expectGovError(submitReview(h, review, { verdict: 'approved', evidence: crossTask }), 'E_MANUAL_RECEIPT_INVALID');
  } finally {
    h.dispose();
  }
});

test('问题分级签核门：OPEN high 阻签、low 未停泊阻签、PARKED 缺理由拒、low PARKED 带理由可签', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-findings' }));
    const md = approveManual(h, task.taskId, 'man-1');
    const base = () => fullReviewEvidence(md);

    await expectGovError(
      submitReview(h, review, {
        verdict: 'approved',
        evidence: base(),
        findings: [{ severity: 'high', note: '并发窗口', disposition: 'OPEN' }],
      }),
      'E_REQUEST_INVALID',
      '阻止签核',
    );
    await expectGovError(
      submitReview(h, review, {
        verdict: 'approved',
        evidence: base(),
        findings: [{ severity: 'low', note: '命名建议', disposition: 'OPEN' }],
      }),
      'E_REQUEST_INVALID',
      'low',
    );
    await expectGovError(
      submitReview(h, review, {
        verdict: 'approved',
        evidence: base(),
        findings: [{ severity: 'low', note: '命名建议', disposition: 'PARKED' }],
      }),
      'E_REQUEST_INVALID',
      '停泊理由',
    );
    const result = (await submitReview(h, review, {
      verdict: 'approved',
      evidence: base(),
      findings: [
        { severity: 'low', note: '命名建议', disposition: 'PARKED', parkedReason: '不影响本次目标，留待后续' },
        { severity: 'medium', note: '旧问题已修', disposition: 'RESOLVED' },
      ],
    })) as { taskStatus: string };
    assert.equal(result.taskStatus, 'APPROVED');

    const findings = h.db
      .prepare('SELECT severity, status, parked_reason, resolved_in_submission_id FROM findings WHERE review_id = ?')
      .all(review.reviewId);
    assert.equal(findings.length, 2);
    const parked = findings.find((f) => f.status === 'PARKED');
    assert.equal(parked?.parked_reason, '不影响本次目标，留待后续');
    const resolved = findings.find((f) => f.status === 'RESOLVED');
    assert.equal(resolved?.resolved_in_submission_id, review.submissionId);
  } finally {
    h.dispose();
  }
});

test('changes_requested 全链：退回 + 开发环境恢复 + 退回意见定向送达执行者', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-reject' }));
    const md = approveManual(h, task.taskId, 'man-1');
    const result = (await submitReview(h, review, {
      verdict: 'changes_requested',
      reasonClass: 'evidence',
      evidence: fullReviewEvidence(md),
      findings: [{ severity: 'medium', note: '测试覆盖不足', disposition: 'OPEN' }],
    })) as { taskStatus: string; returnDelivery: string };

    assert.equal(result.taskStatus, 'CHANGES_REQUESTED');
    assert.equal(result.returnDelivery, 'sent');
    assert.equal(taskStatus(h, task.taskId), 'CHANGES_REQUESTED');

    // reject 事件载荷携带 reasonClass（review-request 的判定真源）。
    const rejectEvents = taskEvents(h, task.taskId, 'reject');
    assert.equal(rejectEvents[rejectEvents.length - 1]?.reasonClass, 'evidence');

    assert.ok(h.env.resumeCalls.includes(task.devEnvId), '退回后恢复开发环境');
    assert.equal(h.db.prepare('SELECT env_status FROM workspaces WHERE env_instance_id = ?').get(task.devEnvId)?.env_status, 'running');
    assert.equal(h.orca.sendCalls.length, 1);
    assert.equal(h.orca.sendCalls[0]?.dispatch, task.executorDispatchId);
    assert.ok(h.orca.sendCalls[0]?.subject.includes('evidence'));
    assert.ok(h.orca.sendCalls[0]?.body.includes('测试覆盖不足'));

    const intents = taskEvents(h, task.taskId, 'cleanup_intent');
    assert.equal(intents[intents.length - 1]?.reason, 'review_rejected');
  } finally {
    h.dispose();
  }
});

test('退回恢复 diverged：E_WORKSPACE_DIVERGED + blockedReason + 不恢复环境（结论已落库）', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-diverged' }));
    const md = approveManual(h, task.taskId, 'man-1');
    // 评审期间执行者工作副本被改动（不应发生但必须防御）。
    h.jj.advanceHead(task.devWsPath, DIVERGED_COMMIT);

    await expectGovError(
      submitReview(h, review, { verdict: 'changes_requested', reasonClass: 'code', evidence: fullReviewEvidence(md) }),
      'E_WORKSPACE_DIVERGED',
    );
    assert.equal(taskStatus(h, task.taskId), 'CHANGES_REQUESTED');
    assert.equal(blockedReason(h, task.taskId), 'workspace_diverged');
    assert.equal(h.env.resumeCalls.length, 0, '分叉转人工，不恢复开发环境');
    assert.equal(h.db.prepare('SELECT verdict FROM reviews WHERE review_id = ?').get(review.reviewId)?.verdict, 'changes_requested');
  } finally {
    h.dispose();
  }
});

test('意见送达失败不阻断退回：returnDelivery=send_failed 且任务仍在 CHANGES_REQUESTED', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-sendfail' }));
    const md = approveManual(h, task.taskId, 'man-1');
    h.orca.failSend = new GovError('E_ORCA_CALL_FAILED', '剧本注入的发送失败');
    const result = (await submitReview(h, review, {
      verdict: 'changes_requested',
      reasonClass: 'process',
      evidence: fullReviewEvidence(md),
    })) as { taskStatus: string; returnDelivery: string };
    assert.equal(result.taskStatus, 'CHANGES_REQUESTED');
    assert.equal(result.returnDelivery, 'send_failed');
    assert.equal(taskEvents(h, task.taskId, 'return_comments_failed').length, 1);
  } finally {
    h.dispose();
  }
});

test('review-request：证据类退回 + 同版本 → 新评审（第 2 轮）；code 类退回拒；版本漂移拒', async () => {
  const h = createReviewHost();
  try {
    const service = makeReviewService(h);
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-req' }));
    const md = approveManual(h, task.taskId, 'man-1');
    await submitReview(h, review, {
      verdict: 'changes_requested',
      reasonClass: 'evidence',
      evidence: fullReviewEvidence(md),
    });

    const second = await service.reviewRequest({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: 'cap-exec-1',
    });
    assert.notEqual(second.reviewId, review.reviewId);
    assert.equal(second.taskStatus, 'REVIEW_REQUESTED');
    assert.equal(Number(h.db.prepare('SELECT COUNT(*) AS c FROM reviews').get()?.c), 2);
    assert.ok(h.jj.workspaceAddCalls.some((call) => call.name === 'gr-gt-unit-req-2'), '第二轮评审用新工作区');
    assert.ok(h.env.suspendCalls.includes(task.devEnvId), '建新评审前重新暂停开发环境');

    // 第二轮通过（同版本补足证据后）。
    await service.reviewAccept({
      taskId: task.taskId,
      reviewId: second.reviewId,
      tokenReviewId: second.reviewId,
      session: second.reviewerCapabilityId ?? 'rev',
    });
    const final = (await submitReview(h, { ...review, reviewId: second.reviewId }, {
      verdict: 'approved',
      evidence: fullReviewEvidence(approveManual(h, task.taskId, 'man-1')),
    })) as { taskStatus: string };
    assert.equal(final.taskStatus, 'APPROVED');

    // code 类退回不允许同版本重送：另铺一局。
    const codeCase = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-req-code' }));
    const md2 = approveManual(h, codeCase.task.taskId, 'man-1');
    await submitReview(h, codeCase.review, {
      verdict: 'changes_requested',
      reasonClass: 'code',
      evidence: fullReviewEvidence(md2),
    });
    await expectGovError(
      service.reviewRequest({
        taskId: codeCase.task.taskId,
        claimId: codeCase.task.claimId,
        tokenClaimId: codeCase.task.claimId,
        session: 'cap-exec-1',
      }),
      'E_REVIEW_REQUEST_INVALID',
      '不允许同版本补证据重送',
    );

    // 版本漂移（执行者已改代码）→ 需重新提交而不是 review request。
    const driftCase = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-req-drift' }));
    const md3 = approveManual(h, driftCase.task.taskId, 'man-1');
    await submitReview(h, driftCase.review, {
      verdict: 'changes_requested',
      reasonClass: 'evidence',
      evidence: fullReviewEvidence(md3),
    });
    h.jj.advanceHead(driftCase.task.devWsPath, DIVERGED_COMMIT);
    await expectGovError(
      service.reviewRequest({
        taskId: driftCase.task.taskId,
        claimId: driftCase.task.claimId,
        tokenClaimId: driftCase.task.claimId,
        session: 'cap-exec-1',
      }),
      'E_REVIEW_REQUEST_INVALID',
      '需重新提交',
    );
  } finally {
    h.dispose();
  }
});

test('review-request 预算耗尽：E_BUDGET_EXCEEDED + 转人工', async () => {
  const h = createReviewHost();
  try {
    const { task, review } = await setupInReview(h, sampleReviewSpec({ taskId: 'gt-unit-reqbudget', maxReviewRounds: 1 }));
    const md = approveManual(h, task.taskId, 'man-1');
    await submitReview(h, review, {
      verdict: 'changes_requested',
      reasonClass: 'evidence',
      evidence: fullReviewEvidence(md),
    });
    await expectGovError(
      makeReviewService(h).reviewRequest({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: task.claimId,
        session: 'cap-exec-1',
      }),
      'E_BUDGET_EXCEEDED',
    );
    assert.equal(blockedReason(h, task.taskId), 'review_budget_exhausted');
  } finally {
    h.dispose();
  }
});
