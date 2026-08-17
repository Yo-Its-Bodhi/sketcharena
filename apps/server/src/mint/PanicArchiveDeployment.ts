import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { encodeDeployData, getAddress, maxUint256, type Abi, type Address, type Hex } from 'viem';
import type { MintConfiguration } from './MintService.js';
import { MintServiceError } from './MintService.js';

export const PANIC_ARCHIVE_DEPLOYMENT = {
  owner: getAddress('0xA9E8a36E648E2C5DDc53D9942b88a158B7789E4e'),
  mintSigner: getAddress('0x44A5920654B1D6DFDC92E201514F1389e6dAc3e7'),
  payoutReceiver: getAddress('0xAe0CEb4Bc23Dfdd552eaE2865481B191C3b28da1'),
  paymentToken: getAddress('0x8cbaffd9b658997e7bf87e98febf6ea6917166f7'),
  maxSupply: maxUint256,
  maxMintPrice: maxUint256,
  collectionMetadataURI: 'https://sketch.bodhix.io/api/archive/metadata',
  artistRoyaltyBps: 500,
} as const;

type Artifact = { contractName: string; compiler: string; evmVersion: string; sourceSha256: string; abi: Abi; bytecode: Hex; deployedBytecode: Hex };
export type PanicArchiveDeploymentTransaction = {
  chainId: number; chainName: string; nativeCurrency: MintConfiguration['nativeCurrency']; rpcUrls: string[]; blockExplorerUrl?: string;
  owner: Address; request: { value: '0x0'; data: Hex }; artifact: { contractName: string; compiler: string; evmVersion: string; sourceSha256: string; deployedBytes: number };
  parameters: { mintSigner: Address; payoutReceiver: Address; paymentToken: Address; maxSupply: string; maxMintPrice: string; collectionMetadataURI: string; artistRoyaltyPercent: number; startsPaused: true };
};

export function preparePanicArchiveDeployment(config: MintConfiguration, artifactPath = resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.artifact.json')): PanicArchiveDeploymentTransaction {
  if (config.contractAddress) throw new MintServiceError('The collection address is already configured. Refusing to prepare a second deployment.', 409);
  if (!config.chainId || !config.walletRpcUrls.length) throw new MintServiceError('The Shido wallet network is not configured.', 503);
  let artifact: Artifact;
  try { artifact = JSON.parse(readFileSync(artifactPath, 'utf8')) as Artifact; }
  catch { throw new MintServiceError('The reviewed Panic Archive deployment artifact is unavailable.', 503); }
  if (artifact.contractName !== 'SketchArenaPanicArchive' || artifact.evmVersion !== 'paris' || !artifact.bytecode?.startsWith('0x') || artifact.bytecode.length < 10) throw new MintServiceError('The reviewed Panic Archive deployment artifact is invalid or targets an unsupported EVM version.', 503);
  const args = Object.values(PANIC_ARCHIVE_DEPLOYMENT);
  const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  return {
    chainId: config.chainId, chainName: config.chainName, nativeCurrency: config.nativeCurrency, rpcUrls: config.walletRpcUrls, blockExplorerUrl: config.explorerUrl,
    owner: PANIC_ARCHIVE_DEPLOYMENT.owner, request: { value: '0x0', data },
    artifact: { contractName: artifact.contractName, compiler: artifact.compiler, evmVersion: artifact.evmVersion, sourceSha256: artifact.sourceSha256, deployedBytes: (artifact.deployedBytecode.length - 2) / 2 },
    parameters: { mintSigner: PANIC_ARCHIVE_DEPLOYMENT.mintSigner, payoutReceiver: PANIC_ARCHIVE_DEPLOYMENT.payoutReceiver, paymentToken: PANIC_ARCHIVE_DEPLOYMENT.paymentToken,
      maxSupply: PANIC_ARCHIVE_DEPLOYMENT.maxSupply.toString(), maxMintPrice: PANIC_ARCHIVE_DEPLOYMENT.maxMintPrice.toString(), collectionMetadataURI: PANIC_ARCHIVE_DEPLOYMENT.collectionMetadataURI,
      artistRoyaltyPercent: PANIC_ARCHIVE_DEPLOYMENT.artistRoyaltyBps / 100, startsPaused: true },
  };
}
