import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, parseAbi, parseAbiItem, verifyTypedData, type Hex, type Transaction, type TransactionReceipt } from 'viem';
import { MemoryArtworkRepository } from '../artwork/ArtworkRepository.js';
import { MemoryProgressionRepository } from '../progression/ProgressionRepository.js';
import { MemoryMintRepository } from './MintRepository.js';
import { MintService, type ChainReader, type MintConfiguration } from './MintService.js';

const userKey = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex;
const signerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex;
const contract = '0x5FbDB2315678afecb367f032d93F642f64180aa3' as const;
const paymentToken = '0x8cbaffd9b658997e7bf87e98febf6ea6917166f7' as const;

describe('MintService', () => {
  it('verifies real wallet ownership and prepares a valid free EIP-712 voucher', async () => {
    const artwork = new MemoryArtworkRepository(); const progression = new MemoryProgressionRepository(() => 1_000); const mints = new MemoryMintRepository();
    const player = await progression.ensurePlayer('11111111-1111-4111-8111-111111111111', 'Dru');
    const art = await artwork.save({ ownerSessionId: player.sessionId, origin: 'studio', status: 'mint-ready', title: 'Angry spaghetti', canvasRatio: 'square', width: 1200, height: 1200,
      strokes: [{ id: 'mark', tool: 'pencil', color: '#171514', size: 4, points: [{ x: .1, y: .1 }, { x: .9, y: .9 }], at: 1 }] });
    let pin = 0; const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => String(input).startsWith('http://price')
      ? new Response(JSON.stringify({ price_usd: 1 }), { status: 200 })
      : new Response(JSON.stringify({ Hash: `bafy-test-${++pin}` }), { status: 200 }));
    const config: MintConfiguration = { enabled: true, missing: [], contractAddress: contract, chainId: 31337, chainName: 'Local EVM', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrl: 'http://127.0.0.1:8545', walletRpcUrls: ['http://127.0.0.1:8545'], ipfsApiUrl: 'http://127.0.0.1:5001', ipfsPublicGateway: 'http://127.0.0.1:8080/ipfs', signerPrivateKey: signerKey,
      paymentToken, mintUsdCents: 99, priceApiUrl: 'http://price-primary', priceFallbackApiUrl: 'http://price-fallback', maxPriceDeviationBps: 1_000,
      voucherLifetimeMs: 900_000, requiredConfirmations: 1, publicOrigin: 'http://localhost:5173' };
    let receipt: TransactionReceipt | null = null; let transaction: Transaction | null = null;
    const chain = { getTransactionReceipt: async () => receipt!, getTransaction: async () => transaction!, getBlockNumber: async () => 10n } satisfies ChainReader;
    const service = new MintService(artwork, progression, mints, config, () => 1_000, fetcher, chain, async () => []);
    const access = service.prepareContractAccessTransaction({ action: 'set-blocked', address: privateKeyToAccount(userKey).address, enabled: true });
    expect(access.summary).toMatch(/^Block /); expect(decodeFunctionData({ abi: parseAbi(['function setRecipientBlocked(address recipient,bool blocked)']), data: access.request.data })).toMatchObject({ functionName: 'setRecipientBlocked', args: [privateKeyToAccount(userKey).address, true] });
    const approval = service.prepareContractAccessTransaction({ action: 'set-approved', address: privateKeyToAccount(userKey).address, enabled: true });
    expect(approval.summary).toMatch(/^Approve /); expect(decodeFunctionData({ abi: parseAbi(['function setRecipientApproved(address recipient,bool approved)']), data: approval.request.data })).toMatchObject({ functionName: 'setRecipientApproved', args: [privateKeyToAccount(userKey).address, true] });
    const allowlist = service.prepareContractAccessTransaction({ action: 'set-allowlist', enabled: true });
    expect(allowlist.summary).toContain('Require approved wallets'); expect(decodeFunctionData({ abi: parseAbi(['function setAllowlistRequired(bool required)']), data: allowlist.request.data })).toMatchObject({ functionName: 'setAllowlistRequired', args: [true] });
    const paused = service.prepareContractAccessTransaction({ action: 'set-paused', enabled: true });
    expect(paused.summary).toContain('Pause all'); expect(decodeFunctionData({ abi: parseAbi(['function pause()']), data: paused.request.data })).toMatchObject({ functionName: 'pause' });
    const unpaused = service.prepareContractAccessTransaction({ action: 'set-paused', enabled: false });
    expect(unpaused.summary).toContain('Unpause'); expect(decodeFunctionData({ abi: parseAbi(['function unpause()']), data: unpaused.request.data })).toMatchObject({ functionName: 'unpause' });
    const user = privateKeyToAccount(userKey); const challenge = await service.createChallenge(player.sessionId, user.address); const proof = await user.signMessage({ message: challenge.message });
    expect(await service.verifyWallet(player.sessionId, challenge.challengeId, user.address, proof)).toMatchObject({ address: user.address });
    const prepared = await service.prepare(player.sessionId, art.id);
    expect(prepared).toMatchObject({ status: 'prepared', walletAddress: user.address, usesMintCredit: true, tokenURI: 'ipfs://bafy-test-2' });
    expect(prepared.voucher.price).toBe('0'); expect(fetcher).toHaveBeenCalledTimes(2);
    const metadataFile = (fetcher.mock.calls[1]?.[1]?.body as FormData).get('file') as File;
    const metadata = JSON.parse(await metadataFile.text()) as Record<string, unknown>;
    expect(metadata).toMatchObject({ external_url: 'http://localhost:5173/archive', image: 'ipfs://bafy-test-1' });
    expect(JSON.stringify(metadata)).not.toContain(player.sessionId);
    expect(await verifyTypedData({ address: privateKeyToAccount(signerKey).address, domain: { name: 'Sketch Arena: The Panic Archive', version: '1', chainId: 31337, verifyingContract: contract },
      types: { MintVoucher: [{ name: 'recipient', type: 'address' }, { name: 'tokenURIHash', type: 'bytes32' }, { name: 'artworkHash', type: 'bytes32' }, { name: 'price', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'seasonId', type: 'uint32' }, { name: 'campaignId', type: 'bytes32' }] }, primaryType: 'MintVoucher',
      message: { ...prepared.voucher, price: BigInt(prepared.voucher.price), nonce: BigInt(prepared.voucher.nonce), deadline: BigInt(prepared.voucher.deadline) }, signature: prepared.signature })).toBe(true);
    expect((await artwork.get(art.id))?.mint).toMatchObject({ status: 'prepared', tokenURI: 'ipfs://bafy-test-2' });

    const event = parseAbiItem('event PanicArchiveMinted(address indexed recipient,uint256 indexed tokenId,bytes32 indexed artworkHash,uint256 pricePaid,uint256 nonce,uint32 seasonId,bytes32 campaignId)');
    const topics = encodeEventTopics({ abi: [event], eventName: 'PanicArchiveMinted', args: { recipient: user.address, tokenId: 7n, artworkHash: prepared.voucher.artworkHash } });
    const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint32' }, { type: 'bytes32' }], [0n, BigInt(prepared.voucher.nonce), 0, prepared.voucher.campaignId]);
    receipt = { status: 'success', blockNumber: 10n, logs: [{ address: contract, data, topics }] } as unknown as TransactionReceipt;
    transaction = { to: contract, from: user.address, value: 0n, input: prepared.transactionRequest.data } as unknown as Transaction;
    const result = await service.confirm(player.sessionId, prepared.id, `0x${'9'.repeat(64)}`);
    expect(result).toMatchObject({ pending: false, mint: { status: 'confirmed', tokenId: '7' } });
    const firstCredit = (await progression.getPlayer(player.sessionId))!.rewards.find((reward) => reward.campaignId === 'first-panic-archive-mint');
    expect(firstCredit).toMatchObject({ redeemedAmount: 1, redeemedAt: 1_000 });
    expect((await artwork.get(art.id))?.status).toBe('minted');

    await progression.grant({ sessionIds: [player.sessionId], kind: 'mint-discount', amount: 1, discountBps: 2_500, reason: 'Quarter off', campaignId: 'quarter-off', idempotencyKey: 'quarter-off-player', actor: 'admin:test' });
    const secondArt = await artwork.save({ ownerSessionId: player.sessionId, origin: 'studio', status: 'mint-ready', title: 'Discount disaster', canvasRatio: 'square', width: 1200, height: 1200,
      strokes: [{ id: 'mark-two', tool: 'pencil', color: '#ef4444', size: 6, points: [{ x: .2, y: .8 }, { x: .8, y: .2 }], at: 2 }] });
    const discounted = await service.prepare(player.sessionId, secondArt.id);
    expect(discounted).toMatchObject({ usesMintCredit: false, discountBps: 2_500, paymentToken: { symbol: 'WSHIDO' }, priceQuote: { usdCents: 99, tokenUsd: 1, source: 'BodhiX market feed' } });
    expect(discounted.voucher.price).toBe('742500000000000000'); expect(discounted.transactionRequest.value).toBe('0x0');
    expect(decodeFunctionData({ abi: parseAbi(['function approve(address spender,uint256 amount) returns (bool)']), data: discounted.approvalRequest!.data })).toMatchObject({ functionName: 'approve', args: [contract, 742500000000000000n] });
    fetcher.mockImplementation(async (input) => new Response(JSON.stringify({ price_usd: String(input).includes('fallback') ? 2 : 1 }), { status: 200 }));
    const thirdArt = await artwork.save({ ownerSessionId: player.sessionId, origin: 'studio', status: 'mint-ready', title: 'Price feed panic', canvasRatio: 'square', width: 1200, height: 1200,
      strokes: [{ id: 'mark-three', tool: 'pencil', color: '#171514', size: 2, points: [{ x: .1, y: .5 }, { x: .9, y: .5 }], at: 3 }] });
    await expect(service.prepare(player.sessionId, thirdArt.id)).rejects.toThrow('price feeds disagree');
  });

  it('fails closed until the live contract, signer, price cap and IPFS checks pass', async () => {
    const config: MintConfiguration = { enabled: true, missing: [], contractAddress: contract, chainId: 31337, chainName: 'Local EVM', nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrl: 'http://127.0.0.1:8545', walletRpcUrls: ['http://127.0.0.1:8545'], ipfsApiUrl: 'http://127.0.0.1:5001', ipfsPublicGateway: 'http://127.0.0.1:8080/ipfs', signerPrivateKey: signerKey,
      paymentToken, mintUsdCents: 99, priceApiUrl: 'http://price-primary', priceFallbackApiUrl: 'http://price-fallback', maxPriceDeviationBps: 1_000,
      voucherLifetimeMs: 900_000, requiredConfirmations: 1, publicOrigin: 'http://localhost:5173' };
    let failures = ['PANIC_ARCHIVE_SIGNER_MISMATCH'];
    const service = new MintService(new MemoryArtworkRepository(), new MemoryProgressionRepository(), new MemoryMintRepository(), config, Date.now, fetch, undefined, async () => failures);
    expect(service.status()).toMatchObject({ enabled: false, missing: ['PANIC_ARCHIVE_VERIFICATION_PENDING'] });
    expect(await service.verifyInfrastructure(true)).toMatchObject({ enabled: false, missing: ['PANIC_ARCHIVE_SIGNER_MISMATCH'] });
    failures = [];
    expect(await service.verifyInfrastructure(true)).toMatchObject({ enabled: true, missing: [] });
  });
});
