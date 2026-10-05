/**
 * The /mcp endpoint: MCP's Streamable HTTP transport on top of Express.
 *
 * Authentication is the PrunerrXT API key, sent either as `X-Api-Key` or as
 * `Authorization: Bearer <key>`. There is no same-origin bypass here — an MCP
 * client is never the web UI, so every request has to carry the key.
 *
 * Sessions are stateful: a client's `initialize` creates a transport + server
 * pair that lives until the client sends DELETE, the connection closes, or it
 * sits idle for a while. That is what lets the server stream notifications.
 */
import { Router, type Request, type Response } from 'express';
import { randomUUID } from 'crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import logger from '../utils/logger';
import { getApiKey, isApiKeyEnabled, keysMatch, noteApiKeyUse } from '../middleware/apiAuth';
import { createMcpServer } from './server';
import { isMcpEnabled, mcpDisabledReason } from './config';
import { resolveAccessToken } from '../auth/oauthServer';
import { publicBaseUrl } from '../auth/oauthRoutes';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  createdAt: number;
  lastSeenAt: number;
}

const SESSION_IDLE_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

const sessions = new Map<string, McpSession>();
let sweeper: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeenAt < cutoff) {
        logger.debug(`MCP session ${id} idle, closing`);
        void session.transport.close().catch(() => undefined);
        sessions.delete(id);
      }
    }
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();
}

/** Number of live MCP client sessions, for the Settings panel. */
export function getActiveMcpSessionCount(): number {
  return sessions.size;
}

/** Close every session; used by tests and shutdown. */
export async function closeAllMcpSessions(): Promise<void> {
  const open = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(open.map((s) => s.transport.close()));
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

function jsonRpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Bearer credential from the Authorization header, or null. */
function bearerToken(req: Request): string | null {
  const authorization = req.headers['authorization'];
  if (typeof authorization !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  return match && match[1] ? match[1].trim() : null;
}

function challenge(req: Request, res: Response, error?: string): void {
  const metadata = `${publicBaseUrl(req)}/.well-known/oauth-protected-resource/mcp`;
  const parts = ['Bearer realm="prunerr-mcp"', `resource_metadata="${metadata}"`];
  if (error) parts.push(`error="${error}"`);
  res.setHeader('WWW-Authenticate', parts.join(', '));
}

/**
 * Who is calling. The API key (either header) acts as admin, as it does for
 * the REST API; an OAuth access token carries the role of the user who
 * approved the client. Returns null after writing the error response.
 */
function authenticate(req: Request, res: Response): AuthInfo | null {
  if (!isMcpEnabled()) {
    const reason = mcpDisabledReason();
    const message =
      reason === 'auth_disabled'
        ? 'The MCP connector is off because login is disabled (AUTH_ENABLED is not true). Enable login to use it.'
        : reason === 'env'
          ? 'The MCP connector is disabled by MCP_ENABLED=false.'
          : 'The MCP connector is turned off in Settings → System → AI assistant.';
    jsonRpcError(res, 403, -32000, message);
    return null;
  }

  const admin = (token: string): AuthInfo => ({ token, clientId: 'api-key', scopes: ['prunerr'], extra: { role: 'admin', username: 'API key', kind: 'apiKey' } });

  // The key switched off in Settings refuses key auth here too; OAuth
  // clients are unaffected, they never hold the key.
  const keyDisabled = (): null => {
    noteApiKeyUse(req, 'mcp', 'disabled');
    logger.warn(`MCP auth: API key presented while key access is disabled, from ${req.ip}`);
    challenge(req, res, 'invalid_token');
    jsonRpcError(res, 401, -32000, 'API key access is turned off in Settings → System → API key. Sign in through OAuth, or turn the key back on.');
    return null;
  };

  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim()) {
    if (!isApiKeyEnabled()) return keyDisabled();
    if (keysMatch(headerKey.trim(), getApiKey())) {
      noteApiKeyUse(req, 'mcp', 'ok');
      return admin(headerKey.trim());
    }
    noteApiKeyUse(req, 'mcp', 'invalid');
    logger.warn(`MCP auth: invalid API key from ${req.ip}`);
    challenge(req, res, 'invalid_token');
    jsonRpcError(res, 401, -32000, 'Invalid API key.');
    return null;
  }

  const bearer = bearerToken(req);
  if (!bearer) {
    challenge(req, res);
    jsonRpcError(
      res,
      401,
      -32000,
      'Authentication required: sign in through OAuth (see the resource_metadata in WWW-Authenticate) or send the PrunerrXT API key as "Authorization: Bearer <key>" or "X-Api-Key: <key>".'
    );
    return null;
  }

  if (keysMatch(bearer, getApiKey())) {
    if (!isApiKeyEnabled()) return keyDisabled();
    noteApiKeyUse(req, 'mcp', 'ok');
    return admin(bearer);
  }

  const resolved = resolveAccessToken(bearer);
  if (resolved) {
    return {
      token: bearer,
      clientId: resolved.clientId,
      scopes: [resolved.scope],
      expiresAt: Math.floor(new Date(resolved.expiresAt).getTime() / 1000),
      extra: { role: resolved.role, username: resolved.username, userKey: resolved.key, kind: 'oauth' },
    };
  }

  logger.warn(`MCP auth: invalid or expired bearer token from ${req.ip}`);
  challenge(req, res, 'invalid_token');
  jsonRpcError(res, 401, -32000, 'Invalid or expired token.');
  return null;
}

function sessionIdOf(req: Request): string | undefined {
  const raw = req.headers['mcp-session-id'];
  return typeof raw === 'string' && raw ? raw : undefined;
}

export function createMcpRouter(): Router {
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const authInfo = authenticate(req, res);
    if (!authInfo) return;
    (req as Request & { auth?: AuthInfo }).auth = authInfo;

    try {
      const sessionId = sessionIdOf(req);
      if (sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          jsonRpcError(res, 404, -32001, 'Session not found. Send a new initialize request.');
          return;
        }
        session.lastSeenAt = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (!isInitializeRequest(req.body)) {
        jsonRpcError(res, 400, -32000, 'Bad request: no Mcp-Session-Id header and not an initialize request.');
        return;
      }

      const server = createMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, createdAt: Date.now(), lastSeenAt: Date.now() });
          ensureSweeper();
          logger.info(`MCP session opened (${sessions.size} active)`);
        },
        onsessionclosed: (id) => {
          sessions.delete(id);
          logger.info(`MCP session closed (${sessions.size} active)`);
        },
      });
      transport.onclose = () => {
        const id = transport.sessionId;
        if (id && sessions.has(id)) {
          sessions.delete(id);
          logger.info(`MCP session dropped (${sessions.size} active)`);
        }
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      logger.error('MCP request failed:', error);
      if (!res.headersSent) {
        jsonRpcError(res, 500, -32603, 'Internal error');
      }
    }
  });

  const requireSession = async (req: Request, res: Response): Promise<void> => {
    const authInfo = authenticate(req, res);
    if (!authInfo) return;
    (req as Request & { auth?: AuthInfo }).auth = authInfo;
    const sessionId = sessionIdOf(req);
    const session = sessionId ? sessions.get(sessionId) : undefined;
    if (!session) {
      jsonRpcError(res, sessionId ? 404 : 400, -32001, sessionId ? 'Session not found.' : 'Missing Mcp-Session-Id header.');
      return;
    }
    session.lastSeenAt = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      logger.error('MCP request failed:', error);
      if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal error');
    }
  };

  // Server → client notification stream.
  router.get('/', requireSession);
  // Explicit session termination.
  router.delete('/', requireSession);

  return router;
}
