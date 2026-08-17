import { createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const hash = (value) => createHash('sha256').update(value).digest('hex');

export async function createBackup({ sources, destination, release = 'unknown', now = new Date() }) {
  if (!sources.length) throw new Error('No Sketch Arena data files were supplied');
  const root = resolve(destination);
  const backupId = `${now.toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomBytes(4).toString('hex')}`;
  const backupDirectory = resolve(root, backupId);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await mkdir(backupDirectory, { mode: 0o700 });

  const files = [];
  for (const sourceValue of sources) {
    const source = resolve(sourceValue);
    const data = await readFile(source);
    JSON.parse(data.toString('utf8'));
    const name = basename(source);
    const target = resolve(backupDirectory, name);
    await writeFile(target, data, { flag: 'wx', mode: 0o600 });
    files.push({ name, source, bytes: data.byteLength, sha256: hash(data) });
  }

  const manifest = { format: 'SKETCH-ARENA-BACKUP-V1', createdAt: now.toISOString(), release, files };
  await writeFile(resolve(backupDirectory, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx', mode: 0o600 });
  await verifyBackup(backupDirectory);
  try { await chmod(backupDirectory, 0o700); } catch { /* Windows does not enforce POSIX modes */ }
  return { backupDirectory, manifest };
}

export async function verifyBackup(directoryValue) {
  const directory = resolve(directoryValue);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  if (manifest.format !== 'SKETCH-ARENA-BACKUP-V1' || !Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('Invalid Sketch Arena backup manifest');
  for (const file of manifest.files) {
    if (!file?.name || !/^[\w.-]+\.json$/i.test(file.name) || !/^[0-9a-f]{64}$/i.test(file.sha256)) throw new Error('Invalid backup file record');
    const data = await readFile(resolve(directory, file.name));
    if (data.byteLength !== file.bytes || hash(data) !== file.sha256) throw new Error(`Backup integrity check failed for ${file.name}`);
    JSON.parse(data.toString('utf8'));
  }
  return manifest;
}

export function productionSources(environment, cwd = process.cwd()) {
  const sources = [
    environment.PROMOTION_DATA_FILE || resolve(cwd, '.data', 'promotions.json'),
    environment.REPORT_DATA_FILE || resolve(cwd, '.data', 'moderation-reports.json'),
  ];
  if (!environment.DATABASE_URL?.trim()) sources.unshift(environment.ARTWORK_DATA_FILE || resolve(cwd, '.data', 'artworks.json'), environment.PROGRESSION_DATA_FILE || resolve(cwd, '.data', 'progression.json'), environment.MINT_DATA_FILE || resolve(cwd, '.data', 'mint-lifecycle.json'));
  if (!environment.DATABASE_URL?.trim()) sources.push(environment.ACCOUNT_DATA_FILE || resolve(cwd, '.data', 'accounts.json'));
  return sources;
}

async function main() {
  const verifyIndex = process.argv.indexOf('--verify');
  if (verifyIndex >= 0) {
    const target = process.argv[verifyIndex + 1];
    if (!target) throw new Error('Usage: npm run ops:backup:verify -- <backup-directory>');
    const manifest = await verifyBackup(target);
    console.log(`Verified ${manifest.files.length} Sketch Arena data files from ${manifest.createdAt}`);
    return;
  }
  const destination = process.env.SKETCH_BACKUP_DIR || process.argv[2];
  if (!destination) throw new Error('Set SKETCH_BACKUP_DIR or pass a backup destination');
  const result = await createBackup({ sources: productionSources(process.env), destination, release: process.env.RELEASE_SHA || 'unknown' });
  console.log(`Verified Sketch Arena backup: ${result.backupDirectory}`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
