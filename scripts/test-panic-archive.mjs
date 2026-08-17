import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const siblingModules = process.env.PANIC_ARCHIVE_NODE_MODULES
  ? resolve(process.env.PANIC_ARCHIVE_NODE_MODULES)
  : resolve(process.cwd(), '..', 'nftvault', 'node_modules');
let solc;
let ethers;
try { solc = require('solc'); } catch { solc = require(resolve(siblingModules, 'solc')); }
try { ethers = require('ethers'); } catch { ethers = require(resolve(siblingModules, 'ethers')); }
const { ContractFactory, JsonRpcProvider, NonceManager, MaxUint256, TypedDataEncoder, Wallet, ZeroAddress, id, keccak256, parseEther, toUtf8Bytes } = ethers;

const contractSource = readFileSync(resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.sol'), 'utf8');
const reentrantReceiverSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
interface IPanicArchive {
  struct MintVoucher { address recipient; bytes32 tokenURIHash; bytes32 artworkHash; uint256 price; uint256 nonce; uint256 deadline; uint32 seasonId; bytes32 campaignId; }
  function redeem(MintVoucher calldata voucher, string calldata tokenURI, bytes calldata signature) external returns (uint256);
}
contract ReentrantReceiver {
  IPanicArchive public immutable archive;
  IPanicArchive.MintVoucher private voucher;
  string private tokenURI;
  bytes private signature;
  bool public reentrySucceeded;
  bool private armed;
  constructor(address archive_) { archive = IPanicArchive(archive_); }
  function attack(IPanicArchive.MintVoucher calldata voucher_, string calldata tokenURI_, bytes calldata signature_) external {
    voucher = voucher_; tokenURI = tokenURI_; signature = signature_; armed = true;
    archive.redeem(voucher_, tokenURI_, signature_);
    armed = false;
  }
  function onERC721Received(address, address, uint256, bytes calldata) external returns (bytes4) {
    if (armed) {
      IPanicArchive.MintVoucher memory replay = voucher;
      (reentrySucceeded,) = address(archive).call(abi.encodeWithSelector(IPanicArchive.redeem.selector, replay, tokenURI, signature));
    }
    return this.onERC721Received.selector;
  }
}`;
const mockTokenSource = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
contract MockWSHIDO is ERC20 {
  constructor() ERC20("Wrapped Shido", "WSHIDO") {}
  function mint(address recipient, uint256 amount) external { _mint(recipient, amount); }
}`;
const input = { language: 'Solidity', sources: { 'contracts/SketchArenaPanicArchive.sol': { content: contractSource }, 'contracts/test/ReentrantReceiver.sol': { content: reentrantReceiverSource }, 'contracts/test/MockWSHIDO.sol': { content: mockTokenSource } }, settings: { evmVersion: 'paris', optimizer: { enabled: true, runs: 200 }, outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const findImport = (name) => {
  for (const candidate of [resolve(process.cwd(), name), resolve(process.cwd(), 'node_modules', name), resolve(siblingModules, name)]) {
    try { return { contents: readFileSync(candidate, 'utf8') }; } catch { /* continue */ }
  }
  return { error: `Import not found: ${name}` };
};
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
const errors = (output.errors ?? []).filter((item) => item.severity === 'error');
if (errors.length) throw new Error(errors.map((item) => item.formattedMessage).join('\n'));
const compiled = output.contracts['contracts/SketchArenaPanicArchive.sol'].SketchArenaPanicArchive;
const compiledReceiver = output.contracts['contracts/test/ReentrantReceiver.sol'].ReentrantReceiver;
const compiledToken = output.contracts['contracts/test/MockWSHIDO.sol'].MockWSHIDO;

const provider = new JsonRpcProvider(process.env.PANIC_ARCHIVE_RPC ?? 'http://127.0.0.1:8546');
const signingWallet = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', provider);
const owner = new NonceManager(signingWallet);
const freshOwner = () => provider.getSigner(0);
const recipient = await provider.getSigner(1);
const recipientAddress = await recipient.getAddress();
const expectDeploymentFailure = async (args, label) => {
  let reverted = false;
  try { await new ContractFactory(compiled.abi, `0x${compiled.evm.bytecode.object}`, await provider.getSigner(0)).deploy(...args); } catch { reverted = true; }
  assert.equal(reverted, true, `${label} deployment should revert`);
};
const factory = new ContractFactory(compiled.abi, `0x${compiled.evm.bytecode.object}`, owner);
const tokenFactory = new ContractFactory(compiledToken.abi, `0x${compiledToken.evm.bytecode.object}`, owner);
const paymentToken = await tokenFactory.deploy(); await paymentToken.waitForDeployment(); const paymentTokenAddress = await paymentToken.getAddress();
const args = [signingWallet.address, signingWallet.address, signingWallet.address, paymentTokenAddress, 100, parseEther('1'), 'ipfs://panic-archive/collection.json', 500];
await expectDeploymentFailure([ZeroAddress, ...args.slice(1)], 'zero owner');
await expectDeploymentFailure([signingWallet.address, ZeroAddress, ...args.slice(2)], 'zero signer');
await expectDeploymentFailure([signingWallet.address, signingWallet.address, ZeroAddress, ...args.slice(3)], 'zero payout receiver');
await expectDeploymentFailure([signingWallet.address, signingWallet.address, signingWallet.address, ZeroAddress, ...args.slice(4)], 'zero payment token');
await expectDeploymentFailure([signingWallet.address, signingWallet.address, signingWallet.address, recipientAddress, ...args.slice(4)], 'EOA payment token');
await expectDeploymentFailure([...args.slice(0, 4), 0, ...args.slice(5)], 'zero supply');
await expectDeploymentFailure([...args.slice(0, 6), '', ...args.slice(7)], 'empty collection metadata');
await expectDeploymentFailure([...args.slice(0, 7), 1_001], 'royalty above cap');
const archive = await factory.deploy(...args);
await archive.waitForDeployment();
const contractAddress = await archive.getAddress();
const network = await provider.getNetwork();
const domain = { name: 'Sketch Arena: The Panic Archive', version: '1', chainId: network.chainId, verifyingContract: contractAddress };
const types = { MintVoucher: [
  { name: 'recipient', type: 'address' }, { name: 'tokenURIHash', type: 'bytes32' }, { name: 'artworkHash', type: 'bytes32' },
  { name: 'price', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
  { name: 'seasonId', type: 'uint32' }, { name: 'campaignId', type: 'bytes32' },
] };
const deadline = BigInt((await provider.getBlock('latest')).timestamp + 3_600);
const makeVoucher = (nonce, uri, artwork, overrides = {}) => ({ recipient: recipientAddress, tokenURIHash: keccak256(toUtf8Bytes(uri)), artworkHash: id(artwork), price: 0n, nonce: BigInt(nonce), deadline, seasonId: 0, campaignId: id('season-0'), ...overrides });
const sign = (voucher, signer = signingWallet) => signer.signTypedData(domain, types, voucher);
const expectRevert = async (action, label) => {
  let reverted = false;
  try { await action(); } catch { reverted = true; }
  assert.equal(reverted, true, `${label} should revert`);
};

const unauthorizedOwnerActions = [
  ['signer rotation', () => archive.connect(recipient).setMintSigner(recipientAddress)],
  ['nonce revocation', () => archive.connect(recipient).revokeVoucherNonce(9_000)],
  ['recipient block', () => archive.connect(recipient).setRecipientBlocked(recipientAddress, true)],
  ['recipient approval', () => archive.connect(recipient).setRecipientApproved(recipientAddress, true)],
  ['allowlist policy', () => archive.connect(recipient).setAllowlistRequired(true)],
  ['price cap', () => archive.connect(recipient).setMaxMintPrice(0)],
  ['payout receiver', () => archive.connect(recipient).setPayoutReceiver(recipientAddress)],
  ['collection metadata', () => archive.connect(recipient).setCollectionMetadataURI('ipfs://unauthorized.json')],
  ['metadata freeze', () => archive.connect(recipient).freezeCollectionMetadata()],
  ['pause', () => archive.connect(recipient).pause()],
];
for (const [label, action] of unauthorizedOwnerActions) await expectRevert(action, `unauthorized ${label}`);
await expectRevert(async () => archive.connect(await freshOwner()).setMintSigner(ZeroAddress), 'zero mint signer update');
await expectRevert(async () => archive.connect(await freshOwner()).setPayoutReceiver(ZeroAddress), 'zero payout receiver update');
await expectRevert(async () => archive.connect(await freshOwner()).setRecipientBlocked(ZeroAddress, true), 'zero block recipient');
await expectRevert(async () => archive.connect(await freshOwner()).setRecipientApproved(ZeroAddress, true), 'zero approved recipient');
await expectRevert(async () => archive.connect(await freshOwner()).setCollectionMetadataURI(''), 'empty collection metadata update');
assert.equal(await archive.contractURI(), 'ipfs://panic-archive/collection.json');
assert.equal(await archive.paused(), true, 'a new production collection must begin paused');
await expectRevert(() => archive.connect(recipient).unpause(), 'unauthorized initial unpause');
await (await archive.connect(await freshOwner()).unpause()).wait();
owner.reset();
assert.equal(await archive.paused(), false);

const freeURI = 'ipfs://panic-archive/free-mint.json';
const freeVoucher = makeVoucher(1, freeURI, 'artwork-one');
await (await archive.connect(recipient).redeem(freeVoucher, freeURI, await sign(freeVoucher))).wait();
assert.equal(await archive.ownerOf(1), recipientAddress);
assert.equal(await archive.tokenURI(1), freeURI);
assert.equal(await archive.tokenIdByArtworkHash(freeVoucher.artworkHash), 1n);
const [artistRoyaltyReceiver, artistRoyaltyAmount] = await archive.royaltyInfo(1, 10_000);
assert.equal(artistRoyaltyReceiver, recipientAddress, 'the original minter must receive this token royalty');
assert.equal(artistRoyaltyAmount, 500n);
await expectRevert(() => archive.connect(recipient).redeem(freeVoucher, freeURI, sign(freeVoucher)), 'voucher replay');
const nativePaymentVoucher = makeVoucher(20, 'ipfs://panic-archive/native-payment.json', 'native-payment-artwork');
await expectRevert(() => archive.connect(recipient).redeem(nativePaymentVoucher, 'ipfs://panic-archive/native-payment.json', sign(nativePaymentVoucher), { value: 1n }), 'native SHIDO payment');

const duplicateArt = makeVoucher(2, 'ipfs://panic-archive/duplicate.json', 'artwork-one');
await expectRevert(() => archive.connect(recipient).redeem(duplicateArt, 'ipfs://panic-archive/duplicate.json', sign(duplicateArt)), 'duplicate artwork');

const paidURI = 'ipfs://panic-archive/paid-mint.json';
const paidVoucher = makeVoucher(3, paidURI, 'artwork-two', { price: parseEther('.1') });
const paidSignature = await sign(paidVoucher);
await (await paymentToken.mint(recipientAddress, parseEther('100'))).wait();
await expectRevert(() => archive.connect(recipient).redeem(paidVoucher, paidURI, paidSignature), 'missing WSHIDO allowance');
await (await paymentToken.connect(recipient).approve(contractAddress, MaxUint256)).wait();
// Bypass JSON-RPC estimate caching after the intentional pre-approval revert.
await (await archive.connect(recipient).redeem(paidVoucher, paidURI, paidSignature, { gasLimit: 500_000 })).wait();
assert.equal(await archive.ownerOf(2), recipientAddress);
assert.equal(await paymentToken.balanceOf(signingWallet.address), parseEther('.1'));

const revoked = makeVoucher(4, 'ipfs://panic-archive/revoked.json', 'artwork-three');
await (await archive.revokeVoucherNonce(4)).wait();
await expectRevert(() => archive.connect(recipient).redeem(revoked, 'ipfs://panic-archive/revoked.json', sign(revoked)), 'revoked nonce');

const blocked = makeVoucher(5, 'ipfs://panic-archive/blocked.json', 'artwork-four');
await (await archive.setRecipientBlocked(recipientAddress, true)).wait();
await expectRevert(() => archive.connect(recipient).redeem(blocked, 'ipfs://panic-archive/blocked.json', sign(blocked)), 'blocked recipient');
await (await archive.setRecipientBlocked(recipientAddress, false)).wait();

const allowlisted = makeVoucher(6, 'ipfs://panic-archive/allowlisted.json', 'artwork-five');
await (await archive.setAllowlistRequired(true)).wait();
await expectRevert(() => archive.connect(recipient).redeem(allowlisted, 'ipfs://panic-archive/allowlisted.json', sign(allowlisted)), 'unapproved recipient');
await (await archive.setRecipientApproved(recipientAddress, true)).wait();
// Bypass JSON-RPC estimate caching after the intentional pre-approval revert.
await (await archive.connect(recipient).redeem(allowlisted, 'ipfs://panic-archive/allowlisted.json', await sign(allowlisted), { gasLimit: 500_000 })).wait();
await (await archive.setAllowlistRequired(false)).wait();

const rotatedSigner = Wallet.createRandom();
const oldSignerVoucher = makeVoucher(7, 'ipfs://panic-archive/old-signer.json', 'artwork-six');
const oldSignature = await sign(oldSignerVoucher);
await (await archive.setMintSigner(rotatedSigner.address)).wait();
await expectRevert(() => archive.connect(recipient).redeem(oldSignerVoucher, 'ipfs://panic-archive/old-signer.json', oldSignature), 'rotated signer');
await (await archive.setMintSigner(signingWallet.address)).wait();

const paused = makeVoucher(8, 'ipfs://panic-archive/paused.json', 'artwork-seven');
await (await archive.pause()).wait();
await expectRevert(() => archive.connect(recipient).redeem(paused, 'ipfs://panic-archive/paused.json', sign(paused)), 'paused minting');
await (await archive.unpause()).wait();

const uriBound = makeVoucher(9, 'ipfs://panic-archive/uri-bound.json', 'artwork-eight');
await expectRevert(() => archive.connect(recipient).redeem(uriBound, 'ipfs://panic-archive/tampered.json', sign(uriBound)), 'tampered token URI');
const latestTimestamp = BigInt((await provider.getBlock('latest')).timestamp);
const expired = makeVoucher(10, 'ipfs://panic-archive/expired.json', 'artwork-nine', { deadline: latestTimestamp - 1n });
await expectRevert(() => archive.connect(recipient).redeem(expired, 'ipfs://panic-archive/expired.json', sign(expired)), 'expired voucher');
const overCap = makeVoucher(11, 'ipfs://panic-archive/over-cap.json', 'artwork-ten', { price: parseEther('2') });
await expectRevert(() => archive.connect(recipient).redeem(overCap, 'ipfs://panic-archive/over-cap.json', sign(overCap)), 'price above safety cap');
const wrongRecipient = makeVoucher(12, 'ipfs://panic-archive/wrong-recipient.json', 'artwork-eleven');
await expectRevert(async () => archive.connect(await freshOwner()).redeem(wrongRecipient, 'ipfs://panic-archive/wrong-recipient.json', sign(wrongRecipient)), 'wrong recipient');
const emptyArtwork = makeVoucher(13, 'ipfs://panic-archive/empty-art.json', 'ignored', { artworkHash: `0x${'00'.repeat(32)}` });
await expectRevert(() => archive.connect(recipient).redeem(emptyArtwork, 'ipfs://panic-archive/empty-art.json', sign(emptyArtwork)), 'empty artwork hash');
const wrongDomainSignature = await signingWallet.signTypedData({ ...domain, chainId: network.chainId + 1n }, types, makeVoucher(14, 'ipfs://panic-archive/domain.json', 'artwork-twelve'));
const wrongDomainVoucher = makeVoucher(14, 'ipfs://panic-archive/domain.json', 'artwork-twelve');
await expectRevert(() => archive.connect(recipient).redeem(wrongDomainVoucher, 'ipfs://panic-archive/domain.json', wrongDomainSignature), 'wrong EIP-712 domain');

const digestBase = makeVoucher(90, 'ipfs://panic-archive/digest.json', 'digest-artwork');
const baseDigest = await archive.voucherDigest(digestBase);
const digestMutations = [
  { recipient: signingWallet.address }, { tokenURIHash: id('another-uri') }, { artworkHash: id('another-artwork') }, { price: 1n },
  { nonce: 91n }, { deadline: digestBase.deadline + 1n }, { seasonId: 1 }, { campaignId: id('another-campaign') },
];
for (const mutation of digestMutations) assert.notEqual(await archive.voucherDigest({ ...digestBase, ...mutation }), baseDigest, `voucher field ${Object.keys(mutation)[0]} must alter the digest`);

const receiverFactory = new ContractFactory(compiledReceiver.abi, `0x${compiledReceiver.evm.bytecode.object}`, owner);
const receiver = await receiverFactory.deploy(contractAddress); await receiver.waitForDeployment();
const receiverAddress = await receiver.getAddress();
const reentrantURI = 'ipfs://panic-archive/reentrant.json';
const reentrantVoucher = makeVoucher(15, reentrantURI, 'artwork-thirteen', { recipient: receiverAddress });
await (await receiver.connect(recipient).attack(reentrantVoucher, reentrantURI, await sign(reentrantVoucher))).wait();
assert.equal(await receiver.reentrySucceeded(), false, 'receiver callback must not re-enter redeem');
assert.equal(await archive.ownerOf(4), receiverAddress);
assert.equal(await archive.usedNonces(15), true);

for (const interfaceId of ['0x01ffc9a7', '0x80ac58cd', '0x5b5e139f', '0x2a55205a']) assert.equal(await archive.supportsInterface(interfaceId), true, `${interfaceId} interface should be supported`);

// Reproducible property run. Every generated voucher must hash identically in
// ethers and Solidity, redeem exactly once, emit its complete signed context,
// and preserve the artwork-to-token provenance mapping.
let fuzzSeed = 0x5eedc0de;
const nextFuzz = () => {
  fuzzSeed ^= fuzzSeed << 13; fuzzSeed ^= fuzzSeed >>> 17; fuzzSeed ^= fuzzSeed << 5;
  return fuzzSeed >>> 0;
};
const fuzzCases = 24;
const fuzzStartToken = await archive.totalMinted();
let fuzzPaidTotal = 0n;
for (let index = 0; index < fuzzCases; index += 1) {
  const entropy = nextFuzz();
  const uri = `ipfs://panic-archive/property-${index}-${entropy.toString(16)}.json`;
  const price = index % 3 === 0 ? BigInt(entropy % 2_000) * 1_000_000_000_000n : 0n;
  const voucher = makeVoucher(10_000 + index, uri, `property-artwork-${index}-${entropy}`, {
    price,
    deadline: deadline + BigInt(entropy % 10_000),
    seasonId: entropy % 32,
    campaignId: id(`property-campaign-${entropy % 11}`),
  });
  const solidityDigest = await archive.voucherDigest(voucher);
  const localDigest = TypedDataEncoder.hash(domain, types, voucher);
  assert.equal(solidityDigest, localDigest, `property ${index}: Solidity and ethers EIP-712 digests must agree`);

  const receipt = await (await archive.connect(recipient).redeem(voucher, uri, await sign(voucher))).wait();
  const expectedTokenId = fuzzStartToken + BigInt(index + 1);
  const mintEvent = receipt.logs.map((log) => {
    try { return archive.interface.parseLog(log); } catch { return null; }
  }).find((event) => event?.name === 'PanicArchiveMinted');
  assert.ok(mintEvent, `property ${index}: mint event must exist`);
  assert.equal(mintEvent.args.recipient.toLowerCase(), recipientAddress.toLowerCase());
  assert.equal(mintEvent.args.tokenId, expectedTokenId);
  assert.equal(mintEvent.args.artworkHash, voucher.artworkHash);
  assert.equal(mintEvent.args.pricePaid, price);
  assert.equal(mintEvent.args.nonce, voucher.nonce);
  assert.equal(mintEvent.args.seasonId, BigInt(voucher.seasonId));
  assert.equal(mintEvent.args.campaignId, voucher.campaignId);
  assert.equal(await archive.ownerOf(expectedTokenId), recipientAddress);
  assert.equal(await archive.tokenURI(expectedTokenId), uri);
  assert.equal(await archive.tokenIdByArtworkHash(voucher.artworkHash), expectedTokenId);
  const [propertyRoyaltyReceiver, propertyRoyaltyAmount] = await archive.royaltyInfo(expectedTokenId, 10_000);
  assert.equal(propertyRoyaltyReceiver, recipientAddress);
  assert.equal(propertyRoyaltyAmount, 500n);
  assert.equal(await archive.usedNonces(voucher.nonce), true);
  await expectRevert(() => archive.connect(recipient).redeem(voucher, uri, sign(voucher)), `property ${index}: replay`);
  fuzzPaidTotal += price;
}
assert.equal(await archive.totalMinted(), fuzzStartToken + BigInt(fuzzCases));

const tinyArchive = await factory.deploy(signingWallet.address, signingWallet.address, signingWallet.address, paymentTokenAddress, 1, parseEther('1'), 'ipfs://panic-archive/tiny.json', 0);
await tinyArchive.waitForDeployment();
await (await tinyArchive.unpause()).wait();
const tinyAddress = await tinyArchive.getAddress();
const tinyDomain = { ...domain, verifyingContract: tinyAddress };
const crossContractURI = 'ipfs://panic-archive/cross-contract.json';
const crossContractVoucher = makeVoucher(1_000, crossContractURI, 'cross-contract-artwork');
await expectRevert(() => tinyArchive.connect(recipient).redeem(crossContractVoucher, crossContractURI, sign(crossContractVoucher)), 'cross-contract replay');
const tinyURI = 'ipfs://panic-archive/tiny-one.json';
const tinyOne = makeVoucher(1_001, tinyURI, 'tiny-artwork-one');
await (await tinyArchive.connect(recipient).redeem(tinyOne, tinyURI, await signingWallet.signTypedData(tinyDomain, types, tinyOne))).wait();
const tinyTwoURI = 'ipfs://panic-archive/tiny-two.json';
const tinyTwo = makeVoucher(1_002, tinyTwoURI, 'tiny-artwork-two');
await expectRevert(() => tinyArchive.connect(recipient).redeem(tinyTwo, tinyTwoURI, signingWallet.signTypedData(tinyDomain, types, tinyTwo)), 'maximum supply');

await (await archive.freezeCollectionMetadata()).wait();
await expectRevert(async () => archive.connect(await freshOwner()).setCollectionMetadataURI('ipfs://changed.json'), 'frozen collection metadata');
const expectedPayoutBalance = parseEther('.1') + fuzzPaidTotal;
assert.equal(await paymentToken.balanceOf(signingWallet.address), expectedPayoutBalance, 'WSHIDO must settle directly to the payout receiver');
assert.equal(await paymentToken.balanceOf(contractAddress), 0n, 'archive must not retain player WSHIDO');
assert.equal(BigInt(await provider.send('eth_getBalance', [contractAddress, 'latest'])), 0n, 'archive must not accept native SHIDO');
assert.equal(await archive.totalMinted(), 4n + BigInt(fuzzCases));
console.log(`Panic Archive local-chain tests passed at ${contractAddress}`);
