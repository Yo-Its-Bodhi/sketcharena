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

export interface EcosystemCampaignInput {
  code: string;
  name: string;
  rewardCode: string;
  appId?: string;
  seasonId?: string;
  audience: { kind: 'all' } | { kind: 'app'; appId: string } | { kind: 'accounts'; accountIds: string[] };
  quantityPerAccount: number;
  maxGrants?: number;
  startsAt?: number;
  endsAt?: number;
  hidden?: boolean;
}

export class PostgresEcosystemRepository {
  constructor(private readonly pool: Pool) {}

  async overview() {
    const [accounts, wallets, rewards, entitlements, campaigns, apps, memberships, pendingClaims] = await Promise.all([
      this.pool.query('select count(*)::int count from player_accounts'),
      this.pool.query("select count(*)::int count from bodhix_wallets where revoked_at is null"),
      this.pool.query("select count(*)::int count from bodhix_reward_definitions where status!='retired'"),
      this.pool.query("select count(*)::int count from bodhix_entitlements where status='active' and (expires_at is null or expires_at>now())"),
      this.pool.query("select count(*)::int count from bodhix_campaigns where status in ('scheduled','live','paused')"),
      this.pool.query('select id,name,status from bodhix_apps order by id'),
      this.pool.query('select app_id,count(*)::int accounts from bodhix_app_memberships group by app_id order by app_id'),
      this.pool.query("select count(*)::int count from bodhix_reward_claims where status='reserved'"),
    ]);
    return {
      accounts: Number(accounts.rows[0]?.count ?? 0), wallets: Number(wallets.rows[0]?.count ?? 0), rewards: Number(rewards.rows[0]?.count ?? 0),
      activeEntitlements: Number(entitlements.rows[0]?.count ?? 0), activeCampaigns: Number(campaigns.rows[0]?.count ?? 0), apps: apps.rows,
      memberships: memberships.rows.map((row) => ({ appId: String(row.app_id), accounts: Number(row.accounts) })),
      pendingClaims: Number(pendingClaims.rows[0]?.count ?? 0),
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
    const [wallets, entitlements, xp, memberships, claims] = await Promise.all([
      this.pool.query('select id,address,label,is_primary,verified_at from bodhix_wallets where account_id=$1 and revoked_at is null order by is_primary desc,verified_at', [accountId]),
      this.pool.query(`select entitlement.id,reward.code,reward.name,reward.kind,reward.scope,reward.app_id,reward.season_id,reward.metadata reward_metadata,entitlement.metadata entitlement_metadata,entitlement.quantity,entitlement.remaining,entitlement.status,entitlement.expires_at,entitlement.granted_at
        from bodhix_entitlements entitlement join bodhix_reward_definitions reward on reward.id=entitlement.reward_id
        where entitlement.account_id=$1 and entitlement.status='active' and (entitlement.expires_at is null or entitlement.expires_at>now()) and ($2 or reward.status='live') order by entitlement.granted_at desc`, [accountId, includePrivate]),
      this.pool.query('select app_id,season_id,coalesce(sum(amount),0)::int xp from bodhix_xp_events where account_id=$1 group by app_id,season_id order by app_id,season_id', [accountId]),
      this.pool.query('select app_id,first_seen_at,last_seen_at from bodhix_app_memberships where account_id=$1 order by last_seen_at desc', [accountId]),
      this.pool.query(`select claim.id,claim.app_id,claim.quantity,claim.status,claim.reserved_at,claim.fulfilled_at,claim.external_reference,reward.code,reward.name
        from bodhix_reward_claims claim join bodhix_entitlements entitlement on entitlement.id=claim.entitlement_id join bodhix_reward_definitions reward on reward.id=entitlement.reward_id
        where claim.account_id=$1 order by claim.reserved_at desc limit 100`, [accountId]),
    ]);
    const value = account.rows[0];
    return {
      account: { id: String(value.id), name: String(value.name), secured: Boolean(value.secured_at), createdAt: new Date(value.created_at).getTime() },
      wallets: wallets.rows.map((row) => ({ id: String(row.id), address: String(row.address), label: String(row.label), primary: Boolean(row.is_primary), verifiedAt: new Date(row.verified_at).getTime() })),
      entitlements: entitlements.rows.map((row) => ({ id: String(row.id), code: String(row.code), name: String(row.name), kind: String(row.kind), scope: String(row.scope), appId: row.app_id ? String(row.app_id) : null, seasonId: row.season_id ? String(row.season_id) : null, quantity: Number(row.quantity), remaining: row.remaining === null ? null : Number(row.remaining), status: String(row.status), expiresAt: row.expires_at ? new Date(row.expires_at).getTime() : null, grantedAt: new Date(row.granted_at).getTime(), metadata: row.reward_metadata ?? {}, grantMetadata: row.entitlement_metadata ?? {} })),
      xp: xp.rows.map((row) => ({ appId: String(row.app_id), seasonId: row.season_id ? String(row.season_id) : null, xp: Number(row.xp) })),
      memberships: memberships.rows.map((row) => ({ appId: String(row.app_id), firstSeenAt: new Date(row.first_seen_at).getTime(), lastSeenAt: new Date(row.last_seen_at).getTime() })),
      claims: claims.rows.map((row) => ({ id: String(row.id), appId: String(row.app_id), code: String(row.code), name: String(row.name), quantity: Number(row.quantity), status: String(row.status), reservedAt: new Date(row.reserved_at).getTime(), fulfilledAt: row.fulfilled_at ? new Date(row.fulfilled_at).getTime() : null, externalReference: row.external_reference ? String(row.external_reference) : null })),
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

  async listCampaigns(limit = 100) {
    const result = await this.pool.query(`select campaign.id,campaign.code,campaign.name,campaign.app_id,campaign.season_id,campaign.status,campaign.hidden,campaign.audience,
      campaign.quantity_per_account,campaign.max_grants,campaign.starts_at,campaign.ends_at,campaign.created_by,campaign.created_at,campaign.updated_at,
      reward.code reward_code,reward.name reward_name,count(grant.account_id)::int granted_count,
      count(grant.account_id) filter(where grant.status='claimed')::int claimed_count
      from bodhix_campaigns campaign join bodhix_reward_definitions reward on reward.id=campaign.reward_id
      left join bodhix_campaign_grants grant on grant.campaign_id=campaign.id
      group by campaign.id,reward.code,reward.name order by campaign.created_at desc limit $1`, [Math.max(1, Math.min(500, limit))]);
    return result.rows;
  }

  async saveCampaign(input: EcosystemCampaignInput, actor: string, now = Date.now()) {
    if (input.endsAt && input.startsAt && input.endsAt <= input.startsAt) throw new Error('Campaign end must be after its start');
    return transaction(this.pool, async (client) => {
      const reward = await client.query('select id from bodhix_reward_definitions where code=$1 and status<>\'retired\'', [input.rewardCode]);
      if (!reward.rows[0]) throw new Error('Reward not found');
      const before = await client.query('select * from bodhix_campaigns where code=$1 for update', [input.code]);
      const status = input.startsAt && input.startsAt > now ? 'scheduled' : 'draft';
      const result = await client.query(`insert into bodhix_campaigns(id,code,name,app_id,season_id,reward_id,status,hidden,audience,quantity_per_account,max_grants,starts_at,ends_at,created_by,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
        on conflict(code) do update set name=excluded.name,app_id=excluded.app_id,season_id=excluded.season_id,reward_id=excluded.reward_id,
        status=case when bodhix_campaigns.status in ('live','ended','cancelled') then bodhix_campaigns.status else excluded.status end,
        hidden=excluded.hidden,audience=excluded.audience,quantity_per_account=excluded.quantity_per_account,max_grants=excluded.max_grants,starts_at=excluded.starts_at,ends_at=excluded.ends_at,updated_at=excluded.updated_at returning *`,
        [randomUUID(), input.code, input.name, input.appId ?? null, input.seasonId ?? null, reward.rows[0].id, status, input.hidden ?? true, JSON.stringify(input.audience), input.quantityPerAccount, input.maxGrants ?? null, input.startsAt ? new Date(input.startsAt) : null, input.endsAt ? new Date(input.endsAt) : null, actor, new Date(now)]);
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,before_state,after_state,created_at)
        values($1,$2,'campaign.save','campaign',$3,$4,$5,$6,$7)`, [randomUUID(), actor, input.code, `campaign.save:${randomUUID()}`, before.rows[0] ? JSON.stringify(before.rows[0]) : null, JSON.stringify(result.rows[0]), new Date(now)]);
      return result.rows[0];
    });
  }

  private async campaignAudience(client: Pool | PoolClient, campaignId: string) {
    const campaign = await client.query('select * from bodhix_campaigns where id=$1', [campaignId]);
    const row = campaign.rows[0]; if (!row) throw new Error('Campaign not found');
    const audience = row.audience as { kind?: string; appId?: string; accountIds?: string[] };
    let accounts;
    if (audience.kind === 'app' && audience.appId) accounts = await client.query('select account.id,account.name from player_accounts account join bodhix_app_memberships membership on membership.account_id=account.id where membership.app_id=$1 order by account.name', [audience.appId]);
    else if (audience.kind === 'accounts' && Array.isArray(audience.accountIds)) accounts = await client.query('select id,name from player_accounts where id=any($1::uuid[]) order by name', [audience.accountIds]);
    else accounts = await client.query('select id,name from player_accounts order by name');
    const already = await client.query('select account_id from bodhix_campaign_grants where campaign_id=$1', [campaignId]);
    const granted = new Set(already.rows.map((item) => String(item.account_id)));
    const eligible = accounts.rows.filter((account) => !granted.has(String(account.id)));
    const max = row.max_grants === null ? null : Number(row.max_grants);
    const remainingSlots = max === null ? eligible.length : Math.max(0, max - already.rows.length);
    return { campaign: row, accounts: accounts.rows, eligible: eligible.slice(0, remainingSlots), alreadyGranted: already.rows.length, capped: max !== null && eligible.length > remainingSlots };
  }

  async previewCampaign(campaignId: string) {
    const audience = await this.campaignAudience(this.pool, campaignId);
    return { campaign: audience.campaign, audienceCount: audience.accounts.length, eligibleCount: audience.eligible.length, alreadyGranted: audience.alreadyGranted, capped: audience.capped, sample: audience.eligible.slice(0, 20) };
  }

  async executeCampaign(campaignId: string, actor: string, confirmation: string, now = Date.now()) {
    if (confirmation !== 'LAUNCH BODHIX CAMPAIGN') throw new Error('Exact campaign confirmation is required');
    const audience = await this.campaignAudience(this.pool, campaignId);
    const campaign = audience.campaign;
    if (['ended','cancelled'].includes(String(campaign.status))) throw new Error('Campaign is permanently closed');
    if (campaign.starts_at && new Date(campaign.starts_at).getTime() > now) throw new Error('Campaign is scheduled for later');
    if (campaign.ends_at && new Date(campaign.ends_at).getTime() <= now) throw new Error('Campaign has ended');
    const reward = await this.pool.query('select code from bodhix_reward_definitions where id=$1', [campaign.reward_id]);
    const idempotencyKey = `campaign:${campaign.id}`;
    const grant = await this.grant({ accountIds: audience.eligible.map((account) => String(account.id)), rewardCode: String(reward.rows[0].code), quantity: Number(campaign.quantity_per_account), reason: `Campaign: ${campaign.name}`, idempotencyKey, actor, source: 'campaign', sourceReference: String(campaign.id), expiresAt: campaign.ends_at ? new Date(campaign.ends_at).getTime() : undefined }, now);
    await transaction(this.pool, async (client) => {
      await client.query(`insert into bodhix_campaign_grants(campaign_id,account_id,entitlement_id,status,granted_at)
        select $1,entitlement.account_id,entitlement.id,'granted',$2 from bodhix_entitlements entitlement
        where entitlement.idempotency_key like $3 on conflict(campaign_id,account_id) do nothing`, [campaign.id, new Date(now), `${idempotencyKey}:%`]);
      await client.query("update bodhix_campaigns set status='live',updated_at=$2 where id=$1 and status not in ('ended','cancelled')", [campaign.id, new Date(now)]);
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,after_state,created_at)
        values($1,$2,'campaign.launch','campaign',$3,$4,$5,$6) on conflict(idempotency_key) do nothing`, [randomUUID(), actor, campaign.code, `campaign.launch:${campaign.id}`, JSON.stringify({ eligible: audience.eligible.length, granted: grant.granted, duplicates: grant.duplicate }), new Date(now)]);
    });
    return { ...grant, campaignId: String(campaign.id), eligible: audience.eligible.length };
  }

  async setCampaignStatus(campaignId: string, status: 'paused' | 'live' | 'ended' | 'cancelled', actor: string, now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const before = await client.query('select * from bodhix_campaigns where id=$1 for update', [campaignId]); if (!before.rows[0]) throw new Error('Campaign not found');
      if (['ended','cancelled'].includes(String(before.rows[0].status)) && before.rows[0].status !== status) throw new Error('A closed campaign cannot be reopened');
      const result = await client.query('update bodhix_campaigns set status=$2,updated_at=$3 where id=$1 returning *', [campaignId, status, new Date(now)]);
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,before_state,after_state,created_at)
        values($1,$2,'campaign.status','campaign',$3,$4,$5,$6,$7)`, [randomUUID(), actor, String(before.rows[0].code), `campaign.status:${randomUUID()}`, JSON.stringify(before.rows[0]), JSON.stringify(result.rows[0]), new Date(now)]);
      return result.rows[0];
    });
  }

  async authenticateAppSession(token: string, appId: string, now = Date.now()) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    return transaction(this.pool, async (client) => {
      const result = await client.query(`select session.id,session.account_id,session.app_id,session.expires_at,session.revoked_at,account.name,account.secured_at
        from bodhix_app_sessions session join player_accounts account on account.id=session.account_id where session.token_hash=$1 for update`, [tokenHash]);
      const row = result.rows[0];
      if (!row || row.revoked_at || row.app_id !== appId || new Date(row.expires_at).getTime() <= now) throw new Error('BodhiX app session is invalid or expired');
      await client.query('update bodhix_app_sessions set last_seen_at=$2 where id=$1', [row.id, new Date(now)]);
      await client.query(`insert into bodhix_app_memberships(account_id,app_id,first_seen_at,last_seen_at,metadata) values($1,$2,$3,$3,'{"source":"app-session"}'::jsonb)
        on conflict(account_id,app_id) do update set last_seen_at=excluded.last_seen_at`, [row.account_id, appId, new Date(now)]);
      return { account: { id: String(row.account_id), name: String(row.name), secured: Boolean(row.secured_at) }, appId, expiresAt: new Date(row.expires_at).getTime() };
    });
  }

  async appSnapshot(token: string, appId: string, now = Date.now()) {
    const authenticated = await this.authenticateAppSession(token, appId, now);
    const snapshot = await this.accountSnapshot(authenticated.account.id, false);
    if (!snapshot) throw new Error('BodhiX account not found');
    return { ...authenticated, entitlements: snapshot.entitlements.filter((item) => item.scope === 'ecosystem' || item.appId === appId), xp: snapshot.xp, memberships: snapshot.memberships };
  }

  async reserveClaim(token: string, appId: string, entitlementId: string, quantity: number, idempotencyKey: string, now = Date.now()) {
    const authenticated = await this.authenticateAppSession(token, appId, now);
    return transaction(this.pool, async (client) => {
      const entitlement = await client.query(`select entitlement.*,reward.scope,reward.app_id,reward.kind,reward.consumable,reward.status reward_status
        from bodhix_entitlements entitlement join bodhix_reward_definitions reward on reward.id=entitlement.reward_id
        where entitlement.id=$1 and entitlement.account_id=$2 for update`, [entitlementId, authenticated.account.id]);
      const row = entitlement.rows[0];
      if (!row || row.status !== 'active' || row.reward_status !== 'live' || (row.expires_at && new Date(row.expires_at).getTime() <= now)) throw new Error('That reward is not available');
      if (row.scope === 'app' && row.app_id !== appId) throw new Error('That reward belongs to another BodhiX app');
      if (!row.consumable || row.remaining === null) throw new Error('That reward does not require a consumable claim');
      if (quantity > Number(row.remaining)) throw new Error('Not enough reward quantity remains');
      const existing = await client.query('select * from bodhix_reward_claims where idempotency_key=$1', [idempotencyKey]); if (existing.rows[0]) return existing.rows[0];
      const claim = await client.query(`insert into bodhix_reward_claims(id,entitlement_id,account_id,app_id,quantity,status,idempotency_key,reserved_at,metadata)
        values($1,$2,$3,$4,$5,'reserved',$6,$7,$8) returning *`, [randomUUID(), entitlementId, authenticated.account.id, appId, quantity, idempotencyKey, new Date(now), JSON.stringify({ rewardKind: row.kind })]);
      const remaining = Number(row.remaining) - quantity;
      await client.query(`update bodhix_entitlements set remaining=$2::bigint,status=case when $2::bigint=0 then 'consumed' else status end where id=$1`, [entitlementId, remaining]);
      return claim.rows[0];
    });
  }

  async recordAppXp(token: string, appId: string, amount: number, reason: string, idempotencyKey: string, sourceReference?: string, seasonId?: string, now = Date.now()) {
    const authenticated = await this.authenticateAppSession(token, appId, now);
    if (!Number.isInteger(amount) || amount <= 0 || amount > 1_000) throw new Error('App XP amount is outside the per-event limit');
    const key = `app-xp:${appId}:${idempotencyKey}`;
    const result = await this.pool.query(`insert into bodhix_xp_events(id,account_id,app_id,season_id,amount,reason,idempotency_key,source_reference,created_at,metadata)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(idempotency_key) do nothing returning id`, [randomUUID(), authenticated.account.id, appId, seasonId ?? null, amount, reason, key, sourceReference ?? null, new Date(now), JSON.stringify({ source: 'authenticated-app-session' })]);
    const total = await this.pool.query('select coalesce(sum(amount),0)::int xp from bodhix_xp_events where account_id=$1', [authenticated.account.id]);
    const app = await this.pool.query('select coalesce(sum(amount),0)::int xp from bodhix_xp_events where account_id=$1 and app_id=$2', [authenticated.account.id, appId]);
    return { awarded: result.rows.length ? amount : 0, duplicate: !result.rows.length, appXp: Number(app.rows[0]?.xp ?? 0), ecosystemXp: Number(total.rows[0]?.xp ?? 0) };
  }

  async listClaims(status?: string, limit = 100) {
    const result = await this.pool.query(`select claim.*,account.name account_name,reward.code reward_code,reward.name reward_name
      from bodhix_reward_claims claim join player_accounts account on account.id=claim.account_id
      join bodhix_entitlements entitlement on entitlement.id=claim.entitlement_id join bodhix_reward_definitions reward on reward.id=entitlement.reward_id
      where $1::text is null or claim.status=$1 order by claim.reserved_at desc limit $2`, [status ?? null, Math.max(1, Math.min(500, limit))]);
    return result.rows;
  }

  async resolveClaim(claimId: string, status: 'fulfilled' | 'rejected', actor: string, externalReference?: string, now = Date.now()) {
    return transaction(this.pool, async (client) => {
      const before = await client.query('select * from bodhix_reward_claims where id=$1 for update', [claimId]); const claim = before.rows[0];
      if (!claim) throw new Error('Claim not found'); if (claim.status !== 'reserved') throw new Error('Only reserved claims may be resolved');
      const timestampColumn = status === 'fulfilled' ? 'fulfilled_at' : 'rejected_at';
      if (status === 'rejected') await client.query(`update bodhix_entitlements set remaining=coalesce(remaining,0)+$2,status='active' where id=$1`, [claim.entitlement_id, claim.quantity]);
      const result = await client.query(`update bodhix_reward_claims set status=$2,${timestampColumn}=$3,handled_by=$4,external_reference=$5 where id=$1 returning *`, [claimId, status, new Date(now), actor, externalReference ?? null]);
      await client.query(`insert into bodhix_admin_audit(id,principal,action,target_type,target_id,idempotency_key,before_state,after_state,created_at)
        values($1,$2,'claim.resolve','claim',$3,$4,$5,$6,$7)`, [randomUUID(), actor, claimId, `claim.resolve:${claimId}`, JSON.stringify(claim), JSON.stringify(result.rows[0]), new Date(now)]);
      return result.rows[0];
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
      await client.query(`insert into bodhix_app_memberships(account_id,app_id,first_seen_at,last_seen_at,metadata) values($1,$2,$3,$3,'{"source":"pkce"}'::jsonb)
        on conflict(account_id,app_id) do update set last_seen_at=excluded.last_seen_at`, [row.account_id, appId, new Date(now)]);
      const appToken = randomBytes(32).toString('base64url'); const appTokenHash = createHash('sha256').update(appToken).digest('hex'); const appSessionExpiresAt = now + 30 * 24 * 60 * 60 * 1000;
      await client.query(`insert into bodhix_app_sessions(id,token_hash,account_id,app_id,created_at,expires_at,last_seen_at,metadata)
        values($1,$2,$3,$4,$5,$6,$5,$7)`, [randomUUID(), appTokenHash, row.account_id, appId, new Date(now), new Date(appSessionExpiresAt), JSON.stringify({ redirectUri })]);
      return { account: { id: String(row.account_id), name: String(row.name), secured: Boolean(row.secured_at) }, appSession: { token: appToken, expiresAt: appSessionExpiresAt } };
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
