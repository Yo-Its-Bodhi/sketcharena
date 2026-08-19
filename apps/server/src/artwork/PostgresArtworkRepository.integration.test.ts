import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresArtworkRepository } from './PostgresArtworkRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresArtworkRepository integration', () => {
  let pool: Pool; let repository: PostgresArtworkRepository;
  beforeAll(() => { pool = new Pool({ connectionString, max: 2 }); repository = new PostgresArtworkRepository(pool); });
  afterAll(async () => { await pool.end(); });

  it('enforces round idempotency, ownership and confirmed-only public mint listing', async () => {
    const ownerSessionId = randomUUID(); const sourceRoundId = randomUUID();
    const input = { ownerSessionId, sourceRoundId, origin: 'arena' as const, status: 'gallery' as const, title: 'Database panic', canvasRatio: 'square' as const, width: 1200, height: 1200, strokes: [] };
    const first = await repository.save(input); const replay = await repository.save(input);
    expect(replay.id).toBe(first.id); expect(await repository.listByOwner(ownerSessionId)).toHaveLength(1);
    await expect(repository.save({ ...input, id: first.id, ownerSessionId: randomUUID() })).rejects.toThrow(/owner mismatch/);
    await repository.updateMint(first.id, ownerSessionId, { network: 'shido', status: 'confirmed', walletAddress: '0x1111111111111111111111111111111111111111', contractAddress: '0x2222222222222222222222222222222222222222', tokenURI: 'ipfs://metadata', tokenId: '1', transactionHash: `0x${'a'.repeat(64)}` }, 'minted');
    expect((await repository.listMinted()).some((item) => item.id === first.id)).toBe(true);
    expect((await repository.listMinted(100, '0x2222222222222222222222222222222222222222')).some((item) => item.id === first.id)).toBe(true);
    expect((await repository.listMinted(100, '0x3333333333333333333333333333333333333333')).some((item) => item.id === first.id)).toBe(false);
    const attemptedOverwrite = await repository.save({ ...input, id: first.id, status: 'mint-ready', title: 'Accidental overwrite' });
    expect(attemptedOverwrite).toMatchObject({ status: 'minted', title: 'Database panic', mint: { status: 'confirmed', tokenId: '1' } });
    expect(await repository.deleteOwned(first.id, randomUUID())).toBe(false);
    expect(await repository.deleteOwned(first.id, ownerSessionId)).toBe(true);
    expect(await repository.get(first.id)).toBeNull();
  });
});
