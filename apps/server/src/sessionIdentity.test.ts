import { describe, expect, it } from 'vitest';
import { sessionFromAuthorization, sessionIdFromCredential } from './sessionIdentity.js';

describe('private session credentials', () => {
  const credential = 'a'.repeat(64);

  it('derives a stable public UUID without exposing the credential', () => {
    const sessionId = sessionIdFromCredential(credential);
    expect(sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(sessionId).toBe(sessionIdFromCredential(credential));
    expect(sessionId).not.toContain(credential.slice(0, 12));
  });

  it('requires a complete bearer credential', () => {
    expect(sessionFromAuthorization(`Bearer ${credential}`)).toBe(sessionIdFromCredential(credential));
    expect(sessionFromAuthorization(`Bearer ${'b'.repeat(63)}`)).toBeNull();
    expect(sessionFromAuthorization(undefined)).toBeNull();
  });
});
