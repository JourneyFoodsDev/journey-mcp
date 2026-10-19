export interface JourneyConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  supplierApiBaseUrl?: string;
  /** Journey app API (products of the signed-in user). Defaults to the supplier API base URL. */
  appApiBaseUrl?: string;
  priceApiBaseUrl?: string;
  priceApiKey?: string;
  supplierApiKey?: string;
  labsVerifyPath?: string;
  /** Journey Labs API base. Defaults to the app API base. */
  labsApiBaseUrl?: string;
  /** Service key for the paid-tier PDF link endpoint. Never sent anywhere else. */
  labsServiceKey?: string;
  keyLookupUrl?: string;
  policyFile?: string;
  usageStore: 'memory' | 'file';
  usageFile: string;
  port: number;
  host: string;
  resourceUrl: string;
  allowedOrigins: string[];
  oauth: {
    issuer?: string;
    jwksUrl?: string;
    introspectionUrl?: string;
    introspectionClientId?: string;
    introspectionClientSecret?: string;
    requiredScope: string;
    accountClaim: string;
    tierClaim: string;
  };
  requestTimeoutMs: number;
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

/** Base URLs and keys come only from the environment. Nothing secret is hardcoded. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): JourneyConfig {
  const apiBaseUrl = blank(env.JOURNEY_API_BASE_URL)?.replace(/\/+$/, '');
  const port = Number(env.PORT || 3000);
  const apiKey = blank(env.JOURNEY_API_KEY);
  const supplierApiBaseUrl = blank(env.JOURNEY_SUPPLIER_API_BASE_URL)?.replace(/\/+$/, '') ?? apiBaseUrl;
  const priceApiBaseUrl = blank(env.JOURNEY_PRICE_API_BASE_URL)?.replace(/\/+$/, '') ?? apiBaseUrl;
  return {
    apiBaseUrl,
    apiKey,
    supplierApiBaseUrl,
    appApiBaseUrl: blank(env.JOURNEY_APP_API_BASE_URL)?.replace(/\/+$/, '') ?? supplierApiBaseUrl,
    priceApiBaseUrl,
    // A key is only sent to the service it belongs to: never forward the main key to a different base URL.
    priceApiKey: blank(env.JOURNEY_PRICE_API_KEY) ?? (priceApiBaseUrl === apiBaseUrl ? apiKey : undefined),
    supplierApiKey: blank(env.JOURNEY_SUPPLIER_API_KEY) ?? (supplierApiBaseUrl === apiBaseUrl ? apiKey : undefined),
    labsVerifyPath: blank(env.JOURNEY_LABS_VERIFY_PATH),
    labsApiBaseUrl: blank(env.JOURNEY_LABS_API_BASE_URL)?.replace(/\/+$/, '') ?? blank(env.JOURNEY_APP_API_BASE_URL)?.replace(/\/+$/, '') ?? supplierApiBaseUrl,
    labsServiceKey: blank(env.JOURNEY_LABS_SERVICE_KEY),
    keyLookupUrl: blank(env.JOURNEY_KEY_LOOKUP_URL),
    policyFile: blank(env.JOURNEY_POLICY_FILE),
    usageStore: env.JOURNEY_USAGE_STORE === 'file' ? 'file' : 'memory',
    usageFile: blank(env.JOURNEY_USAGE_FILE) ?? '.journey-mcp-usage.json',
    port,
    host: blank(env.HOST) ?? '127.0.0.1',
    resourceUrl: blank(env.MCP_RESOURCE_URL) ?? `http://localhost:${port}/mcp`,
    allowedOrigins: (env.MCP_ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    oauth: {
      issuer: blank(env.OAUTH_ISSUER),
      jwksUrl: blank(env.OAUTH_JWKS_URL),
      introspectionUrl: blank(env.OAUTH_INTROSPECTION_URL),
      introspectionClientId: blank(env.OAUTH_INTROSPECTION_CLIENT_ID),
      introspectionClientSecret: blank(env.OAUTH_INTROSPECTION_CLIENT_SECRET),
      requiredScope: blank(env.OAUTH_REQUIRED_SCOPE) ?? 'journey:read',
      accountClaim: blank(env.OAUTH_ACCOUNT_CLAIM) ?? 'journey_account_id',
      tierClaim: blank(env.OAUTH_TIER_CLAIM) ?? 'journey_tier',
    },
    requestTimeoutMs: Number(env.JOURNEY_REQUEST_TIMEOUT_MS || 15000),
  };
}
