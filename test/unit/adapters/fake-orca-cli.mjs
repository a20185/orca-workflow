#!/usr/bin/env node
// 单测假 Orca CLI（worker-start 失败通道读回重建专用）：按场景 JSON 应答，
// 不依赖真实 Orca 桌面。场景文件路径经 GOV_FAKE_ORCA_SCENARIO 注入，键为动词
// （'status' / 'orchestration worker-start' / 'orchestration worker-show'），
// 规则形如 { envelope, exitCode? }：把 envelope 以 JSON 写到 stdout 并按
// exitCode 退出（缺省 0）。每次调用把完整 argv 以 JSON 行追加到
// GOV_FAKE_ORCA_LOG 指定的文件，供测试断言「读回是否发生 / 是否未发生」。
// 未命中规则：stderr 提示并以退出码 3 结束（测试据此发现意外调用）。
import { appendFileSync, readFileSync } from 'node:fs';

const scenarioPath = process.env.GOV_FAKE_ORCA_SCENARIO ?? '';
const logPath = process.env.GOV_FAKE_ORCA_LOG ?? '';
const argv = process.argv.slice(2);
const verb = argv[0] === 'orchestration' ? argv.slice(0, 2).join(' ') : argv[0];
if (logPath !== '') {
  appendFileSync(logPath, `${JSON.stringify(argv)}\n`);
}
if (scenarioPath === '') {
  process.stderr.write('GOV_FAKE_ORCA_SCENARIO not set\n');
  process.exitCode = 3;
} else {
  const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
  const rule = scenario[verb];
  if (rule === undefined) {
    process.stderr.write(`no scenario rule for verb: ${verb}\n`);
    process.exitCode = 3;
  } else {
    process.stdout.write(JSON.stringify(rule.envelope));
    process.exitCode = rule.exitCode ?? 0;
  }
}
