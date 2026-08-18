import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { postgresEnvironment, verifyPostgresBackup } from './backup-postgres.mjs';

const execute = promisify(execFile);
const defaultRunner = (command, args, environment) => execute(command, args, { env: environment, windowsHide: true, timeout: 600_000, maxBuffer: 10_000_000 });
const countQuery = `select json_build_object(
  'migrations', (select count(*) from sketch_arena_schema_migrations),
  'accounts', (select count(*) from player_accounts),
  'artworks', (select count(*) from artworks),
  'mints', (select count(*) from mint_records),
  'progression', (select count(*) from player_progression),
  'promotions', (select count(*) from promotion_campaigns),
  'reports', (select count(*) from moderation_reports),
  'matches', (select count(*) from leaderboard_match_receipts)
)::text;`;

function drillDatabaseName(now = new Date(), random = randomBytes(4).toString('hex')) {
  const stamp = now.toISOString().replace(/\D/g, '').slice(0, 14);
  return `sketch_arena_restore_drill_${stamp}_${random}`;
}

export async function restorePostgresDrill({ connectionString, backupDirectory, now = new Date(), random, runner = defaultRunner }) {
  if (!connectionString?.trim()) throw new Error('DATABASE_URL is required for a PostgreSQL restore drill');
  if (!backupDirectory?.trim()) throw new Error('A verified backup directory is required for a PostgreSQL restore drill');
  const directory = resolve(backupDirectory);
  const manifest = await verifyPostgresBackup(directory, runner);
  const source = postgresEnvironment(connectionString);
  const databaseName = drillDatabaseName(now, random);
  if (databaseName === source.PGDATABASE || !/^sketch_arena_restore_drill_[0-9]{14}_[0-9a-f]{8}$/.test(databaseName)) throw new Error('Unsafe restore-drill database name');
  const administration = { ...source, PGDATABASE: 'postgres', PGAPPNAME: 'sketch-arena-restore-drill' };
  const target = { ...source, PGDATABASE: databaseName, PGAPPNAME: 'sketch-arena-restore-drill' };
  let created = false;
  try {
    await runner('createdb', ['--maintenance-db=postgres', '--encoding=UTF8', databaseName], administration); created = true;
    await runner('pg_restore', ['--exit-on-error', '--no-owner', '--no-privileges', `--dbname=${databaseName}`, resolve(directory, manifest.file)], target);
    const result = await runner('psql', ['--no-psqlrc', '--tuples-only', '--no-align', '--set=ON_ERROR_STOP=1', `--dbname=${databaseName}`, '--command', countQuery], target);
    const counts = JSON.parse(result.stdout.trim());
    const expected = ['migrations', 'accounts', 'artworks', 'mints', 'progression', 'promotions', 'reports', 'matches'];
    if (!expected.every((key) => Number.isInteger(Number(counts[key])) && Number(counts[key]) >= 0) || Number(counts.migrations) < 10) throw new Error('Restored database failed the representative-domain check');
    return { databaseName, manifest, counts };
  } finally {
    if (created) await runner('dropdb', ['--if-exists', '--maintenance-db=postgres', databaseName], administration);
  }
}

async function main() {
  const backupIndex = process.argv.indexOf('--backup'); const backupDirectory = backupIndex >= 0 ? process.argv[backupIndex + 1] : undefined;
  if (!backupDirectory) throw new Error('Usage: npm run ops:restore:drill -- --backup <verified-backup-directory>');
  const result = await restorePostgresDrill({ connectionString: process.env.DATABASE_URL, backupDirectory });
  console.log(JSON.stringify({ restored: true, sourceBackup: result.manifest.createdAt, temporaryDatabaseRemoved: result.databaseName, counts: result.counts }, null, 2));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
