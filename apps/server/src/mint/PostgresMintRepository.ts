import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { MintRecord, MintRepository, WalletBindingRecord, WalletChallengeRecord } from './MintRepository.js';

export class PostgresMintRepository implements MintRepository {
  constructor(private readonly pool: Pool) {}

  async createChallenge(input: Omit<WalletChallengeRecord, 'id' | 'createdAt'>, now: number): Promise<WalletChallengeRecord> {
    const record = { ...input, id: randomUUID(), createdAt: now };
    await transaction(this.pool, async (client) => {
      await client.query('delete from wallet_challenges where expires_at<$1', [new Date(now - 86_400_000)]);
      await client.query('insert into wallet_challenges(id,session_id,address,message,expires_at,created_at) values($1,$2,$3,$4,$5,$6)', [record.id, record.sessionId, record.address, record.message, new Date(record.expiresAt), new Date(record.createdAt)]);
    });
    return record;
  }
  async claimChallenge(id: string, sessionId: string, address: `0x${string}`, now: number): Promise<WalletChallengeRecord> {
    const result = await this.pool.query('update wallet_challenges set used_at=$4 where id=$1 and session_id=$2 and lower(address)=lower($3) and used_at is null and expires_at>$4 returning *', [id, sessionId, address, new Date(now)]);
    if (result.rows[0]) return challenge(result.rows[0]);
    const existing = await this.pool.query('select * from wallet_challenges where id=$1 and session_id=$2 and lower(address)=lower($3)', [id, sessionId, address]);
    if (!existing.rows[0]) throw new Error('Wallet challenge not found');
    if (existing.rows[0].used_at) throw new Error('Wallet challenge already used');
    throw new Error('Wallet challenge expired');
  }
  async bindWallet(sessionId: string, address: `0x${string}`, now: number): Promise<WalletBindingRecord> {
    const result = await this.pool.query('insert into wallet_bindings(session_id,address,verified_at) values($1,$2,$3) on conflict(session_id) do update set address=excluded.address,verified_at=excluded.verified_at returning *', [sessionId, address, new Date(now)]);
    return binding(result.rows[0]);
  }
  async getBinding(sessionId: string): Promise<WalletBindingRecord | null> { const result = await this.pool.query('select * from wallet_bindings where session_id=$1', [sessionId]); return result.rows[0] ? binding(result.rows[0]) : null; }
  async getMint(id: string, sessionId: string): Promise<MintRecord | null> { const result = await this.pool.query('select record from mint_records where id=$1 and owner_session_id=$2', [id, sessionId]); return result.rows[0] ? mint(result.rows[0]) : null; }
  async getMintByArtwork(artworkId: string, sessionId: string): Promise<MintRecord | null> { const result = await this.pool.query('select record from mint_records where artwork_id=$1 and owner_session_id=$2', [artworkId, sessionId]); return result.rows[0] ? mint(result.rows[0]) : null; }
  async listMints(sessionId: string): Promise<MintRecord[]> { const result = await this.pool.query('select record from mint_records where owner_session_id=$1 order by updated_at desc', [sessionId]); return result.rows.map(mint); }
  async listCreditReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>> { const result = await this.pool.query("select credit_reward_id,credit_unit from mint_records where credit_reward_id is not null and (status='submitted' or (status='prepared' and expires_at>$1))", [new Date(now)]); return result.rows.map((row) => ({ rewardId: String(row.credit_reward_id), unit: Number(row.credit_unit ?? 0) })); }
  async listDiscountReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>> { const result = await this.pool.query("select discount_reward_id,discount_unit from mint_records where discount_reward_id is not null and (status='submitted' or (status='prepared' and expires_at>$1))", [new Date(now)]); return result.rows.map((row) => ({ rewardId: String(row.discount_reward_id), unit: Number(row.discount_unit ?? 0) })); }
  async saveMint(record: MintRecord): Promise<MintRecord> {
    await transaction(this.pool, async (client) => {
      const conflict = await client.query('select owner_session_id,id from mint_records where artwork_id=$1 for update', [record.artworkId]);
      if (conflict.rows[0] && conflict.rows[0].owner_session_id !== record.ownerSessionId) throw new Error('Artwork mint owner mismatch');
      if (conflict.rows[0] && conflict.rows[0].id !== record.id) throw new Error('Artwork already has a mint lifecycle');
      const saved = await client.query(`insert into mint_records(id,artwork_id,owner_session_id,status,wallet_address,credit_reward_id,credit_unit,discount_reward_id,discount_unit,expires_at,transaction_hash,record,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14)
        on conflict(id) do update set status=excluded.status,wallet_address=excluded.wallet_address,credit_reward_id=excluded.credit_reward_id,credit_unit=excluded.credit_unit,discount_reward_id=excluded.discount_reward_id,discount_unit=excluded.discount_unit,expires_at=excluded.expires_at,transaction_hash=excluded.transaction_hash,record=excluded.record,updated_at=excluded.updated_at
        where mint_records.artwork_id=excluded.artwork_id and mint_records.owner_session_id=excluded.owner_session_id`, mintValues(record));
      if (!saved.rowCount) throw new Error('Mint lifecycle identity mismatch');
    });
    return structuredClone(record);
  }
  async adminSnapshot(limit = 100): Promise<{ wallets: number; total: number; prepared: number; submitted: number; confirmed: number; failed: number; recent: Array<Pick<MintRecord, 'id' | 'artworkId' | 'ownerSessionId' | 'status' | 'walletAddress' | 'usesMintCredit' | 'discountBps' | 'expiresAt' | 'transactionHash' | 'tokenId' | 'error' | 'createdAt' | 'updatedAt'>> }> {
    const [wallets, counts, recent] = await Promise.all([this.pool.query('select count(*)::int count from wallet_bindings'), this.pool.query('select status,count(*)::int count from mint_records group by status'), this.pool.query('select record from mint_records order by updated_at desc limit $1', [Math.max(1, Math.min(500, limit))])]);
    const count = (status: MintRecord['status']) => Number(counts.rows.find((row) => row.status === status)?.count ?? 0);
    return { wallets: Number(wallets.rows[0].count), total: counts.rows.reduce((sum, row) => sum + Number(row.count), 0), prepared: count('prepared'), submitted: count('submitted'), confirmed: count('confirmed'), failed: count('failed'), recent: recent.rows.map(mint).map(({ id, artworkId, ownerSessionId, status, walletAddress, usesMintCredit, discountBps, expiresAt, transactionHash, tokenId, error, createdAt, updatedAt }) => ({ id, artworkId, ownerSessionId, status, walletAddress, usesMintCredit, discountBps, expiresAt, transactionHash, tokenId, error, createdAt, updatedAt })) };
  }
}

async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query('begin'); const result = await operation(client); await client.query('commit'); return result; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } }
function mintValues(record: MintRecord): unknown[] { return [record.id, record.artworkId, record.ownerSessionId, record.status, record.walletAddress, record.creditRewardId ?? null, record.creditUnit ?? null, record.discountRewardId ?? null, record.discountUnit ?? null, new Date(record.expiresAt), record.transactionHash ?? null, JSON.stringify(record), new Date(record.createdAt), new Date(record.updatedAt)]; }
function time(value: unknown): number { return new Date(value as string | number | Date).getTime(); }
function challenge(row: Record<string, unknown>): WalletChallengeRecord { return { id: String(row.id), sessionId: String(row.session_id), address: String(row.address) as `0x${string}`, message: String(row.message), expiresAt: time(row.expires_at), createdAt: time(row.created_at), usedAt: row.used_at ? time(row.used_at) : undefined }; }
function binding(row: Record<string, unknown>): WalletBindingRecord { return { sessionId: String(row.session_id), address: String(row.address) as `0x${string}`, verifiedAt: time(row.verified_at) }; }
function mint(row: Record<string, unknown>): MintRecord { return structuredClone(row.record as MintRecord); }
