import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import pg from 'pg';

const { Pool } = pg;
const definitions = [
  ['accounts', 'ACCOUNT_DATA_FILE', 'accounts.json'], ['artworks', 'ARTWORK_DATA_FILE', 'artworks.json'],
  ['progression', 'PROGRESSION_DATA_FILE', 'progression.json'], ['mints', 'MINT_DATA_FILE', 'mint-lifecycle.json'],
  ['promotions', 'PROMOTION_DATA_FILE', 'promotions.json'], ['reports', 'REPORT_DATA_FILE', 'moderation-reports.json'],
];

export async function loadLegacySources(environment = process.env, cwd = process.cwd()) {
  const sources = [];
  for (const [name, variable, fallback] of definitions) {
    const path = resolve(environment[variable] || resolve(cwd, '.data', fallback));
    try { const bytes = await readFile(path); sources.push({ name, path, sha256: createHash('sha256').update(bytes).digest('hex'), data: JSON.parse(bytes.toString('utf8')) }); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }
  return sources;
}

export async function importLegacySources(connectionString, sources) {
  if (!connectionString?.trim()) throw new Error('DATABASE_URL is required for legacy import');
  const pool = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 5_000, application_name: 'sketch-arena-legacy-import' }); const client = await pool.connect(); const summary = [];
  try {
    await client.query("select pg_advisory_lock(hashtext('sketch-arena-legacy-import'))"); await client.query('begin');
    for (const source of sources) {
      const prior = await client.query('select source_sha256,imported_rows from sketch_arena_legacy_imports where source_name=$1', [source.name]);
      if (prior.rows[0]) { if (prior.rows[0].source_sha256 !== source.sha256) throw new Error(`Legacy source ${source.name} changed after it was imported`); summary.push({ name: source.name, rows: Number(prior.rows[0].imported_rows), skipped: true }); continue; }
      const rows = await importSource(client, source.name, source.data);
      await client.query('insert into sketch_arena_legacy_imports(source_name,source_path,source_sha256,imported_rows) values($1,$2,$3,$4)', [source.name, source.path, source.sha256, rows]); summary.push({ name: source.name, rows, skipped: false });
    }
    await client.query('commit'); return summary;
  } catch (error) { await client.query('rollback').catch(() => undefined); throw error; }
  finally { await client.query("select pg_advisory_unlock(hashtext('sketch-arena-legacy-import'))").catch(() => undefined); client.release(); await pool.end(); }
}

async function importSource(client, name, data) {
  if (name === 'accounts') return importAccounts(client, data);
  if (name === 'artworks') return importArtworks(client, data);
  if (name === 'progression') return importProgression(client, data);
  if (name === 'mints') return importMints(client, data);
  if (name === 'promotions') return importPromotions(client, data);
  if (name === 'reports') return importReports(client, data);
  throw new Error(`Unknown legacy source ${name}`);
}

