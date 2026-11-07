/**
 * 宿主 JSON API 服务：只绑 127.0.0.1 的单端点 POST /api/call（默认端口 7788）。
 * 请求信封 { requestId, action, payload } strict 校验；Bearer 令牌鉴权；
 * requestId 幂等 + 请求哈希防漂移；请求体 1 MiB 上限；处理超时 30s。
 *
 * 本模块与 api.ts / auth.ts / operations.ts 在整条调用链上禁止
 * import node:child_process——请求中的任何文本（action、payload 字段）都只
 * 作为数据查库或分发，绝不拼成 shell 命令或路径执行；这也是「数据库事务中
 * 不调用外部进程」约束在宿主面的落法。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { assertRuntime, loadConfig, type GovConfig } from './config.ts';
import { openDatabase } from './db/database.ts';
import { migrate } from './db/migrations.ts';
import { formatZodIssues, GovError, type GovErrorCode } from './domain/errors.ts';
import { GOV_ACTIONS_BY_ROLE } from './domain/roles.ts';
import { authenticate, issueToken } from './auth.ts';
import {
  beginOperation,
  canonicalRequestHash,
  finalizeOperation,
  MAX_REQUEST_BYTES,
  type BeginOperationResult,
  type StoredReceipt,
} from './operations.ts';
import type { TokenInfo } from './auth.ts';
import {
  createHandlerRegistry,
  isValidActionName,
  registerCoreHandlers,
  type ActionContext,
  type ActionHandler,
  type HandlerRegistry,
} from './api.ts';

export const DEFAULT_PORT = 7788;
const REQUEST_TIMEOUT_MS = 30_000;
/** 超限后的排空硬上限：丢弃超大数据时直接断连，避免无限接收。 */
const MAX_DRAIN_BYTES = 64 * 1024 * 1024;

const envelopeSchema = z.strictObject({
  requestId: z.string().min(1),
  action: z.string().min(1),
  payload: z.looseObject({}),
});

export interface StartServerOptions {
  readonly dbPath: string;
  readonly configPath: string;
  /** 0 表示由操作系统分配随机端口（测试用）。 */
  readonly port?: number | undefined;
}

export interface GovServer {
  readonly port: number;
  close(): Promise<void>;
}

interface RequestDeps {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly config: GovConfig;
  readonly configPath: string;
  readonly registry: HandlerRegistry;
}

export async function startServer(options: StartServerOptions): Promise<GovServer> {
  assertRuntime();
  const config = await loadConfig(options.configPath);
  const db = openDatabase(options.dbPath);
  migrate(db);

  // 引导：无可用（未吊销）operator 令牌时生成一个并只在启动日志打印一次。
  // 引导令牌显式附带 token-issue——§9.1 operator 动作集不含它，缺了它
  // 首启之后没有任何途径再签发新令牌。已吊销的 operator 令牌不算可用，
  // 否则吊销会把整个 operator 角色永久锁死。
  const hasOperator = db
    .prepare(
      "SELECT 1 AS hit FROM capabilities WHERE role = 'operator' AND revoked_at IS NULL LIMIT 1",
    )
    .get();
  if (hasOperator === undefined) {
    const issued = issueToken(db, {
      role: 'operator',
      actions: ['token-issue', ...GOV_ACTIONS_BY_ROLE.operator],
    });
    console.log(`OPERATOR_TOKEN_ONCE: ${issued.token}`);
  }

  const registry = createHandlerRegistry();
  registerCoreHandlers(registry, { config, configPath: options.configPath });

  const server = createServer((req, res) => {
    void handleRequest(req, res, {
      db,
      dbPath: options.dbPath,
      config,
      configPath: options.configPath,
      registry,
    });
  });

  await listenLoopback(server, options.port ?? DEFAULT_PORT);
  const address = server.address();
  if (address === null || typeof address === 'string') {
    db.close();
    throw new Error('监听后无法取得端口');
  }

  let closed = false;
  return {
    port: address.port,
    close: () => {
      // 幂等：重复 close（如测试 finally 兜底）不得抛错。
      if (closed) {
        return Promise.resolve();
      }
      closed = true;
      return closeServer(server, db);
    },
  };
}

function listenLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
}

