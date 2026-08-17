import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, getAddress, http, isAddress, maxUint256 } from 'viem';

const candidate = process.argv[2];
if (!candidate || !isAddress(candidate)) throw new Error('Usage: npm run contract:verify:mainnet -- 0xDeployedCollectionAddress');
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
  unlimitedTokenCap: maxMintPrice === maxUint256, artistRoyalty: artistRoyaltyBps === 500, collectionURI: collectionURI === expected.collectionURI,
  startsPaused: paused === true, openVoucherPolicy: allowlistRequired === false, noMintsYet: nextTokenId === 1n, identity: name === 'Sketch Arena: The Panic Archive' && symbol === 'PANIC',
};
console.log(JSON.stringify({ ready: Object.values(checks).every(Boolean), address, checks, state: { owner, mintSigner, payoutReceiver, paymentToken, maxSupply: maxSupply.toString(), maxMintPrice: maxMintPrice.toString(), artistRoyaltyBps: Number(artistRoyaltyBps), collectionURI, paused, allowlistRequired, nextTokenId: nextTokenId.toString(), name, symbol }, evidence: { sourceSha256: artifact.sourceSha256, evmVersion: artifact.evmVersion, runtimeBytes: code ? (code.length - 2) / 2 : 0, normalizedRuntimeSha256: createHash('sha256').update(normalizedActual).digest('hex') } }, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
