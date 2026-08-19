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
  const accountNameOne = `CI One ${suffix}`.slice(0, 20);
  const accountNameTwo = `CI Two ${suffix}`.slice(0, 20);
  const walletOne = `0x${createHash('sha256').update(`${suffix}:one`).digest('hex').slice(0, 40)}`;
  const walletTwo = `0x${createHash('sha256').update(`${suffix}:two`).digest('hex').slice(0, 40)}`;

  beforeAll(async () => {
    const schema = await pool.query("select to_regclass('public.bodhix_wallets') wallets,to_regclass('public.bodhix_entitlements') entitlements");
    if (!schema.rows[0]?.wallets || !schema.rows[0]?.entitlements) throw new Error('Apply migration 014_bodhix_ecosystem.sql to TEST_DATABASE_URL before running this suite');
    const now = new Date();
    await pool.query(`insert into player_accounts(id,name,name_key,created_at,updated_at)
      values($1,$2,$3,$5,$5),($4,$6,$7,$5,$5)`, [accountOne, accountNameOne, accountNameOne.toLowerCase(), accountTwo, now, accountNameTwo, accountNameTwo.toLowerCase()]);
  });

  afterAll(async () => {
    await pool.query('delete from player_accounts where id=any($1::uuid[])', [[accountOne, accountTwo]]);
    await pool.query('delete from bodhix_admin_audit where target_id=$1', [rewardCode]);
    await pool.query('delete from bodhix_admin_audit where target_id=$1', [xpRewardCode]);
    await pool.query('delete from bodhix_reward_definitions where code=any($1::text[])', [[rewardCode, xpRewardCode]]);
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
  });
});
