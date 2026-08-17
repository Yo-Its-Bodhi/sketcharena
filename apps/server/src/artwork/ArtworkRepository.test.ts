import { describe, expect, it } from 'vitest';
import { MemoryArtworkRepository, toPanicArchiveItem } from './ArtworkRepository.js';

describe('ArtworkRepository', () => {
  it('treats a repeated arena round save as the same artwork', async () => {
    const repository = new MemoryArtworkRepository();
    const input = {
      ownerSessionId: '11111111-1111-4111-8111-111111111111',
      origin: 'arena' as const,
      status: 'gallery' as const,
      title: 'Panic masterpiece',
      canvasRatio: 'square' as const,
      width: 1200,
      height: 1200,
      strokes: [],
      sourceRoundId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    };

    const first = await repository.save(input);
    const replay = await repository.save(input);

    expect(replay.id).toBe(first.id);
    expect(await repository.listByOwner(input.ownerSessionId)).toHaveLength(1);
  });

  it('publishes only chain-confirmed minted artwork', async () => {
    const repository = new MemoryArtworkRepository();
    const ownerSessionId = '11111111-1111-4111-8111-111111111111';
    const draft = await repository.save({ ownerSessionId, origin: 'studio', status: 'gallery', title: 'Still private', canvasRatio: 'square', width: 1200, height: 1200, strokes: [] });
    const minted = await repository.save({ ownerSessionId, origin: 'arena', status: 'gallery', title: 'Public panic', canvasRatio: 'square', width: 1200, height: 1200, strokes: [] });
    await repository.updateMint(minted.id, ownerSessionId, { network: 'shido', status: 'confirmed', walletAddress: '0x1111111111111111111111111111111111111111', contractAddress: '0x2222222222222222222222222222222222222222', tokenURI: 'ipfs://metadata', tokenId: '7', transactionHash: `0x${'a'.repeat(64)}` }, 'minted');

    expect((await repository.listMinted()).map((item) => item.id)).toEqual([minted.id]);
    expect((await repository.listMinted()).some((item) => item.id === draft.id)).toBe(false);
    const publicItem = toPanicArchiveItem((await repository.listMinted())[0]!);
    expect(publicItem).not.toHaveProperty('ownerSessionId');
    expect(publicItem).not.toHaveProperty('mint.walletAddress');
    expect(publicItem).toMatchObject({ tokenId: '7', seasonId: 0, seasonName: 'The First Mess' });
  });
});