function closeServer(server: Server, db: DatabaseSync): Promise<void> {
  return new Promise((resolve, reject) => {
    // 先断开保活连接（fetch/undici 默认保持连接），否则 close() 会一直等。
    server.closeIdleConnections();
    server.closeAllConnections();
    server.close((err) => {
      db.close();
      if (err !== undefined) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, deps: RequestDeps): Promise<void> {
  try {
    await routeRequest(req, res, deps);
  } catch (err) {
    // 兜底：任何未预期异常不裸抛给 http 层，也不泄漏内部细节。
    console.error('请求处理未预期失败:', err);
    if (!res.headersSent) {
      respond(res, 500, errorBody('E_REQUEST_INVALID', '内部错误'));
    } else {
      res.destroy();
    }
  }
}

async function routeRequest(req: IncomingMessage, res: ServerResponse, deps: RequestDeps): Promise<void> {
  const path = requestPath(req);
  if (path !== '/api/call') {
    respond(res, 404, errorBody('E_REQUEST_INVALID', `未知路由: ${req.method ?? '?'} ${path}`));
    return;
  }
  if (req.method !== 'POST') {
    respond(res, 405, errorBody('E_REQUEST_INVALID', '只接受 POST /api/call'));
    return;
  }
  if (!isJsonContentType(req)) {
    respond(res, 400, errorBody('E_REQUEST_INVALID', 'Content-Type 必须是 application/json'));
    return;
  }

  const body = await readBody(req);
  if (body.tooLarge) {
    respondAndClose(res, 413, errorBody('E_PAYLOAD_TOO_LARGE', `请求体超过 ${MAX_REQUEST_BYTES} 字节上限`));
    return;
  }

  let json: unknown;
  try {
    json = JSON.parse(body.text);
  } catch {
    respond(res, 400, errorBody('E_REQUEST_INVALID', '请求体不是合法 JSON'));
    return;
  }
  const envelopeParsed = envelopeSchema.safeParse(json);
  if (!envelopeParsed.success) {
    respond(
      res,
      400,
      errorBody('E_REQUEST_INVALID', `请求信封校验失败: ${formatZodIssues(envelopeParsed.error)}`),
    );
    return;
  }
  const envelope = envelopeParsed.data;

  // 未知动作名在鉴权前拒绝：与「契约内未注册」的 E_ACTION_UNIMPLEMENTED 区分。
  if (!isValidActionName(envelope.action)) {
    respond(res, 400, errorBody('E_REQUEST_INVALID', `未知 action: ${envelope.action}`));
    return;
  }

  const token = bearerToken(req);
  if (token === undefined) {
    respond(res, 401, errorBody('E_UNAUTHENTICATED', '缺少 Authorization: Bearer <token>'));
    return;
  }

  let tokenInfo: TokenInfo;
  try {
    // 请求侧任务归属只从 payload.taskId 读取，且仅用于与令牌绑定比对；
    // payload 里的 session_id 等自报身份字段永不参与判定。
    tokenInfo = authenticate(deps.db, token, {
      action: envelope.action,
      taskId: readClaimedTaskId(envelope.payload),
    });
  } catch (err) {
    if (err instanceof GovError) {
      respond(res, httpStatusFor(err.code), errorBody(err.code, err.message));
      return;
    }
    throw err;
  }

  const handler = deps.registry.lookup(envelope.action);
  if (handler === undefined) {
    respond(res, 501, errorBody('E_ACTION_UNIMPLEMENTED', `动作已契约化但尚未实现: ${envelope.action}`));
    return;
  }

  const requestHash = canonicalRequestHash(envelope.requestId, envelope.action, envelope.payload);
  let begin: BeginOperationResult;
  try {
    begin = beginOperation(deps.db, {
      requestId: envelope.requestId,
      requestHash,
      kind: envelope.action,
    });
  } catch (err) {
    if (err instanceof GovError) {
      respond(res, httpStatusFor(err.code), errorBody(err.code, err.message));
      return;
    }
    throw err;
  }

  if (begin.type === 'replay') {
    const receipt: StoredReceipt =
      begin.receipt ?? {
        httpStatus: 500,
        body: errorBody('E_REQUEST_INVALID', `上次调用（${begin.status}）无回执，请换新 requestId`),
      };
    respond(res, receipt.httpStatus, receipt.body);
    return;
  }
  if (begin.type === 'in_flight') {
    respond(res, 400, errorBody('E_REQUEST_INVALID', `同 requestId 请求正在处理中: ${envelope.requestId}`));
    return;
  }

  const outcome = await executeWithTimeout(handler, {
    db: deps.db,
    dbPath: deps.dbPath,
    config: deps.config,
    configPath: deps.configPath,
    token: tokenInfo,
    payload: envelope.payload,
  });

  if (outcome.kind === 'ok') {
    // 活响应给明文（如 token-issue 的新令牌）；回执落库时统一机械遮蔽。
    finalizeOperation(deps.db, begin.operationId, 'CONFIRMED', {
      httpStatus: 200,
      body: { ok: true, result: outcome.result },
    });
    respond(res, 200, { ok: true, result: outcome.result });
    return;
  }
  if (outcome.kind === 'gov-error') {
    const status = httpStatusFor(outcome.code);
    const errorEnvelope = errorBody(outcome.code, outcome.message);
    finalizeOperation(
      deps.db,
      begin.operationId,
      'FAILED',
      { httpStatus: status, body: errorEnvelope },
      outcome.code,
    );
    respond(res, status, errorEnvelope);
    return;
  }
  if (outcome.kind === 'internal') {
    console.error('动作执行未预期失败:', outcome.error);
    const errorEnvelope = errorBody('E_REQUEST_INVALID', '内部错误');
    finalizeOperation(
      deps.db,
      begin.operationId,
      'FAILED',
      { httpStatus: 500, body: errorEnvelope },
      'E_REQUEST_INVALID',
    );
    respond(res, 500, errorEnvelope);
    return;
  }
  // 超时：结果不确定，记 UNCERTAIN；迟到完成由 executeWithTimeout 丢弃。
  const errorEnvelope = errorBody('E_TIMEOUT', `处理超时（${REQUEST_TIMEOUT_MS / 1000}s）`);
  finalizeOperation(deps.db, begin.operationId, 'UNCERTAIN', { httpStatus: 504, body: errorEnvelope }, 'E_TIMEOUT');
  respond(res, 504, errorEnvelope);
}

function requestPath(req: IncomingMessage): string {
  const url = req.url ?? '/';
  return url.split('?')[0] ?? url;
}

function isJsonContentType(req: IncomingMessage): boolean {
  const raw = req.headers['content-type'];
  if (typeof raw !== 'string') {
    return false;
  }
  const mediaType = raw.split(';')[0]?.trim().toLowerCase();
  return mediaType === 'application/json';
}

interface ReadBodyResult {
  readonly tooLarge: boolean;
  readonly text: string;
}

function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    let tooLarge = false;
    let cutByLimit = false;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > MAX_REQUEST_BYTES) {
        tooLarge = true;
        // 继续丢弃剩余字节让客户端发完，避免其对侧挂起；恶意超量则直接断连。
        if (received > MAX_DRAIN_BYTES) {
          cutByLimit = true;
          req.destroy();
        }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      resolve({ tooLarge, text: Buffer.concat(chunks).toString('utf8') });
    });
    req.on('error', (err) => {
      if (cutByLimit) {
        resolve({ tooLarge: true, text: '' });
        return;
      }
      reject(err);
    });
  });
}

function bearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== 'string') {
    return undefined;
  }
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1];
}

function readClaimedTaskId(payload: Record<string, unknown>): string | undefined {
  const taskId = payload['taskId'];
  return typeof taskId === 'string' && taskId.length > 0 ? taskId : undefined;
}

type HandlerOutcome =
  | { readonly kind: 'ok'; readonly result: unknown }
  | { readonly kind: 'gov-error'; readonly code: GovErrorCode; readonly message: string }
  | { readonly kind: 'internal'; readonly error: unknown }
  | { readonly kind: 'timeout' };

function executeWithTimeout(handler: ActionHandler, ctx: ActionContext): Promise<HandlerOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      resolve({ kind: 'timeout' });
    }, REQUEST_TIMEOUT_MS);
    Promise.resolve()
      .then(() => handler(ctx))
      .then(
        (result) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve({ kind: 'ok', result });
          }
        },
        (err: unknown) => {
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve(
              err instanceof GovError
                ? { kind: 'gov-error', code: err.code, message: err.message }
                : { kind: 'internal', error: err },
            );
          }
          // 超时后迟到的完成/失败：操作已记 UNCERTAIN，结果丢弃（防未处理拒绝）。
        },
      );
  });
}

function httpStatusFor(code: GovErrorCode): number {
  switch (code) {
    case 'E_UNAUTHENTICATED':
      return 401;
    case 'E_FORBIDDEN_ACTION':
    case 'E_TOKEN_EXPIRED':
      return 403;
    case 'E_NOT_FOUND':
      return 404;
    case 'E_PAYLOAD_TOO_LARGE':
      return 413;
    case 'E_ACTION_UNIMPLEMENTED':
      return 501;
    case 'E_TIMEOUT':
      return 504;
    default:
      // 其余契约类错误（信封/哈希/领域校验）统一 400，客户端以信封 code 为准。
      return 400;
  }
}

function errorBody(code: GovErrorCode, message: string): { ok: false; error: { code: GovErrorCode; message: string } } {
  return { ok: false, error: { code, message } };
}

function respond(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function respondAndClose(res: ServerResponse, status: number, body: unknown): void {
  res.setHeader('Connection', 'close');
  respond(res, status, body);
}
