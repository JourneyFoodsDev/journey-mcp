import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { END_USER_HEADER, END_USER_SIG_HEADER, parsePriceAccount, readSecretBinding, signEndUser } from '../src/auth/end-user.js';
import { ApiKeyResolver } from '../src/auth/api-key.js';
import { silentLogger } from '../src/logger.js';
import { PolicyEnforcer } from '../src/policy/enforcer.js';
import { MemoryUsageStore } from '../src/policy/usage-store.js';
import { smallPolicy } from './helpers.js';

describe('end-user signature', () => {
  it('signs the exact header for 300 seconds and omits the headers when it cannot', () => {
    const headers = signEndUser({ companyId: 'co-1', userId: 'user-1', tier: 'enterprise', status: 'active' }, 'secret', 1_700_000_000);
    const header = headers[END_USER_HEADER];
    expect(JSON.parse(Buffer.from(header, 'base64url').toString('utf8'))).toEqual({
      userId: 'user-1', companyId: 'co-1', tier: 'enterprise', status: 'active', iat: 1_700_000_000, exp: 1_700_000_300,
    });
    expect(headers[END_USER_SIG_HEADER]).toBe(createHmac('sha256', 'secret').update(header).digest('hex'));
    expect(signEndUser({ companyId: 'co-1' }, undefined)).toEqual({});
    expect(signEndUser({}, 'secret')).toEqual({});
  });

  it('reads a Secrets Store binding and treats a missing one as unset', async () => {
    expect(await readSecretBinding(undefined)).toBeUndefined();
    expect(await readSecretBinding({ get: async () => 's3cret' })).toBe('s3cret');
    expect(await readSecretBinding({ get: async () => { throw new Error('missing'); } }, { optional: true })).toBeUndefined();
    await expect(readSecretBinding({ get: async () => { throw new Error('missing'); } })).rejects.toThrow(/missing/);
  });
});

describe('price-feed account identity', () => {
  it('prefers a company id, then an account id, and ignores a bare key id', () => {
    expect(parsePriceAccount({ data: { companyId: 'co-1', accountId: 'acc-1', tier: 'growth' } })).toMatchObject({ companyId: 'co-1', accountId: 'acc-1', stable: true });
    expect(parsePriceAccount({ account: { id: 'acc-9', status: 'active' } })).toMatchObject({ accountId: 'acc-9', stable: true });
    expect(parsePriceAccount({ company: { id: 'co-2' }, id: 'key_123', status: 'trialing', callLimit: 100 })).toMatchObject({ companyId: 'co-2', stable: true, status: 'trialing' });
    expect(parsePriceAccount({ id: 'key_123', status: 'trialing', callLimit: 100, callsUsed: 1 }).stable).toBe(false);
  });

  it('counts two keys for the same company as one allowance', async () => {
    const f = (async () => new Response(JSON.stringify({ company_id: 'co-1', tier: 'explore', status: 'trialing' }), { status: 200 })) as unknown as typeof fetch;
    const resolver = new ApiKeyResolver(undefined, silentLogger, f, 60_000, 'https://price.example.test');
    const a = await resolver.resolve('trial-key-a');
    const b = await resolver.resolve('trial-key-b');
    expect(a.id).toBe('acct:co-1');
    expect(b.id).toBe(a.id);
    const enforcer = new PolicyEnforcer(smallPolicy(), new MemoryUsageStore());
    await enforcer.admit(a, 'ingredient', ['i1', 'i2', 'i3'], (x) => x);
    await expect(enforcer.admit(b, 'ingredient', ['i4'], (x) => x)).rejects.toThrow(/ingredient/);
  });
});
