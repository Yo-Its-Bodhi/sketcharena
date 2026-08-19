import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

export type EcosystemRewardKind = 'cosmetic' | 'xp' | 'badge' | 'title' | 'emote' | 'discount' | 'mint-credit' | 'nft-claim' | 'store-credit' | 'pass-entitlement' | 'consumable';
export type EcosystemScope = 'app' | 'ecosystem';

export interface EcosystemRewardInput {
  code: string;
  name: string;
  kind: EcosystemRewardKind;
  scope: EcosystemScope;
  appId?: string;
  seasonId?: string;
  transferable?: boolean;
  consumable?: boolean;
  supplyCap?: number;
  metadata?: Record<string, unknown>;
  status?: 'draft' | 'private' | 'live' | 'retired';
}

export interface EcosystemGrantInput {
  accountIds: string[];
  rewardCode: string;
  quantity: number;
  reason: string;
  idempotencyKey: string;
  actor: string;
  expiresAt?: number;
  source?: string;
  sourceReference?: string;
}

export class PostgresEcosystemRepository {
  constructor(private readonly pool: Pool) {}

  async overview() {
    const [accounts, wallets, rewards, entitlements, campaigns, apps] = await Promise.all([
      this.pool.query('select count(*)::int count from player_accounts'),
      this.pool.query("select count(*)::int count from bodhix_wallets where revoked_at is null"),
      this.pool.query("select count(*)::int count from bodhix_reward_definitions where status!='retired'"),
      this.pool.query("select count(*)::int count from bodhix_entitlements where status='active' and (expires_at is null or expires_at>now())"),
      this.pool.query("select count(*)::int count from bodhix_campaigns where status in ('scheduled','live','paused')"),
      this.pool.query('select id,name,status from bodhix_apps order by id'),
    ]);
    return {
      accounts: Number(accounts.rows[0]?.count ?? 0), wallets: Number(wallets.rows[0]?.count ?? 0), rewards: Number(rewards.rows[0]?.count ?? 0),
      activeEntitlements: Number(entitlements.rows[0]?.count ?? 0), activeCampaigns: Number(campaigns.rows[0]?.count ?? 0), apps: apps.rows,
    };
  }

  async searchAccounts(search = '', limit = 50) {
    const needle = `%${search.trim().toLocaleLowerCase('en-US')}%`;
    const result = await this.pool.query(`select account.id,account.name,account.secured_at,
      count(distinct wallet.id)::int wallet_count,count(distinct entitlement.id)::int entitlement_count,
      coalesce((select sum(xp.amount) from bodhix_xp_events xp where xp.account_id=account.id),0)::int ecosystem_xp
      from player_accounts account
      left join bodhix_wallets wallet on wallet.account_id=account.id and wallet.revoked_at is null
      left join bodhix_entitlements entitlement on entitlement.account_id=account.id and entitlement.status='active' and (entitlement.expires_at is null or entitlement.expires_at>now())
      where $1='' or account.name_key like $2 or account.id::text=$1
      group by account.id,account.name,account.secured_at order by account.created_at desc limit $3`, [search.trim(), needle, Math.max(1, Math.min(200, limit))]);
    return result.rows.map((row) => ({ id: String(row.id), name: String(row.name), secured: Boolean(row.secured_at), walletCount: Number(row.wallet_count), entitlementCount: Number(row.entitlement_count), ecosystemXp: Number(row.ecosystem_xp) }));
  }

