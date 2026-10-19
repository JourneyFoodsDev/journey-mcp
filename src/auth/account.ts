import { createHash } from 'node:crypto';
import type { Entity } from '../policy/policy.js';

/** Every call is tied to a Journey account. The tier comes from the account, never from the client. */
export interface Account {
  id: string;
  tier?: string | null;
  authMethod: 'oauth' | 'api_key' | 'local';
  scopes: string[];
  /** Credential to forward upstream when the caller authenticated with their own Journey API key. Never logged. */
  upstreamApiKey?: string;
  /** Journey app session token for the signed-in user (remote OAuth server only). Never logged. */
  appToken?: string;
  contractLimits?: Partial<Record<Entity, number>> & { requestsPerMinute?: number; lifetimeTotal?: number };
}

export const fingerprint = (secret: string) => createHash('sha256').update(secret).digest('hex').slice(0, 16);
