import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';
import { importLegacySources, loadLegacySources } from './import-json-to-postgres.mjs';

const connectionString = process.env.TEST_DATABASE_URL;
test('imports all legacy source formats once and refuses changed source evidence', { skip: !connectionString }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-legacy-import-')); const { Pool } = pg; const pool = new Pool({ connectionString });
  const accountId = '11111111-1111-4111-8111-111111111111'; const artworkId = '22222222-2222-4222-8222-222222222222'; const now = 10_000;
  const files = {
    ACCOUNT_DATA_FILE: ['accounts.json', { version: 1, accounts: [{ id: accountId, name: 'Legacy CI', legacyCredentialHash: 'a'.repeat(64), createdAt: now, updatedAt: now }], sessions: [], passkeys: [], challenges: [] }],
    ARTWORK_DATA_FILE: ['artworks.json', [{ id: artworkId, ownerSessionId: accountId, origin: 'studio', status: 'gallery', title: 'Imported panic', description: '', canvasRatio: 'square', width: 1200, height: 1200, strokes: [], createdAt: now, updatedAt: now }]],
    PROGRESSION_DATA_FILE: ['progression.json', { players: [{ sessionId: accountId, name: 'Legacy CI', seasonId: 'season-0', xp: 0, level: 1, battlePass: 'free', achievements: [], items: [], rewards: [], firstSeenAt: now, lastSeenAt: now }], audit: [], appliedKeys: [], redemptionKeys: [] }],
    MINT_DATA_FILE: ['mint-lifecycle.json', { challenges: [], bindings: [], mints: [] }],
    PROMOTION_DATA_FILE: ['promotions.json', { campaigns: [], audit: [] }],
    REPORT_DATA_FILE: ['moderation-reports.json', { reports: [] }],
  };
  try {
    const environment = {};
    for (const [variable, [name, data]] of Object.entries(files)) { const path = join(root, name); await writeFile(path, JSON.stringify(data)); environment[variable] = path; }
    const sources = await loadLegacySources(environment, root); assert.equal(sources.length, 6);
    const first = await importLegacySources(connectionString, sources); assert.ok(first.every((item) => !item.skipped));
    const second = await importLegacySources(connectionString, sources); assert.ok(second.every((item) => item.skipped));
    assert.equal(Number((await pool.query('select count(*) count from player_accounts where id=$1', [accountId])).rows[0].count), 1);
    assert.equal(Number((await pool.query('select count(*) count from artworks where id=$1', [artworkId])).rows[0].count), 1);
    assert.equal(Number((await pool.query('select count(*) count from player_progression where session_id=$1', [accountId])).rows[0].count), 1);
    await assert.rejects(() => importLegacySources(connectionString, [{ ...sources[0], sha256: 'f'.repeat(64) }]), /changed after it was imported/);
  } finally { await pool.end(); await rm(root, { recursive: true, force: true }); }
});