  async accountSnapshot(accountId: string, includePrivate = false) {
    const account = await this.pool.query('select id,name,secured_at,created_at from player_accounts where id=$1', [accountId]);
    if (!account.rows[0]) return null;
    const [wallets, entitlements, xp] = await Promise.all([
      this.pool.query('select id,address,label,is_primary,verified_at from bodhix_wallets where account_id=$1 and revoked_at is null order by is_primary desc,verified_at', [accountId]),
      this.pool.query(`select entitlement.id,reward.code,reward.name,reward.kind,reward.scope,reward.app_id,reward.season_id,entitlement.quantity,entitlement.remaining,entitlement.status,entitlement.expires_at,entitlement.granted_at
        from bodhix_entitlements entitlement join bodhix_reward_definitions reward on reward.id=entitlement.reward_id
        where entitlement.account_id=$1 and entitlement.status='active' and (entitlement.expires_at is null or entitlement.expires_at>now()) and ($2 or reward.status='live') order by entitlement.granted_at desc`, [accountId, includePrivate]),
      this.pool.query('select app_id,season_id,coalesce(sum(amount),0)::int xp from bodhix_xp_events where account_id=$1 group by app_id,season_id order by app_id,season_id', [accountId]),
    ]);
    const value = account.rows[0];
    return {
      account: { id: String(value.id), name: String(value.name), secured: Boolean(value.secured_at), createdAt: new Date(value.created_at).getTime() },
      wallets: wallets.rows.map((row) => ({ id: String(row.id), address: String(row.address), label: String(row.label), primary: Boolean(row.is_primary), verifiedAt: new Date(row.verified_at).getTime() })),
      entitlements: entitlements.rows.map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name), kind: String(row.kind), scope: String(row.scope), appId: row.app_id ? String(row.app_id) : null, seasonId: row.season_id ? String(row.season_id) : null, quantity: Number(row.quantity), remaining: row.remaining === null ? null : Number(row.remaining), status: String(row.status), expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null, grantedAt: new Date(row.granted_at).getTime() })),
      xp: xp.rows.map((row) => ({ appId: String(row.app_id), seasonId: row.season_id ? String(row.season_id) : null, xp: Number(row.xp) })),
    };
  }

  async addWallet(accountId: string, address: string, label = 'Verified wallet', makePrimary = false, now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const normalized = address.toLowerCase();
      const conflict = await client.query('select account_id from bodhix_wallets where lower(address)=$1 and revoked_at is null for update', [normalized]);
      if (conflict.rows[0] && String(conflict.rows[0].account_id) !== accountId) throw new Error('That wallet is already linked to another BodhiX account');
      const existing = await client.query('select id from bodhix_wallets where account_id=$1 and lower(address)=$2 and revoked_at is null', [accountId, normalized]);
      if (makePrimary) await client.query('update bodhix_wallets set is_primary=false where account_id=$1 and revoked_at is null', [accountId]);
      if (existing.rows[0]) {
        const updated = await client.query('update bodhix_wallets set label=$3,is_primary=is_primary or $4,verified_at=$5 where id=$1 and account_id=$2 returning *', [existing.rows[0].id, accountId, label.slice(0, 80), makePrimary, new Date(now)]);
        return wallet(updated.rows[0]);
      }
      const first = await client.query('select not exists(select 1 from bodhix_wallets where account_id=$1 and revoked_at is null) first', [accountId]);
      const inserted = await client.query('insert into bodhix_wallets(id,account_id,address,label,is_primary,verified_at) values($1,$2,$3,$4,$5,$6) returning *', [randomUUID(), accountId, normalized, label.slice(0, 80), makePrimary || Boolean(first.rows[0]?.first), new Date(now)]);
      return wallet(inserted.rows[0]);
    });
  }

  async assertWalletAvailable(accountId: string, address: string) {
    const result = await this.pool.query('select account_id from bodhix_wallets where lower(address)=$1 and revoked_at is null', [address.toLowerCase()]);
    if (result.rows[0] && String(result.rows[0].account_id) !== accountId) throw new Error('That wallet is already linked to another BodhiX account');
  }

  async setPrimaryWallet(accountId: string, walletId: string) {
    return transaction(this.pool, async (client) => {
      const owned = await client.query('select id from bodhix_wallets where id=$1 and account_id=$2 and revoked_at is null for update', [walletId, accountId]);
      if (!owned.rows[0]) throw new Error('That wallet is not linked to this BodhiX account');
      await client.query('update bodhix_wallets set is_primary=false where account_id=$1 and revoked_at is null', [accountId]);
      const result = await client.query('update bodhix_wallets set is_primary=true where id=$1 returning *', [walletId]);
      return wallet(result.rows[0]);
    });
  }

  async revokeWallet(accountId: string, walletId: string, now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const target = await client.query('select * from bodhix_wallets where id=$1 and account_id=$2 and revoked_at is null for update', [walletId, accountId]);
      if (!target.rows[0]) throw new Error('That wallet is not linked to this BodhiX account');
      const remaining = await client.query('select * from bodhix_wallets where account_id=$1 and id<>$2 and revoked_at is null order by is_primary desc,verified_at desc for update', [accountId, walletId]);
      if (!remaining.rows.length) throw new Error('Link another verified wallet before removing the last one');
      await client.query('update bodhix_wallets set revoked_at=$2,is_primary=false where id=$1', [walletId, new Date(now)]);
      let primary = remaining.rows.find((row) => Boolean(row.is_primary));
      if (!primary) { const promoted = await client.query('update bodhix_wallets set is_primary=true where id=$1 returning *', [remaining.rows[0].id]); primary = promoted.rows[0]; }
      return wallet(primary);
    });
  }

  async listRewards(includePrivate = false) {
    const result = await this.pool.query(`select id,code,name,kind,scope,app_id,season_id,transferable,consumable,supply_cap,metadata,status,created_at,updated_at
      from bodhix_reward_definitions where $1 or status='live' order by created_at desc`, [includePrivate]);
    return result.rows;
  }

  async saveReward(input: EcosystemRewardInput, actor = 'system', now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const before = await client.query('select * from bodhix_reward_definitions where code=$1 for update', [input.code]);
      const result = await client.query(`insert into bodhix_reward_definitions(id,code,name,kind,scope,app_id,season_id,transferable,consumable,supply_cap,metadata,status,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
        on conflict(code) do update set name=excluded.name,kind=excluded.kind,scope=excluded.scope,app_id=excluded.app_id,season_id=excluded.season_id,transferable=excluded.transferable,consumable=excluded.consumable,supply_cap=excluded.supply_cap,metadata=excluded.metadata,status=excluded.status,updated_at=excluded.updated_at returning *`,
        [randomUUID(), input.code, input.name, input.kind, input.scope, input.appId ?? null, input.seasonId ?? null, Boolean(input.transferable), Boolean(input.consumable), input.supplyCap ?? null, JSON.stringify(input.metadata ?? {}), input.status ?? 'draft', new Date(now)]);
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,before_state,after_state,created_at)
        values($1,$2,'reward.save','reward',$3,$4,$5,$6,$7)`, [randomUUID(), actor, input.code, `reward.save:${randomUUID()}`, before.rows[0] ? JSON.stringify(before.rows[0]) : null, JSON.stringify(result.rows[0]), new Date(now)]);
      return result.rows[0];
    });
  }

  async previewGrant(input: EcosystemGrantInput) {
    const accounts = await this.pool.query('select id,name from player_accounts where id=any($1::uuid[]) order by name', [input.accountIds]);
    const reward = await this.pool.query('select id,code,name,kind,status,supply_cap from bodhix_reward_definitions where code=$1', [input.rewardCode]);
    if (!reward.rows[0]) throw new Error('Reward not found');
    const issued = await this.pool.query("select coalesce(sum(quantity),0)::bigint count from bodhix_entitlements where reward_id=$1 and status!='revoked'", [reward.rows[0].id]);
    const requested = accounts.rows.length * input.quantity; const cap = reward.rows[0].supply_cap === null ? null : Number(reward.rows[0].supply_cap);
    return { reward: reward.rows[0], accounts: accounts.rows, requested, issued: Number(issued.rows[0]?.count ?? 0), remainingSupply: cap === null ? null : Math.max(0, cap - Number(issued.rows[0]?.count ?? 0)), missingAccountIds: input.accountIds.filter((id) => !accounts.rows.some((row) => String(row.id) === id)) };
  }

  async grant(input: EcosystemGrantInput, now = Date.now()) {
    const preview = await this.previewGrant(input);
    if (preview.missingAccountIds.length) throw new Error('One or more BodhiX accounts do not exist');
    return transaction(this.pool, async (client) => {
      const reward = await client.query('select id,kind,scope,app_id,season_id,consumable,supply_cap from bodhix_reward_definitions where code=$1 for update', [input.rewardCode]);
      if (!reward.rows[0]) throw new Error('Reward not found');
      if (reward.rows[0].kind === 'xp' && !reward.rows[0].app_id) throw new Error('XP rewards must belong to one BodhiX app');
      const issued = await client.query("select coalesce(sum(quantity),0)::bigint count from bodhix_entitlements where reward_id=$1 and status!='revoked'", [reward.rows[0].id]);
      const supplyCap = reward.rows[0].supply_cap === null ? null : Number(reward.rows[0].supply_cap);
      const alreadyIssued = Number(issued.rows[0]?.count ?? 0);
      const grantKeys = preview.accounts.map((account) => `${input.idempotencyKey}:${account.id}`);
      const existingKeys = await client.query('select idempotency_key from bodhix_entitlements where idempotency_key=any($1::text[])', [grantKeys]);
      const existing = new Set(existingKeys.rows.map((row) => String(row.idempotency_key)));
      const newGrantCount = grantKeys.filter((key) => !existing.has(key)).length;
      if (supplyCap !== null && input.quantity * newGrantCount > supplyCap - alreadyIssued) throw new Error('Reward supply would be exceeded');
      const granted = [];
      for (const account of preview.accounts) {
        const idempotencyKey = `${input.idempotencyKey}:${account.id}`;
        const isXp = reward.rows[0].kind === 'xp';
        const result = await client.query(`insert into bodhix_entitlements(id,account_id,reward_id,quantity,remaining,status,source,source_reference,idempotency_key,granted_by,granted_at,expires_at,metadata)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) on conflict(idempotency_key) do nothing returning *`,
          [randomUUID(), account.id, reward.rows[0].id, input.quantity, isXp ? null : reward.rows[0].consumable ? input.quantity : null, isXp ? 'consumed' : 'active', input.source ?? 'admin-grant', input.sourceReference ?? null, idempotencyKey, input.actor, new Date(now), input.expiresAt ? new Date(input.expiresAt) : null, JSON.stringify({ reason: input.reason })]);
        if (result.rows[0] && isXp) await client.query(`insert into bodhix_xp_events(id,account_id,app_id,season_id,amount,reason,idempotency_key,source_reference,created_at,metadata)
          values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(idempotency_key) do nothing`,
          [randomUUID(), account.id, reward.rows[0].app_id, reward.rows[0].season_id, input.quantity, input.reason, `xp:${idempotencyKey}`, input.sourceReference ?? null, new Date(now), JSON.stringify({ rewardCode: input.rewardCode, actor: input.actor })]);
        if (result.rows[0]) granted.push(result.rows[0]);
      }
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,after_state,created_at)
        values($1,$2,'reward.grant','reward',$3,$4,$5,$6) on conflict(idempotency_key) do nothing`, [randomUUID(), input.actor, input.rewardCode, input.idempotencyKey, JSON.stringify({ accountIds: input.accountIds, quantity: input.quantity, reason: input.reason, granted: granted.length }), new Date(now)]);
      return { granted: granted.length, duplicate: preview.accounts.length - granted.length, preview };
    });
  }

  async audit(limit = 100) {
    const result = await this.pool.query('select id,principal,action,target_type,target_id,after_state,created_at from bodhix_admin_audit order by created_at desc limit $1', [Math.max(1, Math.min(500, limit))]);
    return result.rows;
  }

  async issueAuthCode(accountId: string, appId: string, redirectUri: string, pkceChallenge: string, now = Date.now()) {
    const code = randomBytes(32).toString('base64url');
    const codeHash = createHash('sha256').update(code).digest('hex');
    const expiresAt = now + 2 * 60 * 1000;
    await this.pool.query(`insert into bodhix_auth_codes(id,code_hash,account_id,app_id,redirect_uri,pkce_challenge,expires_at,created_at)
      values($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), codeHash, accountId, appId, redirectUri, pkceChallenge, new Date(expiresAt), new Date(now)]);
    return { code, expiresAt };
  }

  async consumeAuthCode(code: string, appId: string, redirectUri: string, verifier: string, now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const codeHash = createHash('sha256').update(code).digest('hex');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const result = await client.query(`select auth.id,auth.account_id,auth.app_id,auth.redirect_uri,auth.pkce_challenge,auth.expires_at,auth.used_at,account.name,account.secured_at
        from bodhix_auth_codes auth join player_accounts account on account.id=auth.account_id where auth.code_hash=$1 for update`, [codeHash]);
      const row = result.rows[0];
      if (!row || row.used_at || new Date(row.expires_at).getTime() < now || row.app_id !== appId || row.redirect_uri !== redirectUri || row.pkce_challenge !== challenge) throw new Error('That BodhiX sign-in handoff is invalid or expired');
      await client.query('update bodhix_auth_codes set used_at=$2 where id=$1', [row.id, new Date(now)]);
      return { account: { id: String(row.account_id), name: String(row.name), secured: Boolean(row.secured_at) } };
    });
  }
}

async function transaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { await client.query('begin'); const result = await work(client); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

function wallet(row: Record<string, unknown>) {
  return { id: String(row.id), accountId: String(row.account_id), address: String(row.address), label: String(row.label), primary: Boolean(row.is_primary), verifiedAt: new Date(row.verified_at as string | Date).getTime() };
}
