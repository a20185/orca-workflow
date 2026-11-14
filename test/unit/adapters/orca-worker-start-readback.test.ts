/**
 * worker-start 失败通道读回重建单测（假 CLI 端口，不依赖真实 Orca 桌面）。
 *
 * 覆盖 1.4.255「ok:false + result 载荷（无 error 对象，exit 1）」运行期失败的三态
 * （adapter-drift-fix-report §6-A 的控制器裁定路线）：
 * ① 读回成功 → 重建旧契约回执：failedStage 由 worker-show 扁平 state/stage/lastError
 *    映射（失败载荷可不带 failedStage），residualResources 字符串还原为
 *    {kind,id,role:'unknown'} 对象；
 * ② 读回也失败 → E_ORCA_CALL_FAILED 且 message 携带失败载荷 lastError 原文；
 * ③ 参数校验类错误（ok:false + error 信封，invalid_argument）不走读回、直抛。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createOrcaAdapter, OrcaAdapterError } from '../../../src/adapters/orca.ts';

const FAKE_CLI = fileURLToPath(new URL('./fake-orca-cli.mjs', import.meta.url));
// git 应保留可执行位；防御性再设一次，避免 clone 配置差异使测试假死在 spawn。
fs.chmodSync(FAKE_CLI, 0o755);

interface ScenarioRule {
  readonly envelope: unknown;
  readonly exitCode?: number;
}

function installScenario(rules: Record<string, ScenarioRule>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-orca-readback-'));
  const scenarioPath = path.join(dir, 'scenario.json');
  fs.writeFileSync(scenarioPath, JSON.stringify(rules));
  process.env['GOV_FAKE_ORCA_SCENARIO'] = scenarioPath;
  const logPath = path.join(dir, 'calls.log');
  process.env['GOV_FAKE_ORCA_LOG'] = logPath;
  return logPath;
}

function readLoggedArgv(logPath: string): string[][] {
  if (!fs.existsSync(logPath)) {
    return [];
  }
  return fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as string[]);
}

const STATUS_READY: ScenarioRule = {
  envelope: { ok: true, result: { app: { running: true }, runtime: { state: 'ready', reachable: true } } },
};

// 1.4.255 实测形状（adapter-drift-fix-report §1）：运行期失败载荷无 error 对象、
// exit 1；residualResources 是字符串数组；两例实测均不带 recovery。
const RUNTIME_FAILURE_RESULT = {
  dispatchId: 'ctx_rb_fail',
  taskId: 'task_rb',
  runId: 'run_rb',
  state: 'failed',
  agent: 'claude',
  mode: 'structured',
  terminal: 'structworker_rb',
  workspace: '8c05::/Users/x/gov-rb-w1',
  lastError: 'The dispatch preamble was not delivered (agentCommandNotRunnable): Claude Command must start with a program Orca can find.',
  residualResources: ['worktree 8c05::/Users/x/gov-rb-w1', 'terminal structworker_rb'],
  next: 'This start left a worker session open. Close it with: orca orchestration worker-release --dispatch ctx_rb_fail',
};

function startInput(): Parameters<ReturnType<typeof createOrcaAdapter>['workerStart']>[0] {
  return { task: 'task_rb', worktree: 'path:/tmp/gov-rb-w1', agent: 'claude' };
}

test('读回成功：运行期失败载荷经 worker-show 重建旧契约回执', async () => {
  // 失败载荷刻意不带 failedStage：证明 failedStage 由读回的扁平 stage 映射而来。
  const logPath = installScenario({
    status: STATUS_READY,
    'orchestration worker-start': {
      envelope: { ok: false, result: RUNTIME_FAILURE_RESULT },
      exitCode: 1,
    },
    'orchestration worker-show': {
      envelope: {
        ok: true,
        result: {
          dispatchId: 'ctx_rb_fail',
          taskId: 'task_rb',
          runId: 'run_rb',
          state: 'failed',
          stage: 'dispatch_input',
          liveness: 'unverifiable',
          attention: ['failure', 'unverifiable'],
          waitingOnHuman: 'unknown',
          lastError: RUNTIME_FAILURE_RESULT.lastError,
        },
      },
    },
  });
  const adapter = createOrcaAdapter({ orcaPath: FAKE_CLI });

  const receipt = await adapter.workerStart(startInput());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.raw.dispatchId, 'ctx_rb_fail');
  assert.equal(receipt.raw.taskId, 'task_rb');
  assert.equal(receipt.raw.runId, 'run_rb');
  assert.equal(receipt.raw.state, 'failed');
  assert.equal(receipt.raw.failedStage, 'dispatch_input');
  assert.equal(receipt.raw.lastError, RUNTIME_FAILURE_RESULT.lastError);
  assert.deepEqual(receipt.raw.residualResources, [
    { kind: 'worktree', id: '8c05::/Users/x/gov-rb-w1', role: 'unknown' },
    { kind: 'terminal', id: 'structworker_rb', role: 'unknown' },
  ]);
  // 读回确实发生，且带着失败载荷的 dispatchId。
  const readback = readLoggedArgv(logPath).find((argv) => argv[0] === 'orchestration' && argv[1] === 'worker-show');
  assert.deepEqual(readback, ['orchestration', 'worker-show', '--dispatch', 'ctx_rb_fail', '--json']);
});

test('读回也失败：E_ORCA_CALL_FAILED 且 message 携带失败载荷 lastError 原文', async () => {
  const logPath = installScenario({
    status: STATUS_READY,
    'orchestration worker-start': {
      envelope: {
        ok: false,
        result: { ...RUNTIME_FAILURE_RESULT, failedStage: 'worktree_create' },
      },
      exitCode: 1,
    },
    'orchestration worker-show': {
      envelope: { ok: false, error: { code: 'dispatch_not_found', message: 'no such dispatch' } },
      exitCode: 1,
    },
  });
  const adapter = createOrcaAdapter({ orcaPath: FAKE_CLI });

  await assert.rejects(
    () => adapter.workerStart(startInput()),
    (err: unknown) => {
      assert.ok(err instanceof OrcaAdapterError, `期望 OrcaAdapterError，实际: ${String(err)}`);
      assert.equal(err.code, 'E_ORCA_CALL_FAILED');
      assert.ok(
        err.message.includes(RUNTIME_FAILURE_RESULT.lastError),
        `message 应含失败载荷 lastError 原文: ${err.message}`,
      );
      assert.equal(err.detail.failedStage, 'worktree_create');
      return true;
    },
  );
  // 读回确实尝试过（worker-show 被派生且被拒），不是未读回直抛。
  assert.ok(
    readLoggedArgv(logPath).some((argv) => argv[0] === 'orchestration' && argv[1] === 'worker-show'),
  );
});

test('参数错误（error 信封）不走读回：invalid_argument 直抛 E_ORCA_CALL_FAILED', async () => {
  const logPath = installScenario({
    status: STATUS_READY,
    'orchestration worker-start': {
      envelope: { ok: false, error: { code: 'invalid_argument', message: '--task is required' } },
      exitCode: 1,
    },
  });
  const adapter = createOrcaAdapter({ orcaPath: FAKE_CLI });

  await assert.rejects(
    () => adapter.workerStart(startInput()),
    (err: unknown) => {
      assert.ok(err instanceof OrcaAdapterError, `期望 OrcaAdapterError，实际: ${String(err)}`);
      assert.equal(err.code, 'E_ORCA_CALL_FAILED');
      assert.equal(err.detail.orcaErrorCode, 'invalid_argument');
      return true;
    },
  );
  // 调用面只有 status 与 worker-start：参数错误绝不触发 worker-show 读回。
  const verbs = readLoggedArgv(logPath).map((argv) =>
    argv[0] === 'orchestration' ? argv.slice(0, 2).join(' ') : argv[0],
  );
  assert.deepEqual(verbs, ['status', 'orchestration worker-start']);
});
