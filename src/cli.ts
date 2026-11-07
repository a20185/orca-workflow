/**
 * gov 命令行客户端：只经 HTTP 调宿主 JSON API（POST /api/call），不开库、
 * 不派生进程、不做任何交互。输出统一为 JSON 信封；ok:false 时退出码 1。
 *
 * 令牌来源：--token 或环境变量 GOV_TOKEN（客户端不能也不需要自行指定身份，
 * 身份完全由令牌决定）。
 */
import { randomUUID } from 'node:crypto';

const USAGE = `用法：
  gov doctor [--base-url URL] [--token T]
  gov status --task <taskId> [--base-url URL] [--token T]
  gov call <action> --payload-json '<json>' [--base-url URL] [--token T]

通用：
  --base-url   宿主地址，默认 http://127.0.0.1:7788（也可用 GOV_BASE_URL）
  --token      Bearer 令牌（也可用环境变量 GOV_TOKEN）`;

class CliUsageError extends Error {}

interface ParsedArgs {
  readonly flags: Map<string, string>;
  readonly positionals: string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? '';
    if (arg.startsWith('--')) {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new CliUsageError(`标志 ${arg} 缺少取值\n${USAGE}`);
      }
      flags.set(arg.slice(2), value);
      i += 1;
    } else {
      positionals.push(arg);
    }
  }
  return { flags, positionals };
}

function buildRequest(flags: Map<string, string>, positionals: readonly string[]): { action: string; payload: unknown } {
  const command = positionals[0];
  if (command === 'doctor') {
    return { action: 'doctor', payload: {} };
  }
  if (command === 'status') {
    const task = flags.get('task');
    if (task === undefined) {
      throw new CliUsageError(`gov status 需要 --task <taskId>\n${USAGE}`);
    }
    return { action: 'status', payload: { taskId: task } };
  }
  if (command === 'call') {
    const action = positionals[1];
    if (action === undefined) {
      throw new CliUsageError(`gov call 需要 <action>\n${USAGE}`);
    }
    const payloadJson = flags.get('payload-json');
    if (payloadJson === undefined) {
      throw new CliUsageError(`gov call 需要 --payload-json '<json>'\n${USAGE}`);
    }
    let payload: unknown;
    try {
      payload = JSON.parse(payloadJson);
    } catch (err) {
      throw new CliUsageError(`--payload-json 不是合法 JSON: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new CliUsageError('--payload-json 必须是 JSON 对象');
    }
    return { action, payload };
  }
  throw new CliUsageError(USAGE);
}

async function main(): Promise<number> {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  const { action, payload } = buildRequest(flags, positionals);

  const token = flags.get('token') ?? process.env['GOV_TOKEN'];
  if (token === undefined || token.length === 0) {
    throw new CliUsageError(`缺少令牌：--token 或环境变量 GOV_TOKEN\n${USAGE}`);
  }
  const baseUrl = (flags.get('base-url') ?? process.env['GOV_BASE_URL'] ?? 'http://127.0.0.1:7788').replace(
    /\/+$/,
    '',
  );

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/api/call`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ requestId: randomUUID(), action, payload }),
    });
  } catch (err) {
    console.error(`请求失败（宿主未启动？${baseUrl}）: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }

  const text = await response.text();
  let envelope: unknown;
  try {
    envelope = JSON.parse(text);
  } catch {
    console.error(`宿主返回非 JSON 响应（HTTP ${response.status}）: ${text.slice(0, 200)}`);
    return 1;
  }
  console.log(JSON.stringify(envelope, null, 2));
  const ok = (envelope as { ok?: unknown }).ok;
  return ok === true ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof CliUsageError) {
      console.error(err.message);
      process.exitCode = 2;
      return;
    }
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
