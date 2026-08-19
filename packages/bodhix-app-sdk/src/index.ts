export interface BodhiXAppClientOptions {
  authorityUrl: string;
  appId: string;
  appSession: string;
  fetch?: typeof globalThis.fetch;
}

export interface BodhiXEntitlement {
  id: string;
  code: string;
  name: string;
  kind: string;
  scope: 'app' | 'ecosystem';
  appId: string | null;
  quantity: number;
  remaining: number | null;
  expiresAt: number | null;
  metadata?: Record<string, unknown>;
}

export interface BodhiXAppProfile {
  account: { id: string; name: string; secured: boolean };
  appId: string;
  expiresAt: number;
  entitlements: BodhiXEntitlement[];
  xp: Array<{ appId: string; seasonId: string | null; xp: number }>;
  memberships: Array<{ appId: string; firstSeenAt: number; lastSeenAt: number }>;
}

export interface BodhiXAuthExchange {
  account: { id: string; name: string; secured: boolean };
  appSession: { token: string; expiresAt: number };
}

export function createBodhiXServerClient(options: BodhiXAppClientOptions) {
  const authorityUrl = options.authorityUrl.replace(/\/+$/, '');
  const request = options.fetch ?? globalThis.fetch;
  if (!request) throw new Error('A fetch implementation is required');
  if (!/^[a-z0-9-]{2,48}$/.test(options.appId)) throw new Error('BodhiX app ID is invalid');
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(options.appSession)) throw new Error('BodhiX app session is invalid');
  const call = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const response = await request(`${authorityUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${options.appSession}`, 'content-type': 'application/json', ...(init?.headers ?? {}) },
    });
    const body = await response.json().catch(() => ({})) as T & { error?: string };
    if (!response.ok) throw new Error(body.error ?? `BodhiX authority rejected the request (${response.status})`);
    return body;
  };
  return {
    profile: () => call<BodhiXAppProfile>(`/api/ecosystem/app/me?app=${encodeURIComponent(options.appId)}`),
    recordXp: (input: { amount: number; reason: string; idempotencyKey: string; sourceReference?: string; seasonId?: string }) => call<{ awarded: number; duplicate: boolean; appXp: number; ecosystemXp: number }>('/api/ecosystem/app/xp', { method: 'POST', body: JSON.stringify({ app: options.appId, ...input }) }),
    reserveClaim: (input: { entitlementId: string; quantity: number; idempotencyKey: string }) => call<{ id: string; status: 'reserved' }>('/api/ecosystem/app/claims', { method: 'POST', body: JSON.stringify({ app: options.appId, ...input }) }),
  };
}

export async function exchangeBodhiXCode(input: { authorityUrl: string; appId: string; redirectUri: string; code: string; verifier: string; fetch?: typeof globalThis.fetch }): Promise<BodhiXAuthExchange> {
  const request = input.fetch ?? globalThis.fetch;
  if (!request) throw new Error('A fetch implementation is required');
  const response = await request(`${input.authorityUrl.replace(/\/+$/, '')}/api/ecosystem/exchange`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: input.appId, redirectUri: input.redirectUri, code: input.code, verifier: input.verifier }),
  });
  const body = await response.json().catch(() => ({})) as BodhiXAuthExchange & { error?: string };
  if (!response.ok) throw new Error(body.error ?? 'BodhiX sign-in exchange failed');
  return body;
}
