import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresPromotionRepository } from './PostgresPromotionRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresPromotionRepository integration', () => {
  let pool: Pool; let repository: PostgresPromotionRepository;
  beforeAll(() => { pool = new Pool({ connectionString, max: 2 }); repository = new PostgresPromotionRepository(pool); });
  afterAll(async () => { await pool.end(); });

  it('keeps codes unique and redemptions capped and idempotent', async () => {
    const customCode = `PANIC-CI-${randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase()}`;
    const created = await repository.create({ name: 'CI free mint', kind: 'free-mint', usesPerPlayer: 1, reason: 'Database promotion test', maxRedemptions: 1, expiresAt: 20_000, customCode }, 'ci:admin', 10_000);
    expect((await repository.findByCode(created.code))?.id).toBe(created.campaign.id);
    const sessionId = randomUUID(); expect((await repository.recordRedemption(created.campaign.id, sessionId, 11_000)).redemptions).toHaveLength(1);
    expect((await repository.recordRedemption(created.campaign.id, sessionId, 11_001)).redemptions).toHaveLength(1);
    await expect(repository.recordRedemption(created.campaign.id, randomUUID(), 11_002)).rejects.toThrow(/unavailable/);
    expect((await repository.audit()).some((entry) => entry.campaignId === created.campaign.id)).toBe(true);
  });
});
