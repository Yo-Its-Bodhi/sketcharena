import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadPersistenceConfiguration } from './persistenceConfig.js';

function production(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const root = resolve('production-data');
  return {
    NODE_ENV: 'production', DATABASE_URL: 'postgresql://sketch@database/sketch_arena',
    ARTWORK_DATA_FILE: resolve(root, 'artworks.json'), PROGRESSION_DATA_FILE: resolve(root, 'progression.json'),
    MINT_DATA_FILE: resolve(root, 'mints.json'), PROMOTION_DATA_FILE: resolve(root, 'promotions.json'),
    REPORT_DATA_FILE: resolve(root, 'reports.json'), ...overrides,
  };
}

describe('persistence configuration', () => {
  it('keeps zero-config development on explicit resolved local files', () => {
    const config = loadPersistenceConfiguration({}, resolve('workspace'));
    expect(config.artworkFile).toMatch(/\.data[\\/]artworks\.json$/);
    expect(config.databaseUrl).toBeUndefined();
  });

  it('requires PostgreSQL identity storage in production', () => {
    expect(() => loadPersistenceConfiguration(production({ DATABASE_URL: '' }))).toThrow(/DATABASE_URL is required/);
  });

  it('ignores development file adapters when PostgreSQL is authoritative', () => {
    const config = loadPersistenceConfiguration(production({ PROMOTION_DATA_FILE: ':memory:', REPORT_DATA_FILE: '.data/reports.json' }));
    expect(config.databaseUrl).toContain('postgresql://');
  });

  it('accepts an explicit durable production layout', () => {
    const config = loadPersistenceConfiguration(production());
    expect(config.databaseUrl).toContain('postgresql://');
  });
});
