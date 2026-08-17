import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const execute = promisify(execFile);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const defaultRunner = (command, args, environment) => execute(command, args, { env: environment, windowsHide: true, timeout: 300_000, maxBuffer: 10_000_000 });

export function postgresEnvironment(connectionString, environment = process.env) {
  let url;
  try { url = new URL(connectionString); } catch { throw new Error('DATABASE_URL must be a PostgreSQL URL'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new Error('DATABASE_URL must be a PostgreSQL URL');
  const result = {
    ...environment,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  };
  const libpqOptions = { sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY', application_name: 'PGAPPNAME' };
  for (const [parameter, variable] of Object.entries(libpqOptions)) {
    const value = url.searchParams.get(parameter);
    if (value) result[variable] = value;
  }
  return result;
}

export async function createPostgresBackup({ connectionString, destination, release = 'unknown', now = new Date(), runner = defaultRunner }) {
  if (!connectionString?.trim()) throw new Error('DATABASE_URL is required for a PostgreSQL backup');
  const root = resolve(destination); const backupId = `${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(4).toString('hex')}`; const directory = resolve(root, backupId);
  await mkdir(root, { recursive: true, mode: 0o700 }); await mkdir(directory, { mode: 0o700 });
  const temporary = resolve(directory, 'database.dump.tmp'); const dump = resolve(directory, 'database.dump');
  const environment = postgresEnvironment(connectionString);
  await runner('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', `--file=${temporary}`], environment);
  await chmod(temporary, 0o600).catch(() => undefined); await rename(temporary, dump);
  const bytes = await readFile(dump); if (!bytes.byteLength) throw new Error('pg_dump produced an empty backup');
  const manifest = { format: 'SKETCH-ARENA-POSTGRES-BACKUP-V1', createdAt: now.toISOString(), release, file: 'database.dump', bytes: bytes.byteLength, sha256: hash(bytes) };
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  await verifyPostgresBackup(directory, runner); await chmod(directory, 0o700).catch(() => undefined); return { directory, manifest };
}

export async function verifyPostgresBackup(directoryValue, runner = defaultRunner) {
  const directory = resolve(directoryValue); const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'SKETCH-ARENA-POSTGRES-BACKUP-V1' || manifest.file !== 'database.dump' || !/^[0-9a-f]{64}$/.test(manifest.sha256)) throw new Error('Invalid PostgreSQL backup manifest');
  const dump = resolve(directory, manifest.file); const bytes = await readFile(dump);
  if (bytes.byteLength !== manifest.bytes || hash(bytes) !== manifest.sha256) throw new Error('PostgreSQL backup integrity check failed');
  await runner('pg_restore', ['--list', dump], { ...process.env }); return manifest;
}

async function main() {
  const verifyIndex = process.argv.indexOf('--verify');
  if (verifyIndex >= 0) { const directory = process.argv[verifyIndex + 1]; if (!directory) throw new Error('Usage: npm run ops:backup:postgres:verify -- <backup-directory>'); const manifest = await verifyPostgresBackup(directory); console.log(`Verified PostgreSQL backup from ${manifest.createdAt}`); return; }
  if (!process.env.SKETCH_BACKUP_DIR) throw new Error('SKETCH_BACKUP_DIR is required for a PostgreSQL backup');
  const result = await createPostgresBackup({ connectionString: process.env.DATABASE_URL, destination: process.env.SKETCH_BACKUP_DIR, release: process.env.RELEASE_SHA || 'unknown' }); console.log(`Verified PostgreSQL backup: ${result.directory}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
