import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresEcosystemRepository } from './PostgresEcosystemRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresEcosystemRepository integration', () => {
  const pool = new Pool({ connectionString, max: 2, application_name: 'sketch-arena-ecosystem-test' });
  const repository = new PostgresEcosystemRepository(pool);
  const accountOne = randomUUID();
  const accountTwo = randomUUID();
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const rewardCode = `ci-cosmetic-${suffix}`;
  const xpRewardCode = `ci-xp-${suffix}`;
  const consumableRewardCode = `ci-credit-${suffix}`;
  const campaignCode = `ci-campaign-${suffix}`;
  const scheduledCampaignCode = `ci-scheduled-${suffix}`;
  const accountNameOne = `CI One ${suffix}`.slice(0, 20);
  const accountNameTwo = `CI Two ${suffix}`.slice(0, 20);
  const walletOne = `0x${createHash('sha256').update(`${suffix}:one`).digest('hex').slice(0, 40)}`;
  const walletTwo = `0x${createHash('sha256').update(`${suffix}:two`).digest('hex').slice(0, 40)}`;

  beforeAll(async () => {
    const schema = await pool.query("select to_regclass('public.bodhix_wallets') wallets,to_regclass('public.bodhix_entitlements') entitlements,to_regclass('public.bodhix_app_memberships') memberships,to_regclass('public.bodhix_reward_claims') claims");
    if (!schema.rows[0]?.wallets || !schema.rows[0]?.entitlements || !schema.rows[0]?.memberships || !schema.rows[0]?.claims) throw new Error('Apply migrations through 015 to TEST_DATABASE_URL before running this suite');
    const now = new Date();
    await pool.query(`insert into player_accounts(id,name,name_key,created_at,updated_at)
      values($1,$2,$3,$5,$5),($4,$6,$7,$5,$5)`, [accountOne, accountNameOne, accountNameOne.toLowerCase(), accountTwo, now, accountNameTwo, accountNameTwo.toLowerCase()]);
  });

  afterAll(async () => {
    await pool.query('delete from player_accounts where id=any($1::uuid[])', [[accountOne, accountTwo]]);
    await pool.query('delete from bodhix_admin_audit where target_id=$1', [rewardCode]);
    await pool.query('delete from bodhix_admin_audit where target_id=$1', [xpRewardCode]);
    await pool.query('delete from bodhix_admin_audit where target_id=$1', [consumableRewardCode]);
    await pool.query('delete from bodhix_campaigns where code=$1', [campaignCode]);
    await pool.query('delete from bodhix_campaigns where code=$1', [scheduledCampaignCode]);
    await pool.query('delete from bodhix_reward_definitions where code=any($1::text[])', [[rewardCode, xpRewardCode, consumableRewardCode]]);
    await pool.end();
  });

  it('enforces one account per wallet and protects the final recovery wallet', async () => {
    const first = await repository.addWallet(accountOne, walletOne, 'Primary', false);
    expect(first.primary).toBe(true);
    await expect(repository.addWallet(accountTwo, walletOne, 'Hijack attempt')).rejects.toThrow('already linked');
    await expect(repository.revokeWallet(accountOne, first.id)).rejects.toThrow('last one');

    const second = await repository.addWallet(accountOne, walletTwo, 'Cold backup');
    const primary = await repository.setPrimaryWallet(accountOne, second.id);
    expect(primary.primary).toBe(true);
    const survivor = await repository.revokeWallet(accountOne, first.id);
    expect(survivor.id).toBe(second.id);
  });

  it('grants rewards once, records them privately and refuses to exceed supply', async () => {
    await repository.saveReward({
      code: rewardCode,
      name: 'CI Grime Card Back',
      kind: 'cosmetic',
      scope: 'ecosystem',
      supplyCap: 2,
      metadata: { test: true },
      status: 'private',
    }, 'ci-admin');

    const request = {
      accountIds: [accountOne, accountTwo],
      rewardCode,
      quantity: 1,
      reason: 'integration rehearsal',
      idempotencyKey: `ci-grant-${suffix}`,
      actor: 'ci-admin',
    };
    expect((await repository.previewGrant(request)).requested).toBe(2);
    expect((await repository.grant(request)).granted).toBe(2);
    expect((await repository.grant(request)).duplicate).toBe(2);
    await expect(repository.grant({ ...request, idempotencyKey: `${request.idempotencyKey}-overflow` })).rejects.toThrow('supply');

    const privateSnapshot = await repository.accountSnapshot(accountOne, true);
    const publicSnapshot = await repository.accountSnapshot(accountOne, false);
    expect(privateSnapshot?.entitlements.some((reward) => reward.code === rewardCode)).toBe(true);
    expect(publicSnapshot?.entitlements.some((reward) => reward.code === rewardCode)).toBe(false);
  });

  it('makes cross-app sign-in codes short-lived, PKCE-bound and single-use', async () => {
    const verifier = `ci-verifier-${randomUUID()}`;
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const redirectUri = 'https://poker.bodhix.io/api/bodhix/callback';
    const issued = await repository.issueAuthCode(accountOne, 'poker', redirectUri, challenge);

    await expect(repository.consumeAuthCode(issued.code, 'poker', redirectUri, 'wrong-verifier')).rejects.toThrow('invalid or expired');
    const consumed = await repository.consumeAuthCode(issued.code, 'poker', redirectUri, verifier);
    expect(consumed.account.id).toBe(accountOne);
    expect(consumed.appSession.token.length).toBeGreaterThan(40);
    const appProfile = await repository.appSnapshot(consumed.appSession.token, 'poker');
    expect(appProfile.account.id).toBe(accountOne);
    expect(appProfile.memberships.some((membership) => membership.appId === 'poker')).toBe(true);
    await expect(repository.consumeAuthCode(issued.code, 'poker', redirectUri, verifier)).rejects.toThrow('invalid or expired');
  });

  it('records app XP once and exposes the same event in app and ecosystem totals', async () => {
    await repository.saveReward({ code: xpRewardCode, name: 'CI Poker XP', kind: 'xp', scope: 'app', appId: 'poker', seasonId: 'beta-0', status: 'private' }, 'ci-admin');
    const input = { accountIds: [accountOne], rewardCode: xpRewardCode, quantity: 750, reason: 'CI poker hand XP', idempotencyKey: `ci-xp-grant-${suffix}`, actor: 'ci-admin' };
    expect((await repository.grant(input)).granted).toBe(1);
    expect((await repository.grant(input)).duplicate).toBe(1);
    const snapshot = await repository.accountSnapshot(accountOne, true);
    expect(snapshot?.xp).toContainEqual({ appId: 'poker', seasonId: 'beta-0', xp: 750 });
    const search = await repository.searchAccounts(accountOne);
    expect(search[0]?.ecosystemXp).toBe(750);
    const verifier = `ci-xp-verifier-${randomUUID()}`; const challenge = createHash('sha256').update(verifier).digest('base64url'); const redirectUri = 'https://poker.bodhix.io/api/bodhix/callback';
    const issued = await repository.issueAuthCode(accountOne, 'poker', redirectUri, challenge); const consumed = await repository.consumeAuthCode(issued.code, 'poker', redirectUri, verifier);
    const receipt = await repository.recordAppXp(consumed.appSession.token, 'poker', 125, 'CI authenticated hand XP', `ci-hand-${suffix}`, 'hand-42', 'beta-0');
    expect(receipt).toMatchObject({ awarded: 125, duplicate: false, appXp: 875, ecosystemXp: 875 });
    expect(await repository.recordAppXp(consumed.appSession.token, 'poker', 125, 'CI authenticated hand XP', `ci-hand-${suffix}`, 'hand-42', 'beta-0')).toMatchObject({ awarded: 0, duplicate: true, appXp: 875, ecosystemXp: 875 });
  });

  it('reserves consumable claims once and restores quantity when an operator rejects one', async () => {
    await repository.saveReward({ code: consumableRewardCode, name: 'CI Mint Credit', kind: 'mint-credit', scope: 'app', appId: 'poker', consumable: true, status: 'live' }, 'ci-admin');
    const grant = { accountIds: [accountOne], rewardCode: consumableRewardCode, quantity: 2, reason: 'CI claim rehearsal', idempotencyKey: `ci-claim-grant-${suffix}`, actor: 'ci-admin' };
    await repository.grant(grant);
    const verifier = `ci-claim-verifier-${randomUUID()}`; const challenge = createHash('sha256').update(verifier).digest('base64url'); const redirectUri = 'https://poker.bodhix.io/api/bodhix/callback';
    const issued = await repository.issueAuthCode(accountOne, 'poker', redirectUri, challenge); const consumed = await repository.consumeAuthCode(issued.code, 'poker', redirectUri, verifier);
    const snapshot = await repository.appSnapshot(consumed.appSession.token, 'poker'); const entitlement = snapshot.entitlements.find((item) => item.code === consumableRewardCode); expect(entitlement?.remaining).toBe(2);
    const claim = await repository.reserveClaim(consumed.appSession.token, 'poker', entitlement!.id, 1, `ci-claim-${suffix}`);
    const duplicate = await repository.reserveClaim(consumed.appSession.token, 'poker', entitlement!.id, 1, `ci-claim-${suffix}`); expect(duplicate.id).toBe(claim.id);
    await repository.resolveClaim(String(claim.id), 'rejected', 'ci-operator');
    const restored = await repository.appSnapshot(consumed.appSession.token, 'poker'); expect(restored.entitlements.find((item) => item.code === consumableRewardCode)?.remaining).toBe(2);
    const fulfilled = await repository.reserveClaim(consumed.appSession.token, 'poker', entitlement!.id, 1, `ci-claim-fulfilled-${suffix}`);
    await repository.resolveClaim(String(fulfilled.id), 'fulfilled', 'ci-operator', `delivery-${suffix}`);
    const reversed = await repository.reverseClaim(String(fulfilled.id), 'ci-admin', `reversal-${suffix}`); expect(reversed.status).toBe('reversed');
    const reversedSnapshot = await repository.appSnapshot(consumed.appSession.token, 'poker'); expect(reversedSnapshot.entitlements.find((item) => item.code === consumableRewardCode)?.remaining).toBe(2);
  });

  it('targets campaigns by real app membership and launches idempotently', async () => {
    const saved = await repository.saveCampaign({ code: campaignCode, name: 'CI Poker Members', rewardCode: consumableRewardCode, appId: 'poker', audience: { kind: 'app', appId: 'poker' }, quantityPerAccount: 1, maxGrants: 10 }, 'ci-admin');
    const preview = await repository.previewCampaign(String(saved.id)); expect(preview.audienceCount).toBeGreaterThanOrEqual(1); expect(preview.sample.some((account) => String(account.id) === accountOne)).toBe(true);
    const launched = await repository.executeCampaign(String(saved.id), 'ci-admin', 'LAUNCH BODHIX CAMPAIGN'); expect(launched.eligible).toBeGreaterThanOrEqual(1);
    const repeated = await repository.executeCampaign(String(saved.id), 'ci-admin', 'LAUNCH BODHIX CAMPAIGN'); expect(repeated.granted).toBe(0);
    const cancelled = await repository.setCampaignStatus(String(saved.id), 'cancelled', 'ci-admin', true); expect(cancelled.revokedUnusedGrants).toBeGreaterThanOrEqual(1);
  });

  it('launches due scheduled campaigns and closes expired campaigns idempotently', async () => {
    const base = Date.now();
    const saved = await repository.saveCampaign({ code: scheduledCampaignCode, name: 'CI Scheduled Poker Members', rewardCode: consumableRewardCode, appId: 'poker', audience: { kind: 'app', appId: 'poker' }, quantityPerAccount: 1, startsAt: base + 100, endsAt: base + 1_000 }, 'ci-admin', base);
    expect(saved.status).toBe('scheduled');
    const launched = await repository.runCampaignMaintenance(base + 200); expect(launched.launched).toContain(String(saved.id)); expect(launched.failed).toHaveLength(0);
    const repeated = await repository.runCampaignMaintenance(base + 300); expect(repeated.launched).toHaveLength(0);
    const ended = await repository.runCampaignMaintenance(base + 1_100); expect(ended.ended).toContain(String(saved.id));
  });
});
