import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadMigrations } from './migrate-postgres.mjs';

test('loads ordered checksum-stable migrations and rejects embedded transactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sketch-arena-migrations-'));
  try {
    await writeFile(join(directory, '002_second.sql'), 'create table second(id int);\n');
    await writeFile(join(directory, '001_first.sql'), 'create table first(id int);\n');
    await writeFile(join(directory, 'notes.txt'), 'ignored');
    const first = await loadMigrations(directory); const second = await loadMigrations(directory);
    assert.deepEqual(first.map((item) => item.name), ['001_first.sql', '002_second.sql']);
    assert.deepEqual(first.map((item) => item.checksum), second.map((item) => item.checksum));
    assert.match(first[0].checksum, /^[0-9a-f]{64}$/);

    await writeFile(join(directory, '003_bad.sql'), 'begin;\nselect 1;\ncommit;\n');
    await assert.rejects(() => loadMigrations(directory), /runner owns the transaction/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uses one canonical checksum across Unix and Windows line endings', async () => {
  const unixDirectory = await mkdtemp(join(tmpdir(), 'sketch-arena-migrations-unix-'));
  const windowsDirectory = await mkdtemp(join(tmpdir(), 'sketch-arena-migrations-windows-'));
  try {
    await writeFile(join(unixDirectory, '001_first.sql'), 'create table first(\n  id int\n);\n');
    await writeFile(join(windowsDirectory, '001_first.sql'), 'create table first(\r\n  id int\r\n);\r\n');
    const [unix] = await loadMigrations(unixDirectory); const [windows] = await loadMigrations(windowsDirectory);
    assert.equal(unix.checksum, windows.checksum);
    assert.deepEqual(unix.compatibleChecksums, windows.compatibleChecksums);
    assert.equal(unix.compatibleChecksums.length, 2);
  } finally {
    await Promise.all([rm(unixDirectory, { recursive: true, force: true }), rm(windowsDirectory, { recursive: true, force: true })]);
  }
});
