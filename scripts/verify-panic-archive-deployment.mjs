import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, decodeEventLog, getAddress, http, isAddress, maxUint256 } from 'viem';

const candidate = process.argv[2];
const option = (name) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined; };
const stateMode = option('--state') ?? 'paused-pristine';
const canaryTransactionHash = option('--canary-tx');
const expectedCanaryTokenURI = option('--token-uri');
const expectedCanaryPrice = option('--price');
if (!candidate || !isAddress(candidate) || !['paused-pristine', 'live-canary'].includes(stateMode)) throw new Error('Usage: npm run contract:verify:mainnet -- 0xCollectionAddress [--state paused-pristine|live-canary --canary-tx 0xHash --token-uri ipfs://CID --price BaseUnits]');
if (stateMode === 'live-canary' && (!/^0x[0-9a-f]{64}$/i.test(canaryTransactionHash ?? '') || !expectedCanaryTokenURI?.startsWith('ipfs://') || !/^\d+$/.test(expectedCanaryPrice ?? ''))) throw new Error('Live-canary verification requires --canary-tx 0xHash, --token-uri ipfs://CID and --price in WSHIDO base units');
const address = getAddress(candidate);
const rpcUrl = process.env.SHIDO_RPC_URL?.trim() || 'https://evm.shidoscan.net';
const artifact = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.artifact.json'), 'utf8'));
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 12_000 }) });
const expected = {
  owner: getAddress('0xA9E8a36E648E2C5DDc53D9942b88a158B7789E4e'), mintSigner: getAddress('0x44A5920654B1D6DFDC92E201514F1389e6dAc3e7'),
  payoutReceiver: getAddress('0xAe0CEb4Bc23Dfdd552eaE2865481B191C3b28da1'), paymentToken: getAddress('0x8cbaffd9b658997e7bf87e98febf6ea6917166f7'),
  collectionURI: 'https://sketch.bodhix.io/api/archive/metadata',
};

function normalizeImmutables(bytecode, references) {
  const characters = bytecode.slice(2).split('');
  for (const ranges of Object.values(references || {})) for (const { start, length } of ranges) characters.fill('0', start * 2, (start + length) * 2);
  return `0x${characters.join('')}`;
}
const read = (functionName) => client.readContract({ address, abi: artifact.abi, functionName });
const [chainId, code, owner, mintSigner, payoutReceiver, paymentToken, maxSupply, maxMintPrice, artistRoyaltyBps, collectionURI, paused, allowlistRequired, nextTokenId, name, symbol] = await Promise.all([
  client.getChainId(), client.getBytecode({ address }), read('owner'), read('mintSigner'), read('payoutReceiver'), read('paymentToken'), read('maxSupply'), read('maxMintPrice'),
  read('artistRoyaltyBps'), read('contractURI'), read('paused'), read('allowlistRequired'), read('nextTokenId'), read('name'), read('symbol'),
]);
const normalizedActual = code ? normalizeImmutables(code, artifact.immutableReferences) : '0x';
const normalizedExpected = normalizeImmutables(artifact.deployedBytecode, artifact.immutableReferences);
const checks = {
  chainId: chainId === 9008, exactReviewedRuntime: normalizedActual === normalizedExpected, owner: owner === expected.owner, mintSigner: mintSigner === expected.mintSigner,
  payoutReceiver: payoutReceiver === expected.payoutReceiver, paymentToken: paymentToken === expected.paymentToken, unlimitedSupply: maxSupply === maxUint256,
  unlimitedTokenCap: maxMintPrice === maxUint256, artistRoyalty: artistRoyaltyBps === 500n, collectionURI: collectionURI === expected.collectionURI,
  openVoucherPolicy: allowlistRequired === false, identity: name === 'Sketch Arena: The Panic Archive' && symbol === 'PANIC',
};
let canary;
if (stateMode === 'paused-pristine') Object.assign(checks, { startsPaused: paused === true, noMintsYet: nextTokenId === 1n });
else {
  const [receipt, transaction, tokenOwner, tokenURI, royalty] = await Promise.all([
    client.getTransactionReceipt({ hash: canaryTransactionHash }), client.getTransaction({ hash: canaryTransactionHash }),
    client.readContract({ address, abi: artifact.abi, functionName: 'ownerOf', args: [1n] }), client.readContract({ address, abi: artifact.abi, functionName: 'tokenURI', args: [1n] }),
    client.readContract({ address, abi: artifact.abi, functionName: 'royaltyInfo', args: [1n, 10_000n] }),
  ]);
  const mintEvent = receipt.logs.filter((log) => log.address.toLowerCase() === address.toLowerCase()).flatMap((log) => {
    try {
      const decoded = decodeEventLog({ abi: artifact.abi, eventName: 'PanicArchiveMinted', data: log.data, topics: log.topics });
      if (decoded.eventName !== 'PanicArchiveMinted') return [];
      const args = decoded.args; return [{ recipient: args.recipient ?? args[0], tokenId: args.tokenId ?? args[1], artworkHash: args.artworkHash ?? args[2], pricePaid: args.pricePaid ?? args[3], nonce: args.nonce ?? args[4], seasonId: args.seasonId ?? args[5], campaignId: args.campaignId ?? args[6] }];
    } catch { return []; }
  }).find((event) => event.tokenId === 1n);
  const royaltyReceiver = royalty[0]; const royaltyAmount = royalty[1];
  Object.assign(checks, {
    mintingOpen: paused === false, canaryMinted: nextTokenId >= 2n, canaryReceiptSucceeded: receipt.status === 'success',
    canaryTargetsCollection: transaction.to?.toLowerCase() === address.toLowerCase(), canaryEvent: Boolean(mintEvent), canaryPriceMatchesVoucher: mintEvent?.pricePaid === BigInt(expectedCanaryPrice),
    canaryHasCurrentOwner: isAddress(tokenOwner), canaryTokenURI: tokenURI === expectedCanaryTokenURI,
    canaryRoyaltyReceiver: Boolean(mintEvent && royaltyReceiver.toLowerCase() === mintEvent.recipient.toLowerCase()), canaryRoyaltyFivePercent: royaltyAmount === 500n,
  });
  canary = { transactionHash: canaryTransactionHash, blockNumber: receipt.blockNumber.toString(), recipient: mintEvent?.recipient, tokenId: mintEvent?.tokenId?.toString(), pricePaid: mintEvent?.pricePaid?.toString(), owner: tokenOwner, tokenURI, royaltyReceiver, royaltyAmountAt10000: royaltyAmount.toString() };
}
console.log(JSON.stringify({ ready: Object.values(checks).every(Boolean), address, mode: stateMode, checks, state: { owner, mintSigner, payoutReceiver, paymentToken, maxSupply: maxSupply.toString(), maxMintPrice: maxMintPrice.toString(), artistRoyaltyBps: Number(artistRoyaltyBps), collectionURI, paused, allowlistRequired, nextTokenId: nextTokenId.toString(), totalMinted: (nextTokenId - 1n).toString(), name, symbol }, canary, evidence: { sourceSha256: artifact.sourceSha256, evmVersion: artifact.evmVersion, runtimeBytes: code ? (code.length - 2) / 2 : 0, normalizedRuntimeSha256: createHash('sha256').update(normalizedActual).digest('hex') } }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
