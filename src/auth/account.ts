import { createHash } from 'node:crypto';
import type { Entity } from '../policy/policy.js';

/**
 * Every call is tied to a Journey company or account, never to an API key.
 * The tier comes from the account, never from the client.
 * companyId owns the backend allowance. Enterprise is uncapped only when tier is enterprise and status is active or trialing.
 */
export interface Account {
  id: string;
  tier?: string | null;
  /** Subscription status from Journey (active, trialing, ...). */
  status?: string | null;
  role?: string | null;
  /** Journey user. Sent as x-journey-end-user userId under OAuth. */
  userId?: string;
  /** Company or price-feed account that owns the allowance. Sent as companyId. */
  companyId?: string;
  authMethod: 'oauth' | 'api_key' | 'local';
  scopes: string[];
  /** Credential to forward upstream when the caller authenticated with their own Journey API key. Never logged. */
  upstreamApiKey?: string;
  /** Journey app session token for the signed-in user (remote OAuth server only). Never logged. */
  appToken?: string;
  contractLimits?: Partial<Record<Entity, number>> & { requestsPerMinute?: number; lifetimeTotal?: number };
}

export const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 16);
