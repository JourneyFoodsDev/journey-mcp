export interface JourneyConfig {
  apiBaseUrl?: string;
  apiKey?: string;
  supplierApiBaseUrl?: string;
  /** Journey app API (products of the signed-in user). Defaults to the supplier API base URL. */
  appApiBaseUrl?: string;
  priceApiBaseUrl?: string;
  priceApiKey?: string;
  /** Unused. A user key is never sent to the supplier backend as x-api-key. */
  supplierApiKey?: string;
  /** Explicit JOURNEY_SUPPLIER_API_KEY. Sent as x-journey-service-key, never as x-api-key. */
  supplierServiceKey?: string;
  /** HMAC key for x-journey-end-user. Missing → those headers are not sent. */
  endUserSigningSecret?: string;
  /** Price feed base used for GET /api/v1/account. Unset → API keys fall back to a key hash. */
  priceAccountBaseUrl?: string;
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
    userClaim: string;
    companyClaim: string;
    statusClaim: string;
    roleClaim: string;
  };
  requestTimeoutMs: number;
}

const blank = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);
const strip = (v: string | undefined) => blank(v)?.replace(/\/+$/, '');

/**
 * Public production bases. These are not secrets.
 * Ingredients use the developer API (x-api-key). Prices use the price feed (/api/v1/commodities).
 * Those two APIs issue different keys. Supplier profiles live only on an internal backend that
 * needs a service key, so there is no default supplier URL and a user's key is never sent there.
 */
export const DEFAULT_DEV_API_BASE_URL = 'https://devapi.journeyfoods.io';
export const DEFAULT_PRICE_API_BASE_URL = 'https://price.journeyfoods.io';
/** Hosted Streamable HTTP server from the README. Supplier profiles are served here, not by a public REST route. */
export const HOSTED_MCP_URL = 'https://mcp.journeyfoods.io/mcp';
export const DEV_API_KEY_URL = 'https://dev.journeyfoods.io';
export const PRICE_API_KEY_URL = 'https://price.journeyfoods.io';

/** Public base URLs have defaults. Keys come only from the environment; nothing secret is hardcoded. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): JourneyConfig {
  const explicitApiBase = strip(env.JOURNEY_API_BASE_URL);
  const explicitSupplierBase = strip(env.JOURNEY_SUPPLIER_API_BASE_URL);
  const explicitPriceBase = strip(env.JOURNEY_PRICE_API_BASE_URL);
  const apiBaseUrl = explicitApiBase ?? DEFAULT_DEV_API_BASE_URL;
  const priceApiBaseUrl = explicitPriceBase ?? DEFAULT_PRICE_API_BASE_URL;
  // Supplier profiles are only on the internal backend. Never inherit the developer or price URL.
  const supplierApiBaseUrl = explicitSupplierBase;
  const port = Number(env.PORT || 3000);
  const apiKey = blank(env.JOURNEY_API_KEY);
  const supplierServiceKey = blank(env.JOURNEY_SUPPLIER_API_KEY);
  return {
    apiBaseUrl,
    apiKey,
    supplierApiBaseUrl,
    appApiBaseUrl: strip(env.JOURNEY_APP_API_BASE_URL) ?? supplierApiBaseUrl,
    priceApiBaseUrl,
    // A key is only sent to the service that issued it. The price feed key is not a developer API key.
    priceApiKey: blank(env.JOURNEY_PRICE_API_KEY) ?? (priceApiBaseUrl === apiBaseUrl ? apiKey : undefined),
    // Service key only (x-journey-service-key). JOURNEY_API_KEY and JOURNEY_PRICE_API_KEY are never sent here.
    supplierServiceKey,
    supplierApiKey: undefined,
    endUserSigningSecret: blank(env.JOURNEY_END_USER_SIGNING_SECRET),
    // Do not probe for a price-feed account unless a price base or price key is configured.
    priceAccountBaseUrl: explicitPriceBase ?? (blank(env.JOURNEY_PRICE_API_KEY) ? priceApiBaseUrl : undefined),
    labsVerifyPath: blank(env.JOURNEY_LABS_VERIFY_PATH),
    labsApiBaseUrl: strip(env.JOURNEY_LABS_API_BASE_URL) ?? strip(env.JOURNEY_APP_API_BASE_URL) ?? supplierApiBaseUrl,
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
      userClaim: blank(env.OAUTH_USER_CLAIM) ?? 'journey_user_id',
      companyClaim: blank(env.OAUTH_COMPANY_CLAIM) ?? 'journey_company_id',
      statusClaim: blank(env.OAUTH_STATUS_CLAIM) ?? 'journey_status',
      roleClaim: blank(env.OAUTH_ROLE_CLAIM) ?? 'journey_role',
    },
    requestTimeoutMs: Number(env.JOURNEY_REQUEST_TIMEOUT_MS || 15000),
  };
}
