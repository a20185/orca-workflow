/**
 * T3.2 submit 单测：成功全链、重复提交幂等、路径越界/冲突残留拒绝、目标移动
 * requiresRebase、状态门，以及信封级同 requestId 幂等重放。
 */
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { GovError } from '../../../src/domain/errors.ts';
import { isSubmitAccepted } from '../../../src/services/submissions.ts';
import type { TokenInfo } from '../../../src/auth.ts';
import {
  beginOperation,
  canonicalRequestHash,
  finalizeOperation,
} from '../../../src/operations.ts';
import { createHandlerRegistry, registerCoreHandlers, type ActionContext } from '../../../src/api.ts';
import {
  BASE_COMMIT,
  MOVED_TARGET,
  SECOND_COMMIT,
  createReviewHost,
  defaultManifest,
  expectGovError,
  makeSubmissionService,
  sampleReviewSpec,
  setupActiveTask,
  taskStatus,
  type ReviewHost,
} from './testing.ts';

const SESSION = 'cap-exec-1';

test('submit 成功全链：submissions 行 + manifest 哈希 + submit 事件（commitId/treeId/清单）+ REVIEW_REQUESTED', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    const result = await makeSubmissionService(h).submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: SESSION,
      evidenceManifest: defaultManifest(),
    });
    if (!isSubmitAccepted(result)) {
      throw new Error(`submit 应被受理: ${JSON.stringify(result)}`);
    }

    assert.equal(result.taskStatus, 'REVIEW_REQUESTED');
    assert.equal(result.commitId, BASE_COMMIT);
    assert.ok(result.submissionId.startsWith('gsu_'));
    assert.equal(taskStatus(h, task.taskId), 'REVIEW_REQUESTED');

    const row = h.db.prepare('SELECT * FROM submissions WHERE submission_id = ?').get(result.submissionId);
    assert.equal(row?.claim_id, task.claimId);
    assert.equal(row?.commit_id, BASE_COMMIT);
    assert.ok(String(row?.dev_evidence_manifest_hash ?? '').match(/^[0-9a-f]{64}$/));

    const submitEvent = h.db
      .prepare('SELECT actor, payload_json FROM events WHERE task_id = ? AND type = ? ORDER BY seq DESC')
      .get(task.taskId, 'submit');
    assert.equal(submitEvent?.actor, SESSION);
    const payload = JSON.parse(String(submitEvent?.payload_json)) as {
      commitId: string;
      treeId: string;
      evidenceManifest: unknown[];
    };
    assert.equal(payload.commitId, BASE_COMMIT);
    assert.equal(payload.treeId, result.treeId);
    assert.equal(payload.evidenceManifest.length, 2);
  } finally {
    h.dispose();
  }
});

test('submit 重复（同 claim 同 commit）：幂等返回原回执，不重复建行', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    const service = makeSubmissionService(h);
    const first = await service.submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: SESSION,
      evidenceManifest: defaultManifest(),
    });
    if (!isSubmitAccepted(first)) {
      throw new Error(`submit 应被受理: ${JSON.stringify(first)}`);
    }
    const second = await service.submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: SESSION,
      evidenceManifest: defaultManifest(),
    });
    if (!isSubmitAccepted(second)) {
      throw new Error(`重复提交应幂等返回: ${JSON.stringify(second)}`);
    }
    assert.equal(second.submissionId, first.submissionId);
    assert.equal(second.idempotentReplay, true);
    const count = h.db
      .prepare('SELECT COUNT(*) AS c FROM submissions WHERE claim_id = ?')
      .get(task.claimId);
    assert.equal(Number(count?.c), 1);
  } finally {
    h.dispose();
  }
});

test('submit 路径越界：E_JJ_PATH_OUT_OF_SCOPE 拒绝且状态不动、无 submissions 行', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    h.jj.nextDiffPathsError = new GovError('E_JJ_PATH_OUT_OF_SCOPE', 'diff 路径超出任务 ownedPaths: src/b');
    await expectGovError(
      makeSubmissionService(h).submit({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: task.claimId,
        session: SESSION,
        evidenceManifest: defaultManifest(),
      }),
      'E_JJ_PATH_OUT_OF_SCOPE',
    );
    assert.equal(taskStatus(h, task.taskId), 'ACTIVE');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get();
    assert.equal(Number(count?.c), 0);
  } finally {
    h.dispose();
  }
});

test('submit 冲突残留：E_JJ_CONFLICT 拒绝（rebase 后未解决场景）', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    h.jj.conflictsByRev.set(BASE_COMMIT, ['src/a/merge.rs    2-sided conflict']);
    await expectGovError(
      makeSubmissionService(h).submit({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: task.claimId,
        session: SESSION,
        evidenceManifest: defaultManifest(),
      }),
      'E_JJ_CONFLICT',
    );
    assert.equal(taskStatus(h, task.taskId), 'ACTIVE');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get();
    assert.equal(Number(count?.c), 0);
  } finally {
    h.dispose();
  }
});

