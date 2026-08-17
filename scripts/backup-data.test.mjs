import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createBackup, productionSources, verifyBackup } from './backup-data.mjs';

test('creates a private manifest-backed backup and detects corruption', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-backup-test-'));
  try {
    const dataDirectory = join(root, 'data'); const backupRoot = join(root, 'backups');
    await mkdir(dataDirectory);
    const sources = ['artworks.json', 'progression.json', 'mint-lifecycle.json', 'promotions.json', 'moderation-reports.json', 'accounts.json'].map((name) => join(dataDirectory, name));
    for (let index = 0; index < sources.length; index += 1) await writeFile(sources[index], JSON.stringify([{ id: index + 1 }]));

    const result = await createBackup({ sources, destination: backupRoot, release: 'abc123', now: new Date('2026-08-16T12:00:00.000Z') });
    const manifest = await verifyBackup(result.backupDirectory);
    assert.equal(manifest.release, 'abc123');
    assert.equal(manifest.files.length, 6);
    assert.equal(JSON.parse(await readFile(join(result.backupDirectory, 'artworks.json'), 'utf8'))[0].id, 1);

    await writeFile(join(result.backupDirectory, 'artworks.json'), '[]');
    await assert.rejects(() => verifyBackup(result.backupDirectory), /integrity check failed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('backs up account, artwork, progression and mint JSON only when PostgreSQL is not authoritative', () => {
  const root = join(tmpdir(), 'sketch-arena-source-layout');
  assert.equal(productionSources({}, root).length, 6);
  const postgresSources = productionSources({ DATABASE_URL: 'postgresql://database/sketch' }, root);
  assert.equal(postgresSources.length, 2);
  assert.ok(postgresSources.every((source) => !source.endsWith('accounts.json')));
  assert.ok(postgresSources.every((source) => !source.endsWith('artworks.json')));
  assert.ok(postgresSources.every((source) => !source.endsWith('mint-lifecycle.json')));
  assert.ok(postgresSources.every((source) => !source.endsWith('progression.json')));
});
