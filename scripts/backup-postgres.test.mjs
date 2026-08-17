import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPostgresBackup, postgresEnvironment, verifyPostgresBackup } from './backup-postgres.mjs';

test('creates a manifest-backed pg_dump without exposing the connection URL in arguments', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-postgres-backup-')); const calls = [];
  const runner = async (command, args, environment) => { calls.push({ command, args, environment }); if (command === 'pg_dump') { const file = args.find((value) => value.startsWith('--file=')).slice(7); await writeFile(file, 'mock-custom-postgres-dump'); } return { stdout: command === 'pg_restore' ? 'mock contents' : '', stderr: '' }; };
  try {
    const connectionString = 'postgresql://secret-user:secret-password@database/sketch'; const result = await createPostgresBackup({ connectionString, destination: root, release: 'abc123', now: new Date('2026-08-16T12:00:00.000Z'), runner });
    assert.equal(result.manifest.release, 'abc123'); assert.ok(calls.some((call) => call.command === 'pg_restore'));
    assert.ok(calls.every((call) => !call.args.join(' ').includes(connectionString))); assert.equal(calls[0].environment.PGDATABASE, 'sketch');
    assert.equal(calls[0].environment.PGUSER, 'secret-user'); assert.equal(calls[0].environment.PGPASSWORD, 'secret-password');
    await verifyPostgresBackup(result.directory, runner);
    await writeFile(join(result.directory, 'database.dump'), 'corrupt'); await assert.rejects(() => verifyPostgresBackup(result.directory, runner), /integrity check failed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('maps encoded PostgreSQL URLs and supported TLS options into libpq variables', () => {
  const environment = postgresEnvironment('postgresql://user%40team:p%40ss@db.example:6432/sketch%20arena?sslmode=verify-full&application_name=backup', { SAFE: 'yes' });
  assert.deepEqual(environment, { SAFE: 'yes', PGHOST: 'db.example', PGPORT: '6432', PGUSER: 'user@team', PGPASSWORD: 'p@ss', PGDATABASE: 'sketch arena', PGSSLMODE: 'verify-full', PGAPPNAME: 'backup' });
  assert.throws(() => postgresEnvironment('not-a-url'), /PostgreSQL URL/);
});