test('submit 目标移动：返回 requiresRebase + currentTarget，任务不动', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    h.jj.bookmarkCommit = MOVED_TARGET;
    const result = await makeSubmissionService(h).submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: SESSION,
      evidenceManifest: defaultManifest(),
    });
    assert.ok('requiresRebase' in result, `应返回 requiresRebase: ${JSON.stringify(result)}`);
    assert.equal(result.requiresRebase, true);
    assert.equal(result.currentTarget, MOVED_TARGET);
    assert.equal(result.expectedBase, BASE_COMMIT);
    assert.equal(taskStatus(h, task.taskId), 'ACTIVE');
    const count = h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get();
    assert.equal(Number(count?.c), 0);
  } finally {
    h.dispose();
  }
});

test('submit 状态门：REVIEW_REQUESTED 下不同 commit 的第二次提交 E_SUBMIT_INVALID；令牌不绑认领同样拒', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h);
    const service = makeSubmissionService(h);
    await service.submit({
      taskId: task.taskId,
      claimId: task.claimId,
      tokenClaimId: task.claimId,
      session: SESSION,
      evidenceManifest: defaultManifest(),
    });
    h.jj.advanceHead(task.devWsPath, SECOND_COMMIT);
    await expectGovError(
      service.submit({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: task.claimId,
        session: SESSION,
        evidenceManifest: defaultManifest(),
      }),
      'E_SUBMIT_INVALID',
    );
    await expectGovError(
      service.submit({
        taskId: task.taskId,
        claimId: task.claimId,
        tokenClaimId: null,
        session: SESSION,
        evidenceManifest: defaultManifest(),
      }),
      'E_SUBMIT_INVALID',
      '令牌未绑定',
    );
  } finally {
    h.dispose();
  }
});

test('submit 回执幂等重放（同 requestId）：信封第二次调用原样回放，不重执行', async () => {
  const h = createReviewHost();
  try {
    const task = await setupActiveTask(h, sampleReviewSpec({ taskId: 'gt-unit-replay' }));

    // 复刻 server.ts routeRequest 的账本顺序：authenticate(省略) → beginOperation
    // → handler → finalizeOperation；同 requestId 二次调用走 replay 分支。
    const registry = createHandlerRegistry();
    registerCoreHandlers(registry, {
      config: h.config,
      configPath: '(test)',
      reviewDeps: { orca: h.orca, jj: h.jj, env: h.env, stepTimeoutMs: h.stepTimeoutMs },
    });
    const handler = registry.lookup('submit');
    assert.ok(handler !== undefined, 'submit handler 应已注册');
    const submitHandler: (ctx: ActionContext) => Promise<unknown> = handler;
    const token: TokenInfo = {
      capabilityId: SESSION,
      role: 'executor',
      taskId: task.taskId,
      claimId: task.claimId,
      reviewId: null,
      actions: ['submit'],
      expiresAt: null,
    };
    const payload = { taskId: task.taskId, evidenceManifest: defaultManifest() };

    async function dispatch(requestId: string): Promise<{ status: number; body: unknown }> {
      const requestHash = canonicalRequestHash(requestId, 'submit', payload);
      const begin = beginOperation(h.db, { requestId, requestHash, kind: 'submit' });
      if (begin.type === 'replay') {
        return { status: begin.receipt?.httpStatus ?? 500, body: begin.receipt?.body };
      }
      if (begin.type === 'in_flight') {
        return { status: 400, body: { ok: false, error: { code: 'E_REQUEST_INVALID' } } };
      }
      const ctx: ActionContext = {
        db: h.db,
        dbPath: '(test)',
        config: h.config,
        configPath: '(test)',
        token,
        payload,
      };
      const body = { ok: true, result: await submitHandler(ctx) };
      finalizeOperation(h.db, begin.operationId, 'CONFIRMED', { httpStatus: 200, body });
      return { status: 200, body };
    }

    const first = await dispatch('req-submit-replay-1');
    assert.equal(first.status, 200);
    const second = await dispatch('req-submit-replay-1');
    assert.equal(second.status, 200);
    assert.deepEqual(second.body, first.body);

    const ops = h.db
      .prepare('SELECT status, kind, current_step FROM operations WHERE request_id = ?')
      .get('req-submit-replay-1');
    assert.equal(ops?.status, 'CONFIRMED');
    assert.equal(ops?.kind, 'submit');
    const submissions = h.db.prepare('SELECT COUNT(*) AS c FROM submissions').get();
    assert.equal(Number(submissions?.c), 1, '重放不得产生第二行提交');
  } finally {
    h.dispose();
  }
});
