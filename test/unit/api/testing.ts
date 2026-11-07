/**
 * test/unit/api 共用测试设施：临时库 + 配置文件 + 随机端口真实 server，
 * 以及走 HTTP 的 call 助手与信断言助手。
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from '../../../src/db/database.ts';
import { startServer, type GovServer } from '../../../src/server.ts';

const configJson = {
  schemaVersion: 1,
  repos: [{ repoId: 'demo', hostPath: '/srv/repos/demo', targets: ['main', 'feat-x'] }],
  archiveRoot: '/tmp/gov-unit-api-archive',
};

export interface HostPaths {
  readonly dir: string;
  readonly dbPath: string;
  readonly configPath: string;
}

export interface TestHost {
  readonly server: GovServer;
  readonly baseUrl: string;
  /** 首启引导打印的 operator 明文令牌；重启（已有可用 operator）时为空串。 */
  readonly operatorToken: string;
  /** 测试用第二连接：埋任务/认领 fixtures、断言库内状态。 */
  readonly db: DatabaseSync;
  readonly paths: HostPaths;
  /** 关闭服务与第二连接；不删除临时目录（重启测试要复用路径）。 */
  close(): Promise<void>;
  /** close + 删除临时目录。 */
  dispose(): Promise<void>;
}

export function createHostPaths(): HostPaths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov-api-test-'));
  return {
    dir,
    dbPath: path.join(dir, 'gov.db'),
    configPath: path.join(dir, 'gov.config.json'),
  };
}

/** 启动宿主并捕获启动日志里的引导令牌（OPERATOR_TOKEN_ONCE 只打印一次）。 */
export async function bootHost(paths: HostPaths): Promise<TestHost> {
  fs.writeFileSync(paths.configPath, JSON.stringify(configJson), 'utf8');

  const logs: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(' '));
  };
  let server: GovServer;
  try {
    server = await startServer({ dbPath: paths.dbPath, configPath: paths.configPath, port: 0 });
  } finally {
    console.log = originalLog;
  }
  const operatorToken =
    logs.join('\n').match(/OPERATOR_TOKEN_ONCE: (govt_[A-Za-z0-9_-]+)/)?.[1] ?? '';

  const db = openDatabase(paths.dbPath);
  let closed = false;
  const host: TestHost = {
    server,
    baseUrl: `http://127.0.0.1:${server.port}`,
    operatorToken,
    db,
    paths,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await server.close();
      db.close();
    },
    async dispose() {
      await host.close();
      fs.rmSync(paths.dir, { recursive: true, force: true });
    },
  };
  return host;
}

export async function startTestHost(): Promise<TestHost> {
  return bootHost(createHostPaths());
}

export interface CallOptions {
  readonly token?: string;
  readonly requestId?: string;
  readonly action?: string;
  readonly payload?: unknown;
  /** 完全控制请求体字节（非法 JSON / 超大请求用）。 */
  readonly rawBody?: string;
  readonly method?: string;
  readonly path?: string;
  readonly contentType?: string;
  readonly authorization?: string;
}

export interface CallResult {
  readonly status: number;
  readonly body: unknown;
}

export async function call(host: TestHost, options: CallOptions): Promise<CallResult> {
  const headers: Record<string, string> = {
    'content-type': options.contentType ?? 'application/json',
  };
  if (options.authorization !== undefined) {
    headers.authorization = options.authorization;
  } else if (options.token !== undefined) {
    headers.authorization = `Bearer ${options.token}`;
  }
  const body =
    options.rawBody ??
    JSON.stringify({
      requestId: options.requestId ?? `req-${randomUUID()}`,
      action: options.action ?? 'doctor',
      payload: options.payload ?? {},
    });

  const method = options.method ?? 'POST';
  const response = await fetch(`${host.baseUrl}${options.path ?? '/api/call'}`, {
    method,
    headers,
    // GET/HEAD 带 body 会被 fetch 直接拒绝，路由测试只需方法与路径。
    ...(method === 'GET' || method === 'HEAD' ? {} : { body }),
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status, body: parsed };
}

interface ErrorEnvelope {
  ok: boolean;
  error?: { code: string; message: string };
}

export function expectError(result: CallResult, code: string, httpStatus?: number): void {
  assert.ok(
    result.body !== null && typeof result.body === 'object',
    `预期错误信封，实际: ${JSON.stringify(result.body)}`,
  );
  const envelope = result.body as ErrorEnvelope;
  assert.equal(envelope.ok, false, `预期错误信封，实际: ${JSON.stringify(result.body)}`);
  assert.equal(
    envelope.error?.code,
    code,
    `预期错误码 ${code}，实际: ${JSON.stringify(result.body)}`,
  );
  if (httpStatus !== undefined) {
    assert.equal(result.status, httpStatus, `预期 HTTP ${httpStatus}，实际 ${result.status}`);
  }
}

export function expectOk(result: CallResult): Record<string, unknown> {
  assert.equal(result.status, 200, `预期 HTTP 200，实际 ${result.status}: ${JSON.stringify(result.body)}`);
  assert.ok(
    result.body !== null && typeof result.body === 'object',
    `预期成功信封，实际: ${JSON.stringify(result.body)}`,
  );
  const envelope = result.body as { ok: boolean; result?: unknown };
  assert.equal(envelope.ok, true, `预期成功信封，实际: ${JSON.stringify(result.body)}`);
  assert.ok(
    envelope.result !== null && typeof envelope.result === 'object',
    `预期 result 为对象，实际: ${JSON.stringify(envelope.result)}`,
  );
  return envelope.result as Record<string, unknown>;
}