async function importAccounts(client, state) {
  let rows = 0;
  for (const value of state.accounts ?? []) { rows += changed(await client.query('insert into player_accounts(id,name,legacy_credential_hash,secured_at,created_at,updated_at) values($1,$2,$3,$4,$5,$6) on conflict do nothing', [value.id, value.name, value.legacyCredentialHash ?? null, date(value.securedAt), date(value.createdAt), date(value.updatedAt)])); }
  for (const value of state.sessions ?? []) { rows += changed(await client.query('insert into player_device_sessions(id,account_id,token_hash,label,created_at,last_seen_at,expires_at,revoked_at) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict do nothing', [value.id, value.accountId, value.tokenHash, value.label, date(value.createdAt), date(value.lastSeenAt), date(value.expiresAt), date(value.revokedAt)])); }
  for (const value of state.passkeys ?? []) { rows += changed(await client.query('insert into player_passkeys(id,account_id,webauthn_user_id,public_key,counter,device_type,backed_up,transports,label,created_at,last_used_at) values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11) on conflict do nothing', [value.id, value.accountId, value.webauthnUserId, value.publicKey, value.counter, value.deviceType, value.backedUp, JSON.stringify(value.transports ?? []), value.label, date(value.createdAt), date(value.lastUsedAt)])); }
  for (const value of state.challenges ?? []) { rows += changed(await client.query('insert into account_challenges(id,kind,challenge,account_id,created_at,expires_at) values($1,$2,$3,$4,$5,$6) on conflict do nothing', [value.id, value.kind, value.challenge, value.accountId ?? null, date(value.createdAt), date(value.expiresAt)])); }
  return rows;
}
async function importArtworks(client, state) { let rows = 0; for (const value of Array.isArray(state) ? state : []) { rows += changed(await client.query(`insert into artworks(id,owner_session_id,origin,status,title,description,canvas_ratio,width,height,strokes,preview_url,source_round_id,mint,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15) on conflict do nothing`, [value.id, value.ownerSessionId, value.origin, value.status, value.title, value.description ?? '', value.canvasRatio, value.width, value.height, JSON.stringify(value.strokes ?? []), value.previewUrl ?? null, value.sourceRoundId ?? null, value.mint ? JSON.stringify(value.mint) : null, date(value.createdAt), date(value.updatedAt)])); } return rows; }
async function importProgression(client, state) {
  let rows = 0;
  for (const raw of state.players ?? []) { const value = { ...raw, equipped: raw.equipped ?? {} }; rows += changed(await client.query(`insert into player_progression(session_id,name,season_id,level,battle_pass,document,first_seen_at,last_seen_at) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8) on conflict do nothing`, [value.sessionId, value.name, value.seasonId, value.level, value.battlePass, JSON.stringify(value), date(value.firstSeenAt), date(value.lastSeenAt)])); }
  for (const key of state.appliedKeys ?? []) rows += changed(await client.query('insert into progression_applied_keys(idempotency_key) values($1) on conflict do nothing', [key]));
  for (const key of state.redemptionKeys ?? []) rows += changed(await client.query('insert into progression_redemption_keys(idempotency_key) values($1) on conflict do nothing', [key]));
  for (const value of state.audit ?? []) rows += changed(await client.query('insert into progression_audit(id,action,actor,at,document) values($1,$2,$3,$4,$5::jsonb) on conflict do nothing', [value.id, value.action, value.actor, date(value.at), JSON.stringify(value)]));
  return rows;
}
async function importMints(client, state) {
  let rows = 0;
  for (const value of state.challenges ?? []) rows += changed(await client.query('insert into wallet_challenges(id,session_id,address,message,expires_at,created_at,used_at) values($1,$2,$3,$4,$5,$6,$7) on conflict do nothing', [value.id, value.sessionId, value.address, value.message, date(value.expiresAt), date(value.createdAt), date(value.usedAt)]));
  for (const value of state.bindings ?? []) rows += changed(await client.query('insert into wallet_bindings(session_id,address,verified_at) values($1,$2,$3) on conflict do nothing', [value.sessionId, value.address, date(value.verifiedAt)]));
  for (const value of state.mints ?? []) rows += changed(await client.query(`insert into mint_records(id,artwork_id,owner_session_id,status,wallet_address,credit_reward_id,credit_unit,discount_reward_id,discount_unit,expires_at,transaction_hash,record,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14) on conflict do nothing`, [value.id, value.artworkId, value.ownerSessionId, value.status, value.walletAddress, value.creditRewardId ?? null, value.creditUnit ?? null, value.discountRewardId ?? null, value.discountUnit ?? null, date(value.expiresAt), value.transactionHash ?? null, JSON.stringify(value), date(value.createdAt), date(value.updatedAt)]));
  return rows;
}
async function importPromotions(client, state) {
  let rows = 0;
  for (const value of state.campaigns ?? []) {
    rows += changed(await client.query(`insert into promotion_campaigns(id,name,code_hash,code_hint,kind,uses_per_player,discount_bps,reason,max_redemptions,starts_at,expires_at,status,created_by,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing`, [value.id, value.name, value.codeHash, value.codeHint, value.kind, value.usesPerPlayer, value.discountBps ?? null, value.reason, value.maxRedemptions, date(value.startsAt), date(value.expiresAt), value.status, value.createdBy, date(value.createdAt), date(value.updatedAt)]));
    for (const redemption of value.redemptions ?? []) rows += changed(await client.query('insert into promotion_redemptions(campaign_id,session_id,redeemed_at) values($1,$2,$3) on conflict do nothing', [value.id, redemption.sessionId, date(redemption.at)]));
  }
  for (const value of state.audit ?? []) rows += changed(await client.query('insert into promotion_audit(id,action,actor,campaign_id,at,detail) values($1,$2,$3,$4,$5,$6) on conflict do nothing', [value.id, value.action, value.actor, value.campaignId, date(value.at), value.detail])); return rows;
}
async function importReports(client, state) { let rows = 0; for (const value of state.reports ?? []) rows += changed(await client.query(`insert into moderation_reports(id,room_id,room_name,reporter_session_id,reporter_name,target_session_id,target_player_id,target_name,category,detail,status,handled_by,resolution_note,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict do nothing`, [value.id, value.roomId, value.roomName, value.reporterSessionId, value.reporterName, value.targetSessionId, value.targetPlayerId, value.targetName, value.category, value.detail, value.status, value.handledBy ?? null, value.resolutionNote ?? null, date(value.createdAt), date(value.updatedAt)])); return rows; }

const date = (milliseconds) => milliseconds === undefined ? null : new Date(milliseconds);
const changed = (result) => Number(result.rowCount ?? 0);
async function main() { const sources = await loadLegacySources(); if (!sources.length) { console.log('No legacy JSON sources found; nothing to import'); return; } const summary = await importLegacySources(process.env.DATABASE_URL, sources); console.log(JSON.stringify({ ok: true, sources: summary })); }
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
