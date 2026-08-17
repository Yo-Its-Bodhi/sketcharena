import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, parseAbiParameters } from 'viem';
import { PANIC_ARCHIVE_DEPLOYMENT, preparePanicArchiveDeployment } from './PanicArchiveDeployment.js';
import type { MintConfiguration } from './MintService.js';

const config = {
  chainId: 9008, chainName: 'Shido', nativeCurrency: { name: 'Shido', symbol: 'SHIDO', decimals: 18 }, walletRpcUrls: ['https://rpc.shidoscan.com'], enabled: false, missing: [], mintUsdCents: 99,
  priceApiUrl: 'https://example.com/price', priceFallbackApiUrl: 'https://example.com/fallback', maxPriceDeviationBps: 1_000, voucherLifetimeMs: 900_000,
  requiredConfirmations: 3, publicOrigin: 'https://sketch.bodhix.io',
} satisfies MintConfiguration;
const artifactPath = resolve(process.cwd(), '..', '..', 'contracts', 'SketchArenaPanicArchive.artifact.json');

describe('Panic Archive deployment preparation', () => {
  it('builds the reviewed paused collection deployment for the approved owner', () => {
    const transaction = preparePanicArchiveDeployment(config, artifactPath);
    expect(transaction.owner).toBe(PANIC_ARCHIVE_DEPLOYMENT.owner);
    expect(transaction.chainId).toBe(9008);
    expect(transaction.request.data.startsWith('0x')).toBe(true);
    expect(transaction.parameters).toMatchObject({ startsPaused: true, artistRoyaltyPercent: 5, collectionMetadataURI: 'https://sketch.bodhix.io/api/archive/metadata' });
    expect(transaction.artifact.deployedBytes).toBeGreaterThan(10_000);
    const encodedArguments = encodeAbiParameters(parseAbiParameters('address,address,address,address,uint256,uint256,string,uint96'), [PANIC_ARCHIVE_DEPLOYMENT.owner, PANIC_ARCHIVE_DEPLOYMENT.mintSigner, PANIC_ARCHIVE_DEPLOYMENT.payoutReceiver, PANIC_ARCHIVE_DEPLOYMENT.paymentToken, PANIC_ARCHIVE_DEPLOYMENT.maxSupply, PANIC_ARCHIVE_DEPLOYMENT.maxMintPrice, PANIC_ARCHIVE_DEPLOYMENT.collectionMetadataURI, BigInt(PANIC_ARCHIVE_DEPLOYMENT.artistRoyaltyBps)]);
    expect(transaction.request.data.endsWith(encodedArguments.slice(2))).toBe(true);
  });

  it('refuses to prepare a duplicate when a collection is already configured', () => {
    expect(() => preparePanicArchiveDeployment({ ...config, contractAddress: '0x0000000000000000000000000000000000000001' }, artifactPath)).toThrow(/already configured/i);
  });
});
