import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createPublicClient, encodeDeployData, getAddress, http, maxUint256, parseAbi } from 'viem';

const rpcUrl = process.env.SHIDO_RPC_URL?.trim() || 'https://evm.shidoscan.net';
const artifact = JSON.parse(readFileSync(resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.artifact.json'), 'utf8'));
const expected = {
  chainId: 9008,
  owner: getAddress('0xA9E8a36E648E2C5DDc53D9942b88a158B7789E4e'),
  mintSigner: getAddress('0x44A5920654B1D6DFDC92E201514F1389e6dAc3e7'),
  payoutReceiver: getAddress('0xAe0CEb4Bc23Dfdd552eaE2865481B191C3b28da1'),
  paymentToken: getAddress('0x8cbaffd9b658997e7bf87e98febf6ea6917166f7'),
};
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 12_000 }) });
const data = encodeDeployData({ abi: artifact.abi, bytecode: artifact.bytecode, args: [expected.owner, expected.mintSigner, expected.payoutReceiver, expected.paymentToken, maxUint256, maxUint256, 'https://sketch.bodhix.io/api/archive/metadata', 500] });
const tokenAbi = parseAbi(['function name() view returns (string)', 'function symbol() view returns (string)', 'function decimals() view returns (uint8)']);

const [chainId, paymentBytecode, ownerBalance, ownerNonce, gasPrice, tokenName, tokenSymbol, tokenDecimals] = await Promise.all([
  client.getChainId(), client.getBytecode({ address: expected.paymentToken }), client.getBalance({ address: expected.owner }),
  client.getTransactionCount({ address: expected.owner }),
  client.getGasPrice(),
  client.readContract({ address: expected.paymentToken, abi: tokenAbi, functionName: 'name' }),
  client.readContract({ address: expected.paymentToken, abi: tokenAbi, functionName: 'symbol' }),
  client.readContract({ address: expected.paymentToken, abi: tokenAbi, functionName: 'decimals' }),
]);
let estimatedGas;
let estimateError;
try { estimatedGas = await client.request({ method: 'eth_estimateGas', params: [{ from: expected.owner, data, value: '0x0' }] }); }
catch (error) { estimateError = error instanceof Error ? [error.shortMessage, error.details, error.message].filter(Boolean).join(' · ') : String(error); }

const checks = {
  evmVersion: artifact.evmVersion === 'paris',
  chainId: chainId === expected.chainId,
  paymentTokenHasCode: Boolean(paymentBytecode && paymentBytecode !== '0x'),
  paymentTokenIdentity: tokenSymbol === 'WSHIDO' && tokenDecimals === 18,
  ownerHasGas: ownerBalance > 0n,
  deploymentEstimates: typeof estimatedGas === 'bigint' || (typeof estimatedGas === 'string' && /^0x[0-9a-f]+$/i.test(estimatedGas)),
  ownerHasDeploymentGas: estimatedGas !== undefined && ownerBalance > BigInt(estimatedGas) * gasPrice,
};
console.log(JSON.stringify({
  ready: Object.values(checks).every(Boolean), checks, chainId, owner: expected.owner, ownerNonce, ownerBalanceWei: ownerBalance.toString(),
  paymentToken: { address: expected.paymentToken, name: tokenName, symbol: tokenSymbol, decimals: Number(tokenDecimals), codeSha256: paymentBytecode ? createHash('sha256').update(paymentBytecode).digest('hex') : null },
  deployment: { estimatedGas: estimatedGas === undefined ? undefined : BigInt(estimatedGas).toString(), estimatedGasCostWei: estimatedGas === undefined ? undefined : (BigInt(estimatedGas) * gasPrice).toString(), gasPriceWei: gasPrice.toString(), error: estimateError, sourceSha256: artifact.sourceSha256, creationBytes: (artifact.bytecode.length - 2) / 2, deployedBytes: (artifact.deployedBytecode.length - 2) / 2 },
}, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 1;
