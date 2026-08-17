import { randomBytes, randomUUID } from 'node:crypto';
import type { ArtworkDocument, MintPreparation, PanicArchiveVoucher, PlayerProgress } from '@sketch-arena/protocol';
import {
  createPublicClient, decodeEventLog, encodeFunctionData, getAddress, http, isAddress, keccak256, parseAbi,
  toBytes, toHex, verifyMessage, type Address, type Hex, type PublicClient, type Transaction, type TransactionReceipt,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { ArtworkRepository } from '../artwork/ArtworkRepository.js';
import { renderArtworkSvg } from '../artwork/renderArtworkSvg.js';
import type { ProgressionRepository } from '../progression/ProgressionRepository.js';
import type { MintRecord, MintRepository } from './MintRepository.js';

const PANIC_ARCHIVE_ABI = parseAbi([
  'function redeem((address recipient,bytes32 tokenURIHash,bytes32 artworkHash,uint256 price,uint256 nonce,uint256 deadline,uint32 seasonId,bytes32 campaignId) voucher,string tokenURI_,bytes signature) payable returns (uint256 tokenId)',
  'function setRecipientBlocked(address recipient,bool blocked)',
  'function setRecipientApproved(address recipient,bool approved)',
  'function setAllowlistRequired(bool required)',
  'event PanicArchiveMinted(address indexed recipient,uint256 indexed tokenId,bytes32 indexed artworkHash,uint256 pricePaid,uint256 nonce,uint32 seasonId,bytes32 campaignId)',
]);

export interface ChainReader {
  getTransactionReceipt(args: { hash: Hex }): Promise<TransactionReceipt>;
  getTransaction(args: { hash: Hex }): Promise<Transaction>;
  getBlockNumber(): Promise<bigint>;
}

export interface MintConfiguration {
  enabled: boolean;
  missing: string[];
  contractAddress?: Address;
  chainId?: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  rpcUrl?: string;
  walletRpcUrls: string[];
  explorerUrl?: string;
  marketplaceTokenUrlTemplate?: string;
  ipfsApiUrl?: string;
  ipfsApiToken?: string;
  ipfsPublicGateway?: string;
  signerPrivateKey?: Hex;
  standardPriceWei?: bigint;
  voucherLifetimeMs: number;
  requiredConfirmations: number;
  publicOrigin: string;
}

export interface MintPublicStatus {
  enabled: boolean;
  contractControlsEnabled: boolean;
  missing: string[];
  collection: string;
  season: string;
  chainId?: number;
  chainName: string;
  nativeCurrency: MintConfiguration['nativeCurrency'];
  blockExplorerUrl?: string;
  standardPriceWei?: string;
  firstMintFree: true;
}
export type ContractAccessAction = { action: 'set-blocked'; address: string; enabled: boolean } | { action: 'set-approved'; address: string; enabled: boolean } | { action: 'set-allowlist'; enabled: boolean };
export interface ContractAdminTransaction { chainId: number; chainName: string; nativeCurrency: MintConfiguration['nativeCurrency']; rpcUrls: string[]; blockExplorerUrl?: string; request: { to: Address; value: '0x0'; data: Hex }; summary: string; }

export class MintServiceError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

function positiveInteger(value: string | undefined): number | undefined {
  const parsed = Number(value); return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function loadMintConfiguration(environment: NodeJS.ProcessEnv = process.env): MintConfiguration {
  const contractAddress = environment.PANIC_ARCHIVE_ADDRESS && isAddress(environment.PANIC_ARCHIVE_ADDRESS) ? getAddress(environment.PANIC_ARCHIVE_ADDRESS) : undefined;
  const chainId = positiveInteger(environment.PANIC_ARCHIVE_CHAIN_ID);
  const rpcUrl = environment.SHIDO_RPC_URL?.trim();
  const ipfsApiUrl = environment.IPFS_API_URL?.trim()?.replace(/\/+$/, '');
  const ipfsPublicGateway = environment.IPFS_PUBLIC_GATEWAY?.trim()?.replace(/\/+$/, '');
  const signerPrivateKey = /^0x[0-9a-f]{64}$/i.test(environment.PANIC_ARCHIVE_SIGNER_PRIVATE_KEY ?? '') ? environment.PANIC_ARCHIVE_SIGNER_PRIVATE_KEY as Hex : undefined;
  let standardPriceWei: bigint | undefined;
  try { if (/^\d+$/.test(environment.PANIC_ARCHIVE_MINT_PRICE_WEI ?? '')) standardPriceWei = BigInt(environment.PANIC_ARCHIVE_MINT_PRICE_WEI!); } catch { standardPriceWei = undefined; }
  const missing = [
    !contractAddress && 'PANIC_ARCHIVE_ADDRESS', !chainId && 'PANIC_ARCHIVE_CHAIN_ID', !rpcUrl && 'SHIDO_RPC_URL', !ipfsApiUrl && 'IPFS_API_URL',
    !ipfsPublicGateway && 'IPFS_PUBLIC_GATEWAY', !signerPrivateKey && 'PANIC_ARCHIVE_SIGNER_PRIVATE_KEY', standardPriceWei === undefined && 'PANIC_ARCHIVE_MINT_PRICE_WEI',
  ].filter((value): value is string => Boolean(value));
  const configuredWalletRpcs = (environment.SHIDO_WALLET_RPC_URLS ?? rpcUrl ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  const marketplaceTemplate = environment.PANIC_ARCHIVE_MARKETPLACE_TOKEN_URL_TEMPLATE?.trim();
  const marketplaceTokenUrlTemplate = marketplaceTemplate?.startsWith('https://') && marketplaceTemplate.includes('{contract}') && marketplaceTemplate.includes('{tokenId}') ? marketplaceTemplate : undefined;
  return {
    enabled: missing.length === 0, missing, contractAddress, chainId, rpcUrl, ipfsApiUrl, ipfsPublicGateway, signerPrivateKey, standardPriceWei,
    chainName: environment.SHIDO_CHAIN_NAME?.trim() || 'Shido', nativeCurrency: { name: 'SHIDO', symbol: 'SHIDO', decimals: 18 },
    walletRpcUrls: configuredWalletRpcs, explorerUrl: environment.SHIDO_EXPLORER_URL?.trim()?.replace(/\/+$/, '') || 'https://shidoscan.net',
    marketplaceTokenUrlTemplate, ipfsApiToken: environment.IPFS_API_TOKEN?.trim(),
    voucherLifetimeMs: Math.min(3_600_000, Math.max(120_000, (positiveInteger(environment.PANIC_ARCHIVE_VOUCHER_SECONDS) ?? 900) * 1_000)),
    requiredConfirmations: Math.min(12, positiveInteger(environment.PANIC_ARCHIVE_CONFIRMATIONS) ?? 1), publicOrigin: environment.PUBLIC_APP_ORIGIN?.trim()?.replace(/\/+$/, '') || 'https://sketcharena.bodhix.io',
  };
}

function assertConfigured(config: MintConfiguration): asserts config is MintConfiguration & Required<Pick<MintConfiguration, 'contractAddress' | 'chainId' | 'rpcUrl' | 'ipfsApiUrl' | 'ipfsPublicGateway' | 'signerPrivateKey' | 'standardPriceWei'>> {
  if (!config.enabled) throw new MintServiceError('Panic Archive minting is not configured yet', 503);
}
function assertContractControls(config: MintConfiguration): asserts config is MintConfiguration & Required<Pick<MintConfiguration, 'contractAddress' | 'chainId'>> {
  if (!config.contractAddress || !config.chainId || !config.walletRpcUrls.length) throw new MintServiceError('Panic Archive contract controls are not configured yet', 503);
}

function publicMint(record: MintRecord): MintPreparation {
  const mint: Partial<MintRecord> = structuredClone(record);
  delete mint.ownerSessionId; delete mint.creditRewardId; delete mint.creditUnit; delete mint.discountRewardId; delete mint.discountUnit; delete mint.createdAt; delete mint.updatedAt;
  return mint as MintPreparation;
}

function availableDiscount(player: PlayerProgress, reservations: Array<{ rewardId: string; unit: number }>, now: number): { rewardId: string; unit: number; discountBps: number } | null {
  const rewards = player.rewards.filter((reward) => reward.kind === 'mint-discount' && reward.discountBps && reward.discountBps > 0 && reward.discountBps <= 10_000 && (!reward.expiresAt || reward.expiresAt > now)).sort((a, b) => (b.discountBps ?? 0) - (a.discountBps ?? 0));
  for (const reward of rewards) {
    const redeemed = reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0);
    for (let unit = redeemed; unit < reward.amount; unit += 1) if (!reservations.some((reservation) => reservation.rewardId === reward.id && reservation.unit === unit)) return { rewardId: reward.id, unit, discountBps: reward.discountBps! };
  }
  return null;
}

function availableCredit(player: PlayerProgress, reservations: Array<{ rewardId: string; unit: number }>, now: number): { rewardId: string; unit: number } | null {
  for (const reward of player.rewards) {
    if (reward.kind !== 'mint-credit' || (reward.expiresAt && reward.expiresAt <= now)) continue;
    const redeemed = reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0);
    for (let unit = redeemed; unit < reward.amount; unit += 1) if (!reservations.some((reservation) => reservation.rewardId === reward.id && reservation.unit === unit)) return { rewardId: reward.id, unit };
  }
  return null;
}

function safeFileName(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'panic-artwork'; }

export class MintService {
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly chain: ChainReader | null;
  constructor(
    private readonly artwork: ArtworkRepository, private readonly progression: ProgressionRepository, private readonly repository: MintRepository,
    readonly config: MintConfiguration = loadMintConfiguration(), private readonly clock: () => number = Date.now,
    private readonly fetcher: typeof fetch = fetch, chain?: ChainReader,
  ) {
    this.chain = chain ?? (config.enabled && config.rpcUrl ? createPublicClient({ transport: http(config.rpcUrl) }) as PublicClient as ChainReader : null);
  }

  status(): MintPublicStatus {
    return { enabled: this.config.enabled, contractControlsEnabled: Boolean(this.config.contractAddress && this.config.chainId && this.config.walletRpcUrls.length), missing: this.config.missing, collection: 'Sketch Arena: The Panic Archive', season: 'Season 0 · The First Mess', chainId: this.config.chainId,
      chainName: this.config.chainName, nativeCurrency: this.config.nativeCurrency, blockExplorerUrl: this.config.explorerUrl, standardPriceWei: this.config.standardPriceWei?.toString(), firstMintFree: true };
  }

  async createChallenge(sessionId: string, rawAddress: string): Promise<{ challengeId: string; address: Address; message: string; expiresAt: number }> {
    if (!isAddress(rawAddress)) throw new MintServiceError('Wallet address is invalid', 400);
    const address = getAddress(rawAddress); const now = this.clock(); const expiresAt = now + 5 * 60_000; const nonce = randomBytes(16).toString('hex');
    const message = `Sketch Arena wallet verification\n\nSign this message to connect ${address} to your private Sketch Arena Vault. This does not mint anything and costs no gas.\n\nApp: ${this.config.publicOrigin}\nSession: ${sessionId}\nNonce: ${nonce}\nIssued: ${new Date(now).toISOString()}\nExpires: ${new Date(expiresAt).toISOString()}`;
    const challenge = await this.repository.createChallenge({ sessionId, address, message, expiresAt }, now);
    return { challengeId: challenge.id, address, message, expiresAt };
  }

  async verifyWallet(sessionId: string, challengeId: string, rawAddress: string, rawSignature: string): Promise<{ address: Address; verifiedAt: number }> {
    if (!isAddress(rawAddress) || !/^0x[0-9a-f]+$/i.test(rawSignature)) throw new MintServiceError('Wallet proof is invalid', 400);
    const address = getAddress(rawAddress); const challenge = await this.repository.claimChallenge(challengeId, sessionId, address, this.clock());
    const valid = await verifyMessage({ address, message: challenge.message, signature: rawSignature as Hex });
    if (!valid) throw new MintServiceError('That signature does not belong to this wallet', 401);
    return this.repository.bindWallet(sessionId, address, this.clock());
  }

  async binding(sessionId: string): Promise<{ address: Address; verifiedAt: number } | null> { return this.repository.getBinding(sessionId); }
  async getForArtwork(sessionId: string, artworkId: string): Promise<MintPreparation | null> { const record = await this.repository.getMintByArtwork(artworkId, sessionId); return record ? publicMint(record) : null; }

  prepareContractAccessTransaction(input: ContractAccessAction): ContractAdminTransaction {
    assertContractControls(this.config); let data: Hex; let summary: string;
    if (input.action === 'set-allowlist') { data = encodeFunctionData({ abi: PANIC_ARCHIVE_ABI, functionName: 'setAllowlistRequired', args: [input.enabled] }); summary = input.enabled ? 'Require approved wallets for every new mint' : 'Open mint redemption to wallets holding a valid signed voucher'; }
    else {
      if (!isAddress(input.address)) throw new MintServiceError('Wallet address is invalid', 400); const address = getAddress(input.address);
      if (input.action === 'set-blocked') { data = encodeFunctionData({ abi: PANIC_ARCHIVE_ABI, functionName: 'setRecipientBlocked', args: [address, input.enabled] }); summary = `${input.enabled ? 'Block' : 'Unblock'} ${address}`; }
      else { data = encodeFunctionData({ abi: PANIC_ARCHIVE_ABI, functionName: 'setRecipientApproved', args: [address, input.enabled] }); summary = `${input.enabled ? 'Approve' : 'Remove approval for'} ${address}`; }
    }
    return { chainId: this.config.chainId, chainName: this.config.chainName, nativeCurrency: this.config.nativeCurrency, rpcUrls: this.config.walletRpcUrls, blockExplorerUrl: this.config.explorerUrl, request: { to: this.config.contractAddress, value: '0x0', data }, summary };
  }

  prepare(sessionId: string, artworkId: string): Promise<MintPreparation> {
    const operation = async () => this.prepareSerial(sessionId, artworkId); const result = this.operationQueue.then(operation, operation); this.operationQueue = result.then(() => undefined, () => undefined); return result;
  }

  private async prepareSerial(sessionId: string, artworkId: string): Promise<MintPreparation> {
    assertConfigured(this.config); const now = this.clock(); const binding = await this.repository.getBinding(sessionId);
    if (!binding) throw new MintServiceError('Connect and verify your wallet first', 409);
    const art = await this.artwork.get(artworkId);
    if (!art || art.ownerSessionId !== sessionId) throw new MintServiceError('Artwork not found in your Vault', 404);
    if (art.status === 'draft') throw new MintServiceError('Finish and save this artwork before minting', 409);
    const existing = await this.repository.getMintByArtwork(artworkId, sessionId);
    if (existing?.status === 'confirmed' || existing?.status === 'submitted' || (existing?.status === 'prepared' && existing.expiresAt > now && existing.walletAddress.toLowerCase() === binding.address.toLowerCase())) return publicMint(existing);
    if (existing?.status === 'prepared') await this.repository.saveMint({ ...existing, status: 'expired', updatedAt: now });

    const player = await this.progression.getPlayer(sessionId); if (!player) throw new MintServiceError('Player profile not found', 404);
    const credit = availableCredit(player, await this.repository.listCreditReservations(now), now);
    const discount = credit ? null : availableDiscount(player, await this.repository.listDiscountReservations(now), now);
    const svg = renderArtworkSvg(art); const artworkHash = keccak256(toBytes(svg));
    const mediaCid = await this.pin(svg, `${safeFileName(art.title)}.svg`, 'image/svg+xml'); const mediaURI = `ipfs://${mediaCid}`;
    const metadata = this.metadata(art, player, mediaURI, artworkHash); const metadataCid = await this.pin(JSON.stringify(metadata, null, 2), `${safeFileName(art.title)}-metadata.json`, 'application/json');
    const tokenURI = `ipfs://${metadataCid}`; const tokenURIHash = keccak256(toBytes(tokenURI)); const price = credit ? 0n : discount ? this.config.standardPriceWei * BigInt(10_000 - discount.discountBps) / 10_000n : this.config.standardPriceWei;
    const nonce = BigInt(`0x${randomBytes(32).toString('hex')}`); const deadline = BigInt(Math.floor((now + this.config.voucherLifetimeMs) / 1_000));
    const campaignId = keccak256(toBytes(credit ? `mint-credit:${credit.rewardId}:${credit.unit}` : discount ? `mint-discount:${discount.rewardId}:${discount.unit}:${discount.discountBps}` : 'standard-mint-price'));
    const voucher: PanicArchiveVoucher = { recipient: binding.address, tokenURIHash, artworkHash, price: price.toString(), nonce: nonce.toString(), deadline: deadline.toString(), seasonId: 0, campaignId };
    const account = privateKeyToAccount(this.config.signerPrivateKey);
    const signature = await account.signTypedData({ domain: { name: 'Sketch Arena: The Panic Archive', version: '1', chainId: this.config.chainId, verifyingContract: this.config.contractAddress },
      types: { MintVoucher: [
        { name: 'recipient', type: 'address' }, { name: 'tokenURIHash', type: 'bytes32' }, { name: 'artworkHash', type: 'bytes32' }, { name: 'price', type: 'uint256' },
        { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' }, { name: 'seasonId', type: 'uint32' }, { name: 'campaignId', type: 'bytes32' },
      ] }, primaryType: 'MintVoucher', message: { ...voucher, price, nonce, deadline } });
    const data = encodeFunctionData({ abi: PANIC_ARCHIVE_ABI, functionName: 'redeem', args: [{ ...voucher, price, nonce, deadline }, tokenURI, signature] });
    const record: MintRecord = { id: existing?.id ?? randomUUID(), artworkId, ownerSessionId: sessionId, status: 'prepared', walletAddress: binding.address, contractAddress: this.config.contractAddress,
      chainId: this.config.chainId, chainName: this.config.chainName, nativeCurrency: this.config.nativeCurrency, rpcUrls: this.config.walletRpcUrls, blockExplorerUrl: this.config.explorerUrl,
      mediaURI, tokenURI, voucher, signature, transactionRequest: { to: this.config.contractAddress, from: binding.address, value: toHex(price), data },
      usesMintCredit: Boolean(credit), discountBps: discount?.discountBps, creditRewardId: credit?.rewardId, creditUnit: credit?.unit, discountRewardId: discount?.rewardId, discountUnit: discount?.unit,
      expiresAt: Number(deadline) * 1_000, createdAt: existing?.createdAt ?? now, updatedAt: now };
    await this.repository.saveMint(record); await this.artwork.updateMint(art.id, sessionId, { network: 'shido', status: 'prepared', walletAddress: binding.address, contractAddress: this.config.contractAddress, tokenURI }, 'mint-ready');
    return publicMint(record);
  }

  async confirm(sessionId: string, mintId: string, transactionHash: string): Promise<{ mint: MintPreparation; pending: boolean }> {
    assertConfigured(this.config); if (!/^0x[0-9a-f]{64}$/i.test(transactionHash)) throw new MintServiceError('Transaction hash is invalid', 400);
    const record = await this.repository.getMint(mintId, sessionId); if (!record) throw new MintServiceError('Mint preparation not found', 404);
    if (record.status === 'confirmed') return { mint: publicMint(record), pending: false };
    if (record.transactionHash && record.transactionHash.toLowerCase() !== transactionHash.toLowerCase()) throw new MintServiceError('This mint already has a different transaction', 409);
    const submitted: MintRecord = { ...record, status: 'submitted', transactionHash: transactionHash as Hex, updatedAt: this.clock() }; await this.repository.saveMint(submitted);
    if (!this.chain) throw new MintServiceError('Shido verification is unavailable', 503);
    let receipt: TransactionReceipt; let transaction: Transaction;
    try { [receipt, transaction] = await Promise.all([this.chain.getTransactionReceipt({ hash: transactionHash as Hex }), this.chain.getTransaction({ hash: transactionHash as Hex })]); }
    catch { return { mint: publicMint(submitted), pending: true }; }
    if (receipt.status !== 'success') return { mint: publicMint(await this.fail(submitted, 'The mint transaction reverted on-chain')), pending: false };
    if (transaction.to?.toLowerCase() !== this.config.contractAddress.toLowerCase() || transaction.from.toLowerCase() !== submitted.walletAddress.toLowerCase()) throw new MintServiceError('Transaction does not match this mint request', 409);
    const latestBlock = await this.chain.getBlockNumber();
    if (latestBlock - receipt.blockNumber + 1n < BigInt(this.config.requiredConfirmations)) return { mint: publicMint(submitted), pending: true };
    const mintEvent = receipt.logs.filter((log) => log.address.toLowerCase() === this.config.contractAddress!.toLowerCase()).flatMap((log) => {
      try { const decoded = decodeEventLog({ abi: PANIC_ARCHIVE_ABI, eventName: 'PanicArchiveMinted', data: log.data, topics: log.topics }); return [decoded.args]; } catch { return []; }
    }).find((event) => event.recipient.toLowerCase() === submitted.walletAddress.toLowerCase() && event.artworkHash.toLowerCase() === submitted.voucher.artworkHash.toLowerCase() && event.nonce.toString() === submitted.voucher.nonce);
    if (!mintEvent || mintEvent.pricePaid.toString() !== submitted.voucher.price || mintEvent.seasonId !== submitted.voucher.seasonId || mintEvent.campaignId.toLowerCase() !== submitted.voucher.campaignId.toLowerCase()) throw new MintServiceError('Confirmed transaction did not emit the expected Panic Archive mint', 409);
    if (submitted.creditRewardId) await this.progression.consumeMintCredit(sessionId, submitted.creditRewardId, `mint:${submitted.id}`, 1);
    if (submitted.discountRewardId) await this.progression.consumeMintDiscount(sessionId, submitted.discountRewardId, `mint:${submitted.id}`, 1);
    const tokenId = mintEvent.tokenId.toString(); const marketplaceUrl = this.config.marketplaceTokenUrlTemplate?.replace('{contract}', this.config.contractAddress).replace('{tokenId}', tokenId);
    const confirmed: MintRecord = { ...submitted, status: 'confirmed', tokenId, marketplaceUrl, updatedAt: this.clock() }; await this.repository.saveMint(confirmed);
    await this.artwork.updateMint(submitted.artworkId, sessionId, { network: 'shido', status: 'confirmed', walletAddress: submitted.walletAddress, contractAddress: submitted.contractAddress, tokenURI: submitted.tokenURI, tokenId, transactionHash: transactionHash as Hex, marketplaceUrl }, 'minted');
    return { mint: publicMint(confirmed), pending: false };
  }

  private async fail(record: MintRecord, error: string): Promise<MintRecord> { const failed = { ...record, status: 'failed' as const, error, updatedAt: this.clock() }; return this.repository.saveMint(failed); }

  private async pin(content: string, filename: string, contentType: string): Promise<string> {
    assertConfigured(this.config); const form = new FormData(); form.append('file', new Blob([content], { type: contentType }), filename);
    const response = await this.fetcher(`${this.config.ipfsApiUrl}/api/v0/add?pin=true&cid-version=1`, { method: 'POST', headers: this.config.ipfsApiToken ? { authorization: `Bearer ${this.config.ipfsApiToken}` } : undefined, body: form, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new MintServiceError('Permanent artwork storage is temporarily unavailable', 503);
    const line = (await response.text()).trim().split('\n').filter(Boolean).at(-1); let payload: { Hash?: string };
    try { payload = JSON.parse(line ?? '{}') as { Hash?: string }; } catch { throw new MintServiceError('Permanent artwork storage returned an invalid response', 502); }
    if (!payload.Hash) throw new MintServiceError('Permanent artwork storage did not return a content ID', 502); return payload.Hash;
  }

  private metadata(art: ArtworkDocument, player: PlayerProgress, mediaURI: string, artworkHash: Hex): object {
    return { name: art.title, description: art.description || `A gloriously permanent Sketch Arena creation by ${player.name}, archived during The First Mess.`, image: mediaURI,
      external_url: `${this.config.publicOrigin}/archive`, attributes: [
        { trait_type: 'Collection', value: 'The Panic Archive' }, { trait_type: 'Season', value: 'The First Mess' }, { trait_type: 'Creator', value: player.name },
        { trait_type: 'Origin', value: art.origin === 'arena' ? 'Arena Round' : 'Solo Studio' }, { trait_type: 'Canvas', value: art.canvasRatio },
        { trait_type: 'Width', value: art.width, display_type: 'number' }, { trait_type: 'Height', value: art.height, display_type: 'number' }, { trait_type: 'Marks', value: art.strokes.length, display_type: 'number' },
      ], properties: { schema: 'sketch-arena-panic-archive-v1', seasonId: 0, artworkHash } };
  }
}
