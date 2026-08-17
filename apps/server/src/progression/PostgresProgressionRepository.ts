import type { Pool, PoolClient } from 'pg';
import { consumeMintCreditInState, consumeMintDiscountInState, ensurePlayerInState, equipItemInState, grantInState, type AdminAuditEntry, type PlayerProgress, type ProgressionRepository, type RewardGrantInput } from './ProgressionRepository.js';

interface ProgressionState { players: PlayerProgress[]; audit: AdminAuditEntry[]; appliedKeys: string[]; redemptionKeys: string[]; }

export class PostgresProgressionRepository implements ProgressionRepository {
  constructor(private readonly pool: Pool, private readonly clock: () => number = Date.now) {}

  ensurePlayer(sessionId: string, name: string): Promise<PlayerProgress> { return transaction(this.pool, async (client) => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', [`progression:${sessionId}`]);
    const result = await client.query('select document from player_progression where session_id=$1 for update', [sessionId]);
    const state = stateWith(result.rows[0] ? player(result.rows[0]) : undefined); const updated = ensurePlayerInState(state, sessionId, name, this.clock()); await savePlayer(client, updated); return structuredClone(updated);
  }); }
  async getPlayer(sessionId: string): Promise<PlayerProgress | null> { const result = await this.pool.query('select document from player_progression where session_id=$1', [sessionId]); return result.rows[0] ? player(result.rows[0]) : null; }
  async listPlayers(search = ''): Promise<PlayerProgress[]> { const query = search.trim(); const result = query ? await this.pool.query('select document from player_progression where lower(name) like $1 or session_id like $1 order by last_seen_at desc', [`%${query.toLowerCase()}%`]) : await this.pool.query('select document from player_progression order by last_seen_at desc'); return result.rows.map(player); }
  grant(input: RewardGrantInput): Promise<{ granted: number; skipped: number }> { return transaction(this.pool, async (client) => {
    const applied = await client.query('insert into progression_applied_keys(idempotency_key) values($1) on conflict do nothing returning idempotency_key', [input.idempotencyKey]);
    if (!applied.rowCount) return { granted: 0, skipped: input.sessionIds.length };
    const ids = [...new Set(input.sessionIds)].sort(); const rows = await client.query('select document from player_progression where session_id=any($1::text[]) order by session_id for update', [ids]);
    const state: ProgressionState = { players: rows.rows.map(player), audit: [], appliedKeys: [], redemptionKeys: [] }; const result = grantInState(state, input, this.clock());
    for (const value of state.players) await savePlayer(client, value);
    if (state.audit[0]) await saveAudit(client, state.audit[0]);
    return result;
  }); }
  acknowledge(sessionId: string, rewardId: string): Promise<PlayerProgress> { return transaction(this.pool, async (client) => {
    const value = await lockedPlayer(client, sessionId); const reward = value.rewards.find((candidate) => candidate.id === rewardId); if (!reward) throw new Error('Reward not found'); reward.acknowledgedAt ??= this.clock(); await savePlayer(client, value); return structuredClone(value);
  }); }
  consumeMintCredit(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { return this.consume(sessionId, idempotencyKey, (state) => consumeMintCreditInState(state, sessionId, rewardId, idempotencyKey, amount, this.clock())); }
  consumeMintDiscount(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { return this.consume(sessionId, idempotencyKey, (state) => consumeMintDiscountInState(state, sessionId, rewardId, idempotencyKey, amount, this.clock())); }
  equipItem(sessionId: string, itemId: string): Promise<PlayerProgress> { return transaction(this.pool, async (client) => { const value = await lockedPlayer(client, sessionId); const state = stateWith(value); const updated = equipItemInState(state, sessionId, itemId); await savePlayer(client, updated); return structuredClone(updated); }); }
  async audit(limit = 100): Promise<AdminAuditEntry[]> { const result = await this.pool.query('select document from progression_audit order by at desc limit $1', [Math.max(1, Math.min(500, limit))]); return result.rows.map((row) => structuredClone(row.document as AdminAuditEntry)); }

  private consume(sessionId: string, idempotencyKey: string, operation: (state: ProgressionState) => PlayerProgress): Promise<PlayerProgress> { return transaction(this.pool, async (client) => {
    const value = await lockedPlayer(client, sessionId); const applied = await client.query('insert into progression_redemption_keys(idempotency_key) values($1) on conflict do nothing returning idempotency_key', [idempotencyKey]);
    if (!applied.rowCount) return structuredClone(value);
    const state = stateWith(value); const updated = operation(state); await savePlayer(client, updated); return structuredClone(updated);
  }); }
}

function stateWith(value?: PlayerProgress): ProgressionState { return { players: value ? [value] : [], audit: [], appliedKeys: [], redemptionKeys: [] }; }
async function lockedPlayer(client: PoolClient, sessionId: string): Promise<PlayerProgress> { const result = await client.query('select document from player_progression where session_id=$1 for update', [sessionId]); if (!result.rows[0]) throw new Error('Player not found'); return player(result.rows[0]); }
async function savePlayer(client: PoolClient, value: PlayerProgress): Promise<void> { await client.query(`insert into player_progression(session_id,name,season_id,level,battle_pass,document,first_seen_at,last_seen_at) values($1,$2,$3,$4,$5,$6::jsonb,$7,$8)
  on conflict(session_id) do update set name=excluded.name,season_id=excluded.season_id,level=excluded.level,battle_pass=excluded.battle_pass,document=excluded.document,last_seen_at=excluded.last_seen_at`, [value.sessionId, value.name, value.seasonId, value.level, value.battlePass, JSON.stringify(value), new Date(value.firstSeenAt), new Date(value.lastSeenAt)]); }
async function saveAudit(client: PoolClient, value: AdminAuditEntry): Promise<void> { await client.query('insert into progression_audit(id,action,actor,at,document) values($1,$2,$3,$4,$5::jsonb)', [value.id, value.action, value.actor, new Date(value.at), JSON.stringify(value)]); }
function player(row: Record<string, unknown>): PlayerProgress { return structuredClone(row.document as PlayerProgress); }
async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query('begin'); const result = await operation(client); await client.query('commit'); return result; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } }
