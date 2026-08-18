import { describe, expect, it } from 'vitest';
import { MemoryMintRepository, type MintRecord } from './MintRepository.js';

const address = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const;

describe('MintRepository', () => {
  it('makes wallet challenges single-use and binds the verified address', async () => {
    const repository = new MemoryMintRepository();
    const challenge = await repository.createChallenge({ sessionId: 'session', address, message: 'prove it', expiresAt: 2_000 }, 1_000);
    expect(await repository.claimChallenge(challenge.id, 'session', address, 1_500)).toMatchObject({ usedAt: 1_500 });
    await expect(repository.claimChallenge(challenge.id, 'session', address, 1_600)).rejects.toThrow('already used');
    expect(await repository.bindWallet('session', address, 1_700)).toEqual({ sessionId: 'session', address, verifiedAt: 1_700 });
  });

  it('tracks only live Mint Credit reservations', async () => {
    const repository = new MemoryMintRepository();
    const base = { id: 'mint', artworkId: 'art', ownerSessionId: 'session', status: 'prepared', walletAddress: address, contractAddress: address,
      chainId: 1, chainName: 'Test', nativeCurrency: { name: 'TEST', symbol: 'TEST', decimals: 18 }, paymentToken: { address, name: 'Wrapped Test', symbol: 'WTEST', decimals: 18 }, rpcUrls: [], mediaURI: 'ipfs://media', tokenURI: 'ipfs://metadata',
      voucher: { recipient: address, tokenURIHash: `0x${'1'.repeat(64)}` as const, artworkHash: `0x${'2'.repeat(64)}` as const, price: '0', nonce: '1', deadline: '2', seasonId: 0, campaignId: `0x${'3'.repeat(64)}` as const },
      signature: `0x${'4'.repeat(130)}` as const, transactionRequest: { to: address, from: address, value: '0x0' as const, data: '0x00' as const }, usesMintCredit: true,
      creditRewardId: 'reward', creditUnit: 0, expiresAt: 2_000, createdAt: 1_000, updatedAt: 1_000 } satisfies MintRecord;
    await repository.saveMint(base);
    expect(await repository.listCreditReservations(1_500)).toEqual([{ rewardId: 'reward', unit: 0 }]);
    expect(await repository.listCreditReservations(2_001)).toEqual([]);
  });
});
