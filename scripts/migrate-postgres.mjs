import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;
const migrationPattern = /^\d{3}_[a-z0-9_]+\.sql$/;

export async function loadMigrations(directoryValue) {
  const directory = resolve(directoryValue);
  const names = (await readdir(directory)).filter((name) => migrationPattern.test(name)).sort();
  if (!names.length) throw new Error('No PostgreSQL migrations were found');
  return Promise.all(names.map(async (name) => {
    const sql = await readFile(resolve(directory, name), 'utf8');
    if (/^\s*(begin|commit|rollback)\s*;/im.test(sql)) throw new Error(`${name} contains transaction control; the migration runner owns the transaction`);
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export async function migrate(connectionString, directory = resolve(process.cwd(), 'deploy', 'postgres')) {
  if (!connectionString?.trim()) throw new Error('DATABASE_URL is required to run PostgreSQL migrations');
  const migrations = await loadMigrations(directory);
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, application_name: 'sketch-arena-migrate' });
  const client = await pool.connect();
  try {
    await client.query("select pg_advisory_lock(hashtext('sketch-arena-schema-migrations'))");
    await client.query('begin');
    await client.query(`create table if not exists sketch_arena_schema_migrations (
      name text primary key,
      checksum char(64) not null,
      applied_at timestamptz not null default now()
    )`);
    for (const migration of migrations) {
      const existing = await client.query('select checksum from sketch_arena_schema_migrations where name=$1', [migration.name]);
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum) throw new Error(`Applied migration ${migration.name} has a different checksum`);
        continue;
      }
      await client.query(migration.sql);
      await client.query('insert into sketch_arena_schema_migrations(name,checksum) values($1,$2)', [migration.name, migration.checksum]);
    }
    await client.query('commit');
    return migrations.map(({ name, checksum }) => ({ name, checksum }));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.query("select pg_advisory_unlock(hashtext('sketch-arena-schema-migrations'))").catch(() => undefined);
    client.release();
    await pool.end();
  }
}

async function main() {
  const migrations = await migrate(process.env.DATABASE_URL);
  console.log(`PostgreSQL schema verified: ${migrations.map((item) => item.name).join(', ')}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
