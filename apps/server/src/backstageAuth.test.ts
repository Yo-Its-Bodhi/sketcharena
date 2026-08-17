import { describe, expect, it } from 'vitest';
import { BackstageAuth, hashBackstageToken } from './backstageAuth.js';

describe('BackstageAuth', () => {
  const viewer = 'viewer-secret-that-is-definitely-32-characters';
  const operator = 'operator-secret-that-is-definitely-32-chars';
  const admin = 'admin-secret-that-is-definitely-32-characters';
  const auth = new BackstageAuth({ BACKSTAGE_CREDENTIALS: JSON.stringify([
    { name: 'support', role: 'viewer', tokenHash: hashBackstageToken(viewer) },
    { name: 'rewards', role: 'operator', tokenHash: hashBackstageToken(operator) },
    { name: 'owner', role: 'admin', tokenHash: hashBackstageToken(admin) },
  ]) });

  it('enforces viewer, operator and admin permission boundaries', () => {
    expect(auth.authorize(`Bearer ${viewer}`, 'viewer')).toMatchObject({ name: 'support', role: 'viewer' });
    expect(auth.authorize(`Bearer ${viewer}`, 'operator')).toBeNull();
    expect(auth.authorize(`Bearer ${operator}`, 'viewer')).toMatchObject({ role: 'operator' });
    expect(auth.authorize(`Bearer ${operator}`, 'admin')).toBeNull();
    expect(auth.authorize(`Bearer ${admin}`, 'admin')).toMatchObject({ role: 'admin' });
    expect(auth.authorize(`Bearer ${'x'.repeat(40)}`, 'viewer')).toBeNull();
  });

  it('supports the legacy single admin token without weakening its role', () => {
    const legacy = new BackstageAuth({ ADMIN_API_TOKEN: admin });
    expect(legacy.authorize(`Bearer ${admin}`, 'admin')).toMatchObject({ name: 'primary-admin', role: 'admin' });
  });

  it('fails closed on production legacy keys, malformed staff data, and duplicate principals', () => {
    const productionLegacy = new BackstageAuth({ NODE_ENV: 'production', ADMIN_API_TOKEN: admin, REQUIRE_BACKSTAGE_CREDENTIALS: 'true' });
    expect(productionLegacy.configured).toBe(false);
    expect(productionLegacy.configurationErrors).toContain('ADMIN_API_TOKEN is disabled in production; use named BACKSTAGE_CREDENTIALS');
    expect(productionLegacy.configurationErrors).toContain('Named BACKSTAGE_CREDENTIALS are required');

    const malformed = new BackstageAuth({ BACKSTAGE_CREDENTIALS: '{nope' });
    expect(malformed.valid).toBe(false);
    expect(malformed.error()).toBe('Backstage configuration is invalid');

    const duplicate = new BackstageAuth({ BACKSTAGE_CREDENTIALS: JSON.stringify([
      { name: 'owner', role: 'admin', tokenHash: hashBackstageToken(admin) },
      { name: 'OWNER', role: 'viewer', tokenHash: hashBackstageToken(admin) },
    ]) });
    expect(duplicate.valid).toBe(false);
    expect(duplicate.configurationErrors).toEqual(expect.arrayContaining([
      'BACKSTAGE_CREDENTIALS repeats staff name OWNER',
      'BACKSTAGE_CREDENTIALS reuses one token across staff accounts',
    ]));
  });

  it('accepts named production credentials and can explicitly allow the compatibility key during migration', () => {
    const named = new BackstageAuth({ NODE_ENV: 'production', REQUIRE_BACKSTAGE_CREDENTIALS: 'true', BACKSTAGE_CREDENTIALS: JSON.stringify([
      { name: 'owner', role: 'admin', tokenHash: hashBackstageToken(admin) },
    ]) });
    expect(named.valid).toBe(true); expect(named.configured).toBe(true);

    const migration = new BackstageAuth({ NODE_ENV: 'production', ALLOW_LEGACY_ADMIN_TOKEN: 'true', ADMIN_API_TOKEN: admin });
    expect(migration.authorize(`Bearer ${admin}`, 'admin')).toMatchObject({ name: 'primary-admin' });
  });
});
