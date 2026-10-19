import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JourneyConfig } from './config.js';
import type { Logger } from './logger.js';
import { AuthError, JourneyError } from './errors.js';
import { protectedResourceMetadata, type TokenVerifier } from './auth/oauth.js';
import type { ApiKeyResolver } from './auth/api-key.js';
import type { Account } from './auth/account.js';
import type { JourneyData } from './api/types.js';
import type { Enforcer } from './policy/enforcer.js';
import type { UsageSink } from './telemetry/usage-events.js';
import { createMcpServer } from './server.js';

export interface HttpDeps {
  cfg: JourneyConfig;
  log: Logger;
  data: JourneyData;
  enforcer: Enforcer;
  usage?: UsageSink;
  verifier?: TokenVerifier;
  keys: ApiKeyResolver;
}

declare module 'express-serve-static-core' {
  interface Request {
    journeyAccount?: Account;
    requestId?: string;
  }
}

/** Remote mode: Streamable HTTP at /mcp (stateless), OAuth 2.1 bearer tokens with x-api-key fallback. */
export function createHttpApp(deps: HttpDeps) {
  const { cfg, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));

  const metadataUrl = new URL('/.well-known/oauth-protected-resource' + new URL(cfg.resourceUrl).pathname, cfg.resourceUrl).toString();

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    const started = Date.now();
    res.on('finish', () => log.info('http request', { id: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, account: req.journeyAccount?.id }));
    next();
  });

  // DNS rebinding protection (MCP transport security): reject unexpected browser origins.
  app.use('/mcp', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'forbidden_origin' });
      return;
    }
    next();
  });

  const prm = (_req: Request, res: Response) => res.json(protectedResourceMetadata(cfg));
  app.get('/.well-known/oauth-protected-resource', prm);
  app.get('/.well-known/oauth-protected-resource/*', prm);
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  const challenge = (res: Response, err: AuthError) => {
    const scope = cfg.oauth.requiredScope;
    const errCode = err.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token';
    res
      .status(err.code === 'insufficient_scope' ? 403 : 401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}", scope="${scope}"${err.code === 'missing_credentials' ? '' : `, error="${errCode}"`}`)
      .json({ error: err.code, message: err.message });
  };

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = req.header('x-api-key');
      const authz = req.header('authorization');
      if (authz?.toLowerCase().startsWith('bearer ')) {
        if (!deps.verifier) throw new AuthError('OAuth is not configured on this server. Use an x-api-key header.', 'oauth_not_configured');
        req.journeyAccount = await deps.verifier.verify(authz.slice(7).trim());
      } else if (apiKey) {
        req.journeyAccount = await deps.keys.resolve(apiKey.trim());
      } else {
        throw new AuthError('Sign in with Journey (OAuth) or send a Journey API key in the x-api-key header.', 'missing_credentials');
      }
      next();
    } catch (e) {
      if (e instanceof AuthError) return challenge(res, e);
      log.error('auth failure', { error: (e as Error).message });
      res.status(503).json({ error: 'auth_unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  };

  app.post('/mcp', authenticate, async (req, res) => {
    const account = req.journeyAccount!;
    const ua = req.get('user-agent') ?? undefined;
    // Clients that send their MCP clientInfo name on every request (x-mcp-client-name is non-standard) are labelled by it.
    const clientName = req.get('x-mcp-client-name') ?? undefined;
    const server = createMcpServer({ account, data: deps.data, enforcer: deps.enforcer, log, usage: deps.usage, transport: 'http', client: () => ({ name: clientName, userAgent: ua }) });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      log.error('mcp request failed', { id: req.requestId, error: (e as Error).message });
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  });

  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof JourneyError ? err.status : 500;
    log.error('unhandled', { error: (err as Error)?.message });
    res.status(status).json({ error: 'internal_error' });
  });
  return app;
}
