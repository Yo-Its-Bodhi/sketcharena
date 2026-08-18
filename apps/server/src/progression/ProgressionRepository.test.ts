import { describe, expect, it } from 'vitest';
import { MemoryProgressionRepository } from './ProgressionRepository.js';

describe('ProgressionRepository', () => {
  it('grants idempotent Mint Credits and records the operator action', async () => {
    const repository = new MemoryProgressionRepository(() => 1234);
    const player = await repository.ensurePlayer('11111111-1111-4111-8111-111111111111', 'Dru');
    const grant = { sessionIds: [player.sessionId], kind: 'mint-credit' as const, amount: 3, reason: 'Season 0 thank you',
      campaignId: 'season-0-thanks', idempotencyKey: 'grant-season-0-thanks-v1', actor: 'admin:test' };

    expect(await repository.grant(grant)).toEqual({ granted: 1, skipped: 0 });
    expect(await repository.grant(grant)).toEqual({ granted: 0, skipped: 1 });
    const grantedReward = (await repository.getPlayer(player.sessionId))?.rewards.find((reward) => reward.campaignId === 'season-0-thanks');
    expect(grantedReward).toMatchObject({ kind: 'mint-credit', amount: 3 });
    expect(await repository.audit()).toHaveLength(1);
    expect((await repository.acknowledge(player.sessionId, grantedReward!.id)).rewards.find((reward) => reward.id === grantedReward!.id)?.acknowledgedAt).toBe(1234);
  });

  it('gives every player exactly one first-mint credit, including older profiles', async () => {
    const repository = new MemoryProgressionRepository(() => 4321);
    const first = await repository.ensurePlayer('33333333-3333-4333-8333-333333333333', 'Chaos');
    const resumed = await repository.ensurePlayer(first.sessionId, 'Chaos Renamed');
    expect(resumed.rewards.filter((reward) => reward.campaignId === 'first-panic-archive-mint')).toHaveLength(1);
    expect(resumed.rewards[0]).toMatchObject({ kind: 'mint-credit', amount: 1, reason: 'Your first Panic Archive mint is on us.', acknowledgedAt: 4321 });
  });

  it('reserves Season 1 Premium exactly once for every Season 0 beta player', async () => {
    const repository = new MemoryProgressionRepository(() => 5432);
    const player = await repository.ensurePlayer('13131313-1313-4313-8313-131313131313', 'Founding Weirdo');
    const resumed = await repository.ensurePlayer(player.sessionId, player.name);
    expect(resumed.passEntitlements).toEqual(['season-1-premium']);
    expect(resumed.battlePass).toBe('free');
    expect(resumed.rewards.filter((reward) => reward.campaignId === 'season-0-founding-weirdos-season-1-premium')).toHaveLength(0);
  });

  it('updates earned progression without duplicating achievement items', async () => {
    const repository = new MemoryProgressionRepository();
    const player = await repository.ensurePlayer('22222222-2222-4222-8222-222222222222', 'Bodhi');
    await repository.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'founders-scribble', reason: 'Early player', campaignId: 'founders', idempotencyKey: 'founders-1', actor: 'admin:test' });
    await repository.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'founders-scribble', reason: 'Duplicate attempt', campaignId: 'founders', idempotencyKey: 'founders-2', actor: 'admin:test' });
    expect((await repository.getPlayer(player.sessionId))?.achievements).toEqual(['founders-scribble']);
  });

  it('unlocks each crossed Season 0 tier once', async () => {
    const repository = new MemoryProgressionRepository(() => 9876);
    const player = await repository.ensurePlayer('44444444-4444-4444-8444-444444444444', 'Minty');
    await repository.grant({ sessionIds: [player.sessionId], kind: 'xp', amount: 4_000, reason: 'Match XP', campaignId: 'match-one', idempotencyKey: 'match-one-xp', actor: 'system:match' });
    const progressed = (await repository.getPlayer(player.sessionId))!;
    expect(progressed.level).toBe(5);
    expect(progressed.items).toEqual(['yellow-weirdo-avatar', 'panic-pencil']);
    expect(progressed.rewards.filter((reward) => reward.campaignId?.startsWith('season-0-level-'))).toHaveLength(3);
    expect(progressed.rewards.find((reward) => reward.campaignId === 'season-0-level-3')).toMatchObject({ kind: 'mint-credit', amount: 1 });
    await repository.grant({ sessionIds: [player.sessionId], kind: 'xp', amount: 1, reason: 'More XP', campaignId: 'match-two', idempotencyKey: 'match-two-xp', actor: 'system:match' });
    expect((await repository.getPlayer(player.sessionId))?.rewards.filter((reward) => reward.campaignId?.startsWith('season-0-level-'))).toHaveLength(3);
  });

  it('unlocks premium tiers retroactively and equips only owned catalog cosmetics', async () => {
    const repository = new MemoryProgressionRepository(() => 12_345);
    const player = await repository.ensurePlayer('66666666-6666-4666-8666-666666666666', 'Pass Gremlin');
    await repository.grant({ sessionIds: [player.sessionId], kind: 'xp', amount: 4_000, reason: 'Already played', campaignId: 'old-xp', idempotencyKey: 'old-xp-key', actor: 'system:match' });
    await repository.grant({ sessionIds: [player.sessionId], kind: 'battle-pass', amount: 1, reason: 'Premium Panic Pass purchase', campaignId: 'season-0-pass', idempotencyKey: 'pass-order-1', actor: 'system:checkout' });
    const premium = (await repository.getPlayer(player.sessionId))!;
    expect(premium.battlePass).toBe('premium');
    expect(premium.items).toEqual(expect.arrayContaining(['green-chaos-avatar', 'neon-panic-brush']));
    expect(premium.rewards.filter((reward) => reward.campaignId?.startsWith('season-0-premium-level-'))).toHaveLength(4);
    await expect(repository.equipItem(player.sessionId, 'golden-chaos-avatar')).rejects.toThrow('not unlocked');
    expect((await repository.equipItem(player.sessionId, 'green-chaos-avatar')).equipped.avatar).toBe('green-chaos-avatar');
    expect((await repository.equipItem(player.sessionId, 'neon-panic-brush')).equipped.brush).toBe('neon-panic-brush');
    await expect(repository.equipItem(player.sessionId, 'made-up-hat')).rejects.toThrow('Unknown');
  });

  it('consumes multi-use Mint Credits one unit at a time and idempotently', async () => {
    const repository = new MemoryProgressionRepository(() => 7777);
    const player = await repository.ensurePlayer('55555555-5555-4555-8555-555555555555', 'Voucher Goblin');
    await repository.grant({ sessionIds: [player.sessionId], kind: 'mint-credit', amount: 2, reason: 'Two trophies', campaignId: 'two-trophies', idempotencyKey: 'grant-two-trophies', actor: 'admin:test' });
    const reward = (await repository.getPlayer(player.sessionId))!.rewards.find((candidate) => candidate.campaignId === 'two-trophies')!;
    await repository.consumeMintCredit(player.sessionId, reward.id, 'mint-one');
    await repository.consumeMintCredit(player.sessionId, reward.id, 'mint-one');
    const partlyUsed = (await repository.getPlayer(player.sessionId))!.rewards.find((candidate) => candidate.id === reward.id)!;
    expect(partlyUsed.redeemedAmount).toBe(1); expect(partlyUsed.redeemedAt).toBeUndefined();
    await repository.consumeMintCredit(player.sessionId, reward.id, 'mint-two');
    expect((await repository.getPlayer(player.sessionId))!.rewards.find((candidate) => candidate.id === reward.id)).toMatchObject({ redeemedAmount: 2, redeemedAt: 7777 });
    await expect(repository.consumeMintCredit(player.sessionId, reward.id, 'mint-three')).rejects.toThrow('unavailable');
  });

  it('records completed matches once across weekly, monthly, season and all-time boards', async () => {
    const now = Date.UTC(2026, 7, 17, 12); const repository = new MemoryProgressionRepository(() => now);
    const alice = await repository.ensurePlayer('77777777-7777-4777-8777-777777777777', 'Alice');
    const bob = await repository.ensurePlayer('88888888-8888-4888-8888-888888888888', 'Bob');
    const match = { matchId: '99999999-9999-4999-8999-999999999999', endedAt: now, players: [
      { sessionId: alice.sessionId, gamePoints: 900, won: true, sharedWin: false, correctGuesses: 3, fastestGuesses: 1, drawings: 4 },
      { sessionId: bob.sessionId, gamePoints: 700, won: false, sharedWin: false, correctGuesses: 2, fastestGuesses: 0, drawings: 4 },
    ] };
    expect(await repository.recordMatch(match)).toEqual({ recorded: true });
    expect(await repository.recordMatch(match)).toEqual({ recorded: false });
    const weekly = await repository.leaderboard('weekly', now);
    expect(weekly.periodKey).toBe('2026-W34'); expect(weekly.entries.map((entry) => entry.name)).toEqual(['Alice', 'Bob']);
    expect(weekly.entries[0]).toMatchObject({ rank: 1, matches: 1, wins: 1, correctGuesses: 3, chaosScore: 835 });
    expect((await repository.leaderboard('monthly', now)).entries[0]?.chaosScore).toBe(835);
    expect((await repository.leaderboard('all-time', now)).entries[0]?.matches).toBe(1);
  });

  it('uses shared ranks for equal leaderboard scores and resets period views in UTC', async () => {
    const monday = Date.UTC(2026, 7, 17, 1); const repository = new MemoryProgressionRepository(() => monday);
    const a = await repository.ensurePlayer('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Alpha'); const b = await repository.ensurePlayer('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Beta');
    await repository.recordMatch({ matchId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', endedAt: monday, players: [a, b].map((player) => ({ sessionId: player.sessionId, gamePoints: 0, won: true, sharedWin: true, correctGuesses: 0, fastestGuesses: 0, drawings: 4 })) });
    expect((await repository.leaderboard('weekly', monday)).entries.map((entry) => entry.rank)).toEqual([1, 1]);
    expect((await repository.leaderboard('weekly', monday + 7 * 86_400_000)).entries).toEqual([]);
    expect((await repository.leaderboard('all-time', monday + 7 * 86_400_000)).entries).toHaveLength(2);
  });
});
