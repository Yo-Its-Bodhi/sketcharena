import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MintRecord } from './MintRepository.js';
import { PostgresMintRepository } from './PostgresMintRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;
const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

suite('PostgresMintRepository integration', () => {
  let pool: Pool; let repository: PostgresMintRepository;
  beforeAll(() => { pool = new Pool({ connectionString, max: 2 }); repository = new PostgresMintRepository(pool); });
  afterAll(async () => { await pool.end(); });

  it('claims challenges once and persists live voucher reservations', async () => {
    const sessionId = randomUUID(); const challenge = await repository.createChallenge({ sessionId, address, message: 'CI wallet proof', expiresAt: 2_000 }, 1_000);
    expect((await repository.claimChallenge(challenge.id, sessionId, address, 1_500)).usedAt).toBe(1_500);
    await expect(repository.claimChallenge(challenge.id, sessionId, address, 1_600)).rejects.toThrow(/already used/);
    expect((await repository.bindWallet(sessionId, address, 1_700)).address).toBe(address);

    const record = { id: randomUUID(), artworkId: randomUUID(), ownerSessionId: sessionId, status: 'prepared', walletAddress: address, contractAddress: address,
      chainId: 1, chainName: 'Test', nativeCurrency: { name: 'TEST', symbol: 'TEST', decimals: 18 }, rpcUrls: [], mediaURI: 'ipfs://media', tokenURI: 'ipfs://metadata',
      voucher: { recipient: address, tokenURIHash: `0x${'1'.repeat(64)}` as const, artworkHash: `0x${'2'.repeat(64)}` as const, price: '0', nonce: '1', deadline: '2', seasonId: 0, campaignId: `0x${'3'.repeat(64)}` as const },
      signature: `0x${'4'.repeat(130)}` as const, transactionRequest: { to: address, from: address, value: '0x0' as const, data: '0x00' as const }, usesMintCredit: true,
      creditRewardId: randomUUID(), creditUnit: 0, expiresAt: 2_000, createdAt: 1_000, updatedAt: 1_000 } satisfies MintRecord;
    await repository.saveMint(record);
    expect((await repository.getMintByArtwork(record.artworkId, sessionId))?.id).toBe(record.id);
    expect(await repository.listCreditReservations(1_500)).toContainEqual({ rewardId: record.creditRewardId, unit: 0 });
    expect((await repository.adminSnapshot()).prepared).toBeGreaterThanOrEqual(1);
  });
});
