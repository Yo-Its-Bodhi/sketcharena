import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresProgressionRepository } from './PostgresProgressionRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresProgressionRepository integration', () => {
  let pool: Pool; let repository: PostgresProgressionRepository;
  beforeAll(() => { pool = new Pool({ connectionString, max: 2 }); repository = new PostgresProgressionRepository(pool, () => 10_000); });
  afterAll(async () => { await pool.end(); });

  it('grants once, unlocks premium rewards and consumes a Mint Credit once', async () => {
    const sessionId = randomUUID(); const player = await repository.ensurePlayer(sessionId, 'Progress Weirdo');
    const grant = { sessionIds: [sessionId], kind: 'battle-pass' as const, amount: 1, reason: 'CI Premium Panic Pass', campaignId: `ci-pass-${sessionId}`, idempotencyKey: `ci-pass-order-${sessionId}`, actor: 'system:ci' };
    expect((await repository.grant(grant)).granted).toBe(1); expect((await repository.grant(grant)).granted).toBe(0);
    const premium = (await repository.getPlayer(sessionId))!; expect(premium.battlePass).toBe('premium'); expect(premium.items).toContain('green-chaos-avatar');
    const credit = player.rewards.find((reward) => reward.kind === 'mint-credit')!; const key = `ci-mint-${sessionId}`;
    expect((await repository.consumeMintCredit(sessionId, credit.id, key)).rewards.find((reward) => reward.id === credit.id)?.redeemedAmount).toBe(1);
    expect((await repository.consumeMintCredit(sessionId, credit.id, key)).rewards.find((reward) => reward.id === credit.id)?.redeemedAmount).toBe(1);
    expect((await repository.audit()).some((entry) => entry.idempotencyKey === grant.idempotencyKey)).toBe(true);
  });
});
