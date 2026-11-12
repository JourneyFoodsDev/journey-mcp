import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JourneyConfig } from './config.js';
import type { Logger } from './logger.js';
import { AuthError, JourneyError } from './errors.js';
import { isAppResource, type TokenVerifier } from './auth/oauth.js';
import type { ApiKeyResolver } from './auth/api-key.js';
import { anonymousAccount, type Account } from './auth/account.js';
import type { JourneyData } from './api/types.js';
import type { Enforcer } from './policy/enforcer.js';
import type { UsageSink } from './telemetry/usage-events.js';
import { createMcpServer } from './server.js';
import { metadataForRequestPath, metadataUrl, resourceForPath } from './apps/definitions.js';
import { createAppServer } from './apps/server.js';
import type { GuavaCatalog } from './apps/guava-catalog.js';
import { queryGuavaCatalog } from './apps/guava-http.js';
import type { AuthorizationServer } from './auth/authorization-server.js';

export interface HttpDeps {
  cfg: JourneyConfig;
  log: Logger;
  data: JourneyData;
  enforcer: Enforcer;
  usage?: UsageSink;
  verifier?: TokenVerifier;
  keys: ApiKeyResolver;
  guava?: GuavaCatalog;
  authServer?: AuthorizationServer;
}

declare module 'express-serve-static-core' {
  interface Request {
    journeyAccount?: Account;
    requestId?: string;
  }
}

const CORS_ORIGINS = new Set(['https://chatgpt.com', 'https://chat.openai.com']);

function corsHeaders(origin: string | undefined, self: string): Record<string, string> {
  if (!origin || (!CORS_ORIGINS.has(origin) && origin !== self)) return {};
  return { 'access-control-allow-origin': origin, 'access-control-allow-headers': 'authorization, content-type, accept, x-api-key, mcp-protocol-version', 'access-control-allow-methods': 'POST, GET, OPTIONS', vary: 'origin' };
}

