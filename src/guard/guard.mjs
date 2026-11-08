#!/usr/bin/env node
/**
 * T5.1 受限启动器（设计 §9.2）。镜像内以 root:root 0755 落在
 * /usr/local/lib/gov/guard，任务用户唯一 sudo 入口（deploy/sudoers/gov-guard）：
 *   sudo -u orca-broker /usr/local/lib/gov/guard gov <action> [jsonPayload]
 *   sudo -u orca-broker /usr/local/lib/gov/guard orca <verb> [--flag value ...]
 * /usr/local/bin/orca 垫片（preamble 裸命令名入口）等价于 `guard orca "$@"`。
 *
 * 身份与传输：
 * - 身份只来自 /var/lib/orca-broker/identity.json（broker 0600；T3.1 claim /
 *   T3.2 review 流程经 env userData 注入）。调用者传入的一切身份字段
 *   （--from/--terminal/--task-id/--dispatch-id/--to/--run、TASK_ID 等
 *   环境变量）一律剥除或忽略。
 * - gov 动作：guard-authorize 预检后原样 HTTP 代发 gov API /api/call。
 * - Orca 动作：guard-authorize 预检后以 broker 身份 execFile 真 CLI
 *   （/opt/orca-broker/bin/orca），cwd=broker HOME、env 白名单、stdin 继承
 *   当前 PTY，退出码与 stdout 原样返回。传输通道为 CLI 远端配对码
 *   （identity.orcaPairingCode → ws://host.docker.internal:<port>，Phase 5.1
 *   传输探针候选 A 实证），不在容器内跑 `orca serve`。
 *
 * 参数安全：无 shell（argv 数组直达）；另按契约拒绝含元字符/控制符的参数、
 * 剥除身份寻址标志、只放行各动词的白名单标志。白名单镜像 src/guard/contract.ts。
 *
 * 退出码：2 用法错误；3 gov 授权拒绝；4 gov 请求失败；5 身份/环境无效；
 * 其余为真 CLI 原样退出码。
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const IDENTITY_PATH = '/var/lib/orca-broker/identity.json';
const TRUE_CLI = '/opt/orca-broker/bin/orca';
const GUARD_HOME = '/var/lib/orca-broker';
const BROKER_USER = 'orca-broker';

const ORCA_VERBS = ['check', 'ask', 'reply', 'send'];
const SEND_TYPES = ['heartbeat', 'status', 'escalation', 'merge_ready', 'worker_done'];
const WORKER_DONE_OUTCOMES = ['succeeded', 'failed'];
// true = 消费一个值，false = 布尔开关（镜像 contract.ts GUARD_ORCA_FLAGS_BY_VERB）。
const ORCA_FLAGS = {
  check: { '--wait': false, '--timeout-ms': true, '--ack': true, '--types': true },
  ask: { '--question': true, '--options': true, '--timeout-ms': true },
  reply: { '--id': true, '--body': true },
  send: { '--type': true, '--subject': true, '--body': true, '--phase': true, '--outcome': true, '--priority': true },
};
const STRIPPED_FLAGS = new Set([
  '--from', '--terminal', '--to', '--run', '--task-id', '--dispatch-id',
  '--pairing-code', '--environment', '--retry-request', '--dispatch-capability',
]);
const ARG_FORBIDDEN = /[\n\r\0`;]|\$\(/;
const GOV_ACTIONS = [
  'accept', 'submit', 'fail', 'split', 'rebase', 'review-request',
  'review-accept', 'review-submit', 'status',
];

function fail(code, message) {
  process.stderr.write(`guard: ${message}\n`);
  process.exit(code);
}

function mustRunAsBroker() {
  let passwd;
  try {
    passwd = readFileSync('/etc/passwd', 'utf8');
  } catch {
    fail(5, '无法读取 /etc/passwd');
  }
  const entry = passwd.split('\n').find((line) => line.startsWith(`${BROKER_USER}:`));
  if (entry === undefined) {
    fail(5, `镜像缺少 ${BROKER_USER} 用户`);
  }
  const brokerUid = Number(entry.split(':')[2]);
  if (process.getuid() !== brokerUid) {
    fail(5, `guard 必须以 ${BROKER_USER} 运行（当前 uid=${process.getuid()}）`);
  }
}

function loadIdentity() {
  let st;
  try {
    st = statSync(IDENTITY_PATH);
  } catch {
    fail(5, `身份文件不存在或不可读: ${IDENTITY_PATH}`);
  }
  if ((st.mode & 0o777) !== 0o600 || st.uid !== process.getuid()) {
    fail(5, `身份文件必须 ${BROKER_USER}:0600（实际 uid=${st.uid} mode=${(st.mode & 0o777).toString(8)}）`);
  }
  let identity;
  try {
    identity = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
  } catch (err) {
    fail(5, `身份文件不是合法 JSON: ${err.message}`);
  }
  for (const key of ['token', 'govBaseUrl', 'taskId', 'terminalHandle', 'dispatchId', 'orcaPairingCode']) {
    if (typeof identity[key] !== 'string' || identity[key].length === 0) {
      fail(5, `身份文件缺少有效字段: ${key}`);
    }
  }
  return identity;
}

function rejectInjectedArgs(args) {
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.length === 0 || arg.length > 8192) {
      fail(2, '参数必须是非空 8192 字节以内字符串');
    }
    if (ARG_FORBIDDEN.test(arg)) {
      fail(2, `参数含禁止字符（换行/反引号/分号/命令替换）: ${arg.slice(0, 64)}`);
    }
  }
}

/** 过滤调用参数：剥除身份/寻址/重试标志及其值；其余必须命中动词白名单。 */
function filterOrcaArgs(verb, args) {
  const allowed = ORCA_FLAGS[verb];
  const kept = [];
  let i = 0;
  let sendType;
  let outcome;
  while (i < args.length) {
    const arg = args[i];
    if (!arg.startsWith('--')) {
      fail(2, `orca ${verb} 不接受位置参数: ${arg.slice(0, 64)}`);
    }
    if (STRIPPED_FLAGS.has(arg)) {
      // 剥除调用者身份/寻址标志：guard 只使用 gov 回执值。
      if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        i += 2;
      } else {
        i += 1;
      }
      continue;
    }
    if (arg === '--json') {
      i += 1;
      continue;
    }
    const takesValue = allowed[arg];
    if (takesValue === undefined) {
      fail(2, `orca ${verb} 不允许标志 ${arg}`);
    }
    if (takesValue) {
      if (i + 1 >= args.length) {
        fail(2, `标志 ${arg} 缺少值`);
      }
      const value = args[i + 1];
      if (value.startsWith('--')) {
        fail(2, `标志 ${arg} 的值不能以 -- 开头`);
      }
      if (arg === '--type') {
        sendType = value;
      }
      if (arg === '--outcome') {
        outcome = value;
      }
      kept.push(arg, value);
      i += 2;
    } else {
      kept.push(arg);
      i += 1;
    }
  }
  if (verb === 'send') {
    if (sendType === undefined) {
      fail(2, 'orca send 需要 --type');
    }
    if (!SEND_TYPES.includes(sendType)) {
      fail(2, `orca send 类型不在白名单: ${sendType}`);
    }
    if (sendType === 'worker_done') {
      if (outcome === undefined) {
        fail(2, 'worker_done 需要 --outcome succeeded|failed');
      }
      if (!WORKER_DONE_OUTCOMES.includes(outcome)) {
        fail(2, `worker_done outcome 非法: ${outcome}`);
      }
    }
  }
  return { kept, sendType, outcome };
}

