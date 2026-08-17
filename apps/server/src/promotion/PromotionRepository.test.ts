import { describe, expect, it } from 'vitest';
import { MemoryProgressionRepository } from '../progression/ProgressionRepository.js';
import { MemoryPromotionRepository, PromotionService } from './PromotionRepository.js';

describe('PromotionService', () => {
  it('issues hashed capped promo codes and redeems each player once', async () => {
    const now = 1_000; const progression = new MemoryProgressionRepository(() => now); const repository = new MemoryPromotionRepository(); const service = new PromotionService(repository, progression, () => now);
    const first = await progression.ensurePlayer('11111111-1111-4111-8111-111111111111', 'First'); const second = await progression.ensurePlayer('22222222-2222-4222-8222-222222222222', 'Second');
    const created = await service.create({ name: 'Season zero thank you', kind: 'free-mint', usesPerPlayer: 2, reason: 'Thanks for making the first mess', maxRedemptions: 2, expiresAt: 10_000 }, 'backstage:owner');
    expect(created.code).toMatch(/^PANIC-/); expect(created.campaign).not.toHaveProperty('codeHash'); expect(created.campaign.codeHint).toContain('…');
    expect(await service.redeem(first.sessionId, created.code.toLowerCase())).toMatchObject({ reward: 'mint-credit', uses: 2 });
    await expect(service.redeem(first.sessionId, created.code)).rejects.toThrow('already redeemed');
    await service.redeem(second.sessionId, created.code);
    const reward = (await progression.getPlayer(first.sessionId))!.rewards.find((candidate) => candidate.campaignId === `promo-${created.campaign.id}`);
    expect(reward).toMatchObject({ kind: 'mint-credit', amount: 2 });
    const ended = (await service.list()).find((campaign) => campaign.id === created.campaign.id); expect(ended?.status).toBe('ended'); expect(ended?.redemptions).toHaveLength(2);
  });

  it('creates percentage discount entitlements and respects pause', async () => {
    const progression = new MemoryProgressionRepository(() => 2_000); const repository = new MemoryPromotionRepository(); const service = new PromotionService(repository, progression, () => 2_000);
    const player = await progression.ensurePlayer('33333333-3333-4333-8333-333333333333', 'Discount Beast');
    const created = await service.create({ name: 'Half price panic', kind: 'mint-discount', usesPerPlayer: 1, discountBps: 5_000, reason: 'Half price trophy', maxRedemptions: 20, expiresAt: 20_000, customCode: 'PANIC-HALF-PRICE' }, 'backstage:owner');
    await service.setPaused(created.campaign.id, true, 'backstage:owner'); await expect(service.redeem(player.sessionId, created.code)).rejects.toThrow('ended');
    await service.setPaused(created.campaign.id, false, 'backstage:owner'); await service.redeem(player.sessionId, created.code);
    expect((await progression.getPlayer(player.sessionId))!.rewards.find((reward) => reward.campaignId === `promo-${created.campaign.id}`)).toMatchObject({ kind: 'mint-discount', amount: 1, discountBps: 5_000 });
  });
});