/** Remote mode: Streamable HTTP at /mcp (stateless), plus two ChatGPT app endpoints. */
export function createHttpApp(deps: HttpDeps) {
  const { cfg, log } = deps;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(express.urlencoded({ extended: false }));

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    const started = Date.now();
    res.on('finish', () => log.info('http request', { id: req.requestId, method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - started, account: req.journeyAccount?.id }));
    next();
  });

  const selfOrigin = new URL(cfg.resourceUrl).origin;
  const guardOrigin = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.length && !cfg.allowedOrigins.includes(origin)) {
      res.status(403).json({ error: 'forbidden_origin' });
      return;
    }
    next();
  };
  app.use('/mcp', guardOrigin);
  app.use('/apps/journey-foods/mcp', guardOrigin);
  app.use('/apps/guava/mcp', guardOrigin);

  app.get('/.well-known/oauth-protected-resource', (req, res) => res.json(metadataForRequestPath(cfg, req.path)));
  app.get('/.well-known/oauth-protected-resource/*', (req, res) => res.json(metadataForRequestPath(cfg, req.path)));
  app.get('/healthz', (_req, res) => res.json({ ok: true }));

  if (deps.authServer) {
    const as = deps.authServer;
    const json = (res: Response, status: number, body: unknown, location?: string) => {
      if (location) {
        res.status(status).set('location', location).set('cache-control', 'no-store').end();
        return;
      }
      res.status(status).set('cache-control', 'no-store').json(body);
    };
    const meta = (_req: Request, res: Response) => json(res, 200, as.metadata());
    app.get('/.well-known/oauth-authorization-server', meta);
    app.get('/.well-known/openid-configuration', meta);
    app.get('/.well-known/jwks.json', async (_req, res) => json(res, 200, await as.jwks()));
    app.get('/oauth/jwks.json', async (_req, res) => json(res, 200, await as.jwks()));
    app.post('/oauth/register', async (req, res) => {
      const result = await as.register(req.body);
      json(res, result.status, result.body);
    });
    app.get('/oauth/authorize', async (req, res) => {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query)) if (typeof value === 'string') query.set(key, value);
      const result = await as.authorize(query);
      json(res, result.status, result.body, result.location);
    });
    app.post('/oauth/token', async (req, res) => {
      const params = new URLSearchParams();
      const body = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {};
      for (const [key, value] of Object.entries(body)) if (typeof value === 'string') params.set(key, value);
      const result = await as.token(params);
      json(res, result.status, result.body);
    });
    app.get('/oauth/userinfo', async (req, res) => {
      const result = await as.userinfo(req.header('authorization') ?? undefined);
      json(res, result.status, result.body);
    });
  }

  app.get('/.well-known/openai-apps-challenge', (_req, res) => {
    if (!cfg.openaiAppsChallenge) {
      res.status(404).set('cache-control', 'no-store').type('text/plain').send('not_configured');
      return;
    }
    res.status(200).set('cache-control', 'no-store').type('text/plain').send(cfg.openaiAppsChallenge);
  });

  const challenge = (res: Response, err: AuthError, resource: string) => {
    const scope = isAppResource(resource) ? 'catalog:read' : cfg.oauth.requiredScope;
    const errCode = err.code === 'insufficient_scope' ? 'insufficient_scope' : 'invalid_token';
    res
      .status(err.code === 'insufficient_scope' ? 403 : 401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl(cfg, resource)}", scope="${scope}"${err.code === 'missing_credentials' ? '' : `, error="${errCode}"`}`)
      .json({ error: err.code, message: err.message });
  };

  const authenticate = (resource: string, allowAnonymous: boolean) => async (req: Request, res: Response, next: NextFunction) => {
    try {
      const apiKey = req.header('x-api-key')?.trim();
      const authz = req.header('authorization');
      if (authz?.toLowerCase().startsWith('bearer ')) {
        if (!deps.verifier) throw new AuthError('OAuth is not configured on this server. Use an x-api-key header.', 'oauth_not_configured');
        req.journeyAccount = await deps.verifier.verify(authz.slice(7).trim(), resource);
      } else if (apiKey) {
        req.journeyAccount = await deps.keys.resolve(apiKey);
      } else if (allowAnonymous) {
        req.journeyAccount = anonymousAccount();
      } else {
        throw new AuthError('Sign in with Journey (OAuth) or send a Journey API key in the x-api-key header.', 'missing_credentials');
      }
      next();
    } catch (e) {
      if (e instanceof AuthError) return challenge(res, e, resource);
      log.error('auth failure', { error: (e as Error).message });
      res.status(503).json({ error: 'auth_unavailable', message: 'Authentication is temporarily unavailable.' });
    }
  };

  const serve = (kind: 'legacy' | 'journey-foods' | 'guava') => async (req: Request, res: Response) => {
    const account = req.journeyAccount!;
    const ua = req.get('user-agent') ?? undefined;
    const clientName = req.get('x-mcp-client-name') ?? undefined;
    const base = { account, data: deps.data, enforcer: deps.enforcer, log, usage: deps.usage, transport: 'http' as const, client: () => ({ name: clientName, userAgent: ua }), guava: deps.guava };
    const resource = resourceForPath(cfg, req.path);
    const server = kind === 'legacy' ? createMcpServer(base) : createAppServer(kind, base, metadataUrl(cfg, resource));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    const extra = kind === 'legacy' ? {} : corsHeaders(req.header('origin'), selfOrigin);
    for (const [key, value] of Object.entries(extra)) res.setHeader(key, value);
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
  };

  app.options('/apps/journey-foods/mcp', (req, res) => {
    res.status(204).set(corsHeaders(req.header('origin'), selfOrigin)).end();
  });
  app.options('/apps/guava/mcp', (req, res) => {
    res.status(204).set(corsHeaders(req.header('origin'), selfOrigin)).end();
  });

  const guavaCatalog = async (req: Request, res: Response) => {
    const resource = resourceForPath(cfg, '/apps/guava/mcp');
    let account: Account = anonymousAccount();
    const apiKey = req.header('x-api-key')?.trim();
    const authz = req.header('authorization');
    try {
      if (authz?.toLowerCase().startsWith('bearer ')) {
        if (!deps.verifier) throw new AuthError('OAuth is not configured on this server. Use an x-api-key header.', 'oauth_not_configured');
        account = await deps.verifier.verify(authz.slice(7).trim(), resource);
      } else if (apiKey) account = await deps.keys.resolve(apiKey);
    } catch (e) {
      if (e instanceof AuthError) return challenge(res, e, resource);
      throw e;
    }
    const url = new URL(req.originalUrl, selfOrigin);
    const result = await queryGuavaCatalog({ pathname: url.pathname, searchParams: url.searchParams, catalog: deps.guava, account });
    res.status(result?.status ?? 404).set('cache-control', 'no-store').json(result?.body ?? { error: 'not_found' });
  };
  app.use('/apps/guava/v1/products', (req, res, next) => {
    if (req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed' });
      return;
    }
    void guavaCatalog(req, res).catch(next);
  });

  app.post('/mcp', authenticate(cfg.resourceUrl, false), serve('legacy'));
  app.post('/apps/journey-foods/mcp', authenticate(resourceForPath(cfg, '/apps/journey-foods/mcp'), true), serve('journey-foods'));
  app.post('/apps/guava/mcp', authenticate(resourceForPath(cfg, '/apps/guava/mcp'), true), serve('guava'));

  const notAllowed = (_req: Request, res: Response) =>
    res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed. This server is stateless; use POST.' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);
  app.get('/apps/journey-foods/mcp', notAllowed);
  app.delete('/apps/journey-foods/mcp', notAllowed);
  app.get('/apps/guava/mcp', notAllowed);
  app.delete('/apps/guava/mcp', notAllowed);

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof JourneyError ? err.status : 500;
    log.error('unhandled', { error: (err as Error)?.message });
    res.status(status).json({ error: 'internal_error' });
  });
  return app;
}
