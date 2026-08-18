import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createPostgresBackup } from './backup-postgres.mjs';
import { restorePostgresDrill } from './restore-postgres-drill.mjs';

const connectionString = 'postgresql://restore-user:restore-password@database/sketch_arena';

test('restores every durable domain into an isolated database and always removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-restore-drill-')); const calls = [];
  const runner = async (command, args, environment) => {
    calls.push({ command, args, environment });
    if (command === 'pg_dump') { const file = args.find((value) => value.startsWith('--file=')).slice(7); await writeFile(file, 'mock-custom-postgres-dump'); }
    if (command === 'psql') return { stdout: JSON.stringify({ migrations: 10, accounts: 2, artworks: 3, mints: 1, progression: 2, promotions: 1, reports: 0, matches: 4 }), stderr: '' };
    return { stdout: command === 'pg_restore' ? 'mock contents' : '', stderr: '' };
  };
  try {
    const backup = await createPostgresBackup({ connectionString, destination: root, release: 'abc123', now: new Date('2026-08-18T20:00:00.000Z'), runner }); calls.length = 0;
    const result = await restorePostgresDrill({ connectionString, backupDirectory: backup.directory, now: new Date('2026-08-18T20:05:00.000Z'), random: 'deadbeef', runner });
    assert.equal(result.databaseName, 'sketch_arena_restore_drill_20260818200500_deadbeef'); assert.equal(result.counts.mints, 1);
    const createdb = calls.find((call) => call.command === 'createdb'); const restored = calls.find((call) => call.command === 'pg_restore' && call.args.some((value) => value.startsWith('--dbname='))); const dropped = calls.at(-1);
    assert.deepEqual(createdb.args, ['--maintenance-db=postgres', '--encoding=UTF8', result.databaseName]);
    assert.ok(restored.args.includes(`--dbname=${result.databaseName}`)); assert.equal(dropped.command, 'dropdb'); assert.ok(dropped.args.includes(result.databaseName));
    assert.ok(calls.every((call) => !call.args.join(' ').includes(connectionString) && !call.args.join(' ').includes('restore-password')));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('removes the isolated database when restore validation fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-restore-failure-')); const calls = [];
  const runner = async (command, args, environment) => {
    calls.push({ command, args, environment });
    if (command === 'pg_dump') { const file = args.find((value) => value.startsWith('--file=')).slice(7); await writeFile(file, 'mock-custom-postgres-dump'); }
    if (command === 'psql') return { stdout: JSON.stringify({ migrations: 2 }), stderr: '' };
    return { stdout: command === 'pg_restore' ? 'mock contents' : '', stderr: '' };
  };
  try {
    const backup = await createPostgresBackup({ connectionString, destination: root, runner }); calls.length = 0;
    await assert.rejects(() => restorePostgresDrill({ connectionString, backupDirectory: backup.directory, now: new Date('2026-08-18T20:10:00.000Z'), random: 'feedface', runner }), /representative-domain check/);
    assert.equal(calls.at(-1).command, 'dropdb'); assert.ok(calls.at(-1).args.includes('sketch_arena_restore_drill_20260818201000_feedface'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('uses and removes a safely precreated least-privilege drill database', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sketch-arena-restore-precreated-')); const calls = [];
  const runner = async (command, args, environment) => {
    calls.push({ command, args, environment });
    if (command === 'pg_dump') { const file = args.find((value) => value.startsWith('--file=')).slice(7); await writeFile(file, 'mock-custom-postgres-dump'); }
    if (command === 'psql') return { stdout: JSON.stringify({ migrations: 10, accounts: 0, artworks: 0, mints: 0, progression: 0, promotions: 0, reports: 0, matches: 0 }), stderr: '' };
    return { stdout: command === 'pg_restore' ? 'mock contents' : '', stderr: '' };
  };
  try {
    const backup = await createPostgresBackup({ connectionString, destination: root, runner }); calls.length = 0;
    const databaseName = 'sketch_arena_restore_drill_20260818201500_cafebabe';
    await restorePostgresDrill({ connectionString, backupDirectory: backup.directory, databaseName, precreated: true, runner });
    assert.equal(calls.some((call) => call.command === 'createdb'), false); assert.equal(calls.at(-1).command, 'dropdb'); assert.ok(calls.at(-1).args.includes(databaseName));
    await assert.rejects(() => restorePostgresDrill({ connectionString, backupDirectory: backup.directory, databaseName: 'sketch_arena', precreated: true, runner }), /Unsafe restore-drill database name/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
