import { describe, expect, it, vi } from 'vitest';
import { createBodhiXServerClient, exchangeBodhiXCode } from './index.js';

const token = 'A'.repeat(48);

describe('BodhiX server app adapter', () => {
  it('keeps the app session in the authorization header and binds the app ID', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ account: { id: 'one', name: 'Bodhi', secured: true }, appId: 'carnival', expiresAt: 1, entitlements: [], xp: [], memberships: [] }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = createBodhiXServerClient({ authorityUrl: 'https://sketch.bodhix.io/', appId: 'carnival', appSession: token, fetch: request as typeof fetch });
    await client.profile();
    expect(request).toHaveBeenCalledWith('https://sketch.bodhix.io/api/ecosystem/app/me?app=carnival', expect.objectContaining({ headers: expect.objectContaining({ authorization: `Bearer ${token}` }) }));
  });

  it('sends idempotent app XP receipts and surfaces authority errors', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ error: 'duplicate receipt malformed' }), { status: 409, headers: { 'content-type': 'application/json' } }));
    const client = createBodhiXServerClient({ authorityUrl: 'https://sketch.bodhix.io', appId: 'poker', appSession: token, fetch: request as typeof fetch });
    await expect(client.recordXp({ amount: 25, reason: 'finished hand', idempotencyKey: 'hand-1234' })).rejects.toThrow('duplicate receipt malformed');
  });

  it('exchanges a PKCE code without placing the resulting app token in a URL', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ account: { id: 'one', name: 'Bodhi', secured: true }, appSession: { token, expiresAt: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await exchangeBodhiXCode({ authorityUrl: 'https://sketch.bodhix.io', appId: 'poker', redirectUri: 'https://poker.bodhix.io/api/bodhix/callback', code: 'C'.repeat(48), verifier: 'V'.repeat(48), fetch: request as typeof fetch });
    expect(String(request.mock.calls[0]?.[0])).not.toContain(token);
    expect(request.mock.calls[0]?.[1]?.method).toBe('POST');
  });
});