async function callGov(identity, action, payload) {
  const url = `${identity.govBaseUrl.replace(/\/$/, '')}/api/call`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${identity.token}`,
      },
      body: JSON.stringify({ requestId: randomUUID(), action, payload }),
    });
  } catch (err) {
    fail(4, `gov API 不可达 (${url}): ${err.message}`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    fail(4, `gov API 响应不是 JSON (HTTP ${response.status})`);
  }
  return body;
}

async function authorize(identity, subcommand, keptArgs, sendType, outcome) {
  const payload = {
    // taskId 走身份文件：宿主 API 鉴权层要求任务绑定令牌的请求声明任务归属。
    taskId: identity.taskId,
    subcommand,
    argsDigest: createHash('sha256').update(JSON.stringify(keptArgs)).digest('hex'),
    argCount: keptArgs.length,
    ...(sendType === undefined ? {} : { sendType }),
    ...(outcome === undefined ? {} : { outcome }),
    identity: { terminalHandle: identity.terminalHandle, dispatchId: identity.dispatchId },
  };
  const body = await callGov(identity, 'guard-authorize', payload);
  if (body.ok !== true || body.result.allowed !== true) {
    process.stderr.write(`${JSON.stringify(body)}\n`);
    fail(3, `gov 授权拒绝: ${subcommand}`);
  }
  return body.result;
}

function execTrueCli(identity, argv) {
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: GUARD_HOME,
    ORCA_PAIRING_CODE: identity.orcaPairingCode,
  };
  const result = spawnSync(TRUE_CLI, argv, {
    cwd: GUARD_HOME,
    env,
    stdio: 'inherit',
    // ask/check --wait 长轮询：给足 CLI 自身超时（默认 60s，--timeout-ms 可延长）。
    timeout: 0,
  });
  if (result.error !== undefined) {
    fail(5, `真 CLI 执行失败: ${result.error.message}`);
  }
  process.exit(result.status === null ? 124 : result.status);
}

function usage() {
  process.stderr.write(
    '用法: guard gov <action> [jsonPayload] | guard orca <check|ask|reply|send> [--flag value ...]\n',
  );
  fail(2, '参数不合法');
}

async function main() {
  mustRunAsBroker();
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    usage();
  }
  const identity = loadIdentity();

  if (argv[0] === 'gov') {
    const action = argv[1];
    if (action === undefined || !GOV_ACTIONS.includes(action)) {
      fail(2, `gov 动作不在白名单: ${String(action)}`);
    }
    let payload = {};
    if (argv.length > 3) {
      usage();
    }
    if (argv[2] !== undefined) {
      try {
        payload = JSON.parse(argv[2]);
      } catch (err) {
        fail(2, `gov ${action} 的载荷不是合法 JSON: ${err.message}`);
      }
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        fail(2, `gov ${action} 的载荷必须是 JSON 对象`);
      }
    }
    await authorize(identity, `gov:${action}`, [action], undefined, undefined);
    const body = await callGov(identity, action, payload);
    process.stdout.write(`${JSON.stringify(body)}\n`);
    process.exit(body.ok === true ? 0 : 4);
  }

  if (argv[0] === 'orca') {
    const verb = argv[1];
    if (verb === undefined || !ORCA_VERBS.includes(verb)) {
      fail(2, `orca 动词不在白名单: ${String(verb)}`);
    }
    // 元字符门只作用于 orca 参数（gov 载荷是结构校验过的 JSON 对象，正文可含分号）。
    rejectInjectedArgs(argv.slice(2));
    const { kept, sendType, outcome } = filterOrcaArgs(verb, argv.slice(2));
    const auth = await authorize(identity, `orca:${verb}`, kept, sendType, outcome);
    const resolvedTerminal = auth.resolvedTerminal;
    const dispatchId = auth.dispatchId;
    const cliArgs = ['orchestration', verb, ...kept, '--json'];
    if (verb === 'check') {
      cliArgs.push('--terminal', resolvedTerminal);
    } else {
      cliArgs.push('--from', resolvedTerminal);
    }
    if (verb === 'send') {
      cliArgs.push('--task-id', identity.taskId, '--dispatch-id', dispatchId);
      // worker_done/heartbeat 是精确 Dispatch 信号：按平台口径省略 --to；
      // 其余类型定向到本 Dispatch（调用者 --to 已剥除，禁组地址）。
      if (sendType !== 'worker_done' && sendType !== 'heartbeat') {
        cliArgs.push('--to', `dispatch:${dispatchId}`);
      }
    }
    execTrueCli(identity, cliArgs);
    return;
  }

  usage();
}

main().catch((err) => {
  process.stderr.write(`guard: 未预期失败: ${err.stack ?? String(err)}\n`);
  process.exit(5);
});
