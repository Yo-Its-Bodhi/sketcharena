import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import type { PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';

export interface PlayerAccountInfo { id: string; name: string; secured: boolean; securedAt?: number; createdAt: number; sessionId: string; passkeyCount?: number; }
export interface DeviceSessionInfo { id: string; label: string; createdAt: number; lastSeenAt: number; expiresAt: number; current: boolean; }

async function json<T>(response: Response): Promise<T> {
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error || 'Account request failed'); return body;
}

export async function ensureDeviceSession(legacyCredential: string, name: string): Promise<PlayerAccountInfo> {
  const current = await fetch('/api/account', { credentials: 'include' });
  if (current.ok) return current.json() as Promise<PlayerAccountInfo>;
  return json<PlayerAccountInfo>(await fetch('/api/account/migrate', {
    method: 'POST', credentials: 'include', headers: { authorization: `Bearer ${legacyCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name, deviceLabel: deviceLabel() }),
  }));
}

export async function accountStatus(): Promise<PlayerAccountInfo | null> {
  const response = await fetch('/api/account', { credentials: 'include' }); return response.ok ? response.json() as Promise<PlayerAccountInfo> : null;
}

export async function secureAccountWithPasskey(label = 'My passkey'): Promise<PlayerAccountInfo> {
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys');
  const setup = await json<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(await fetch('/api/account/passkeys/register/options', { method: 'POST', credentials: 'include' }));
  const response = await startRegistration({ optionsJSON: setup.options });
  await json(await fetch('/api/account/passkeys/register/verify', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: setup.challengeId, label, response }) }));
  const account = await accountStatus(); if (!account) throw new Error('Passkey was saved, but the account could not be reloaded'); return account;
}

export async function signInWithPasskey(): Promise<PlayerAccountInfo> {
  if (!window.PublicKeyCredential) throw new Error('This browser does not support passkeys');
  const setup = await json<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(await fetch('/api/account/passkeys/authenticate/options', { method: 'POST', credentials: 'include' }));
  const response = await startAuthentication({ optionsJSON: setup.options });
  return json<PlayerAccountInfo>(await fetch('/api/account/passkeys/authenticate/verify', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ challengeId: setup.challengeId, deviceLabel: deviceLabel(), response }) }));
}

export async function listDeviceSessions(): Promise<DeviceSessionInfo[]> {
  return json<DeviceSessionInfo[]>(await fetch('/api/account/sessions', { credentials: 'include' }));
}

export async function revokeDeviceSession(id: string): Promise<void> {
  const response = await fetch(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' });
  if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error || 'Could not sign that device out'); }
}

function deviceLabel(): string {
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || 'device';
  const browser = /Edg\//.test(navigator.userAgent) ? 'Edge' : /Firefox\//.test(navigator.userAgent) ? 'Firefox' : /Chrome\//.test(navigator.userAgent) ? 'Chrome' : /Safari\//.test(navigator.userAgent) ? 'Safari' : 'Browser';
  return `${browser} · ${platform}`.slice(0, 80);
}
