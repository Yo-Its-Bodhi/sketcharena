const [rpcUrl, archiveAddress, paymentTokenAddress, viemSpecifier = 'viem'] = process.argv.slice(2);
if (!rpcUrl || !archiveAddress || !paymentTokenAddress) {
  console.error('Usage: node scripts/diagnose-mint-rpc.mjs <rpc-url> <archive-address> <payment-token-address> [viem-specifier]');
  process.exit(2);
}

const { createPublicClient, encodeFunctionData, http, parseAbi } = await import(viemSpecifier);
const client = createPublicClient({ transport: http(rpcUrl, { timeout: 12_000 }) });
const archiveAbi = parseAbi([
  'function mintSigner() view returns (address)',
  'function maxMintPrice() view returns (uint256)',
  'function paused() view returns (bool)',
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function paymentToken() view returns (address)',
]);
const tokenAbi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
]);
if (process.argv.includes('--batch')) {
  const calls = [
    { method: 'eth_chainId', params: [] },
    { method: 'eth_getCode', params: [archiveAddress, 'latest'] },
    ...['mintSigner', 'maxMintPrice', 'paused', 'name', 'symbol', 'paymentToken'].map((functionName) => ({ method: 'eth_call', params: [{ to: archiveAddress, data: encodeFunctionData({ abi: archiveAbi, functionName }) }, 'latest'] })),
    ...['name', 'symbol', 'decimals'].map((functionName) => ({ method: 'eth_call', params: [{ to: paymentTokenAddress, data: encodeFunctionData({ abi: tokenAbi, functionName }) }, 'latest'] })),
  ];
  const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(calls.map((call, index) => ({ jsonrpc: '2.0', id: index + 1, ...call }))), signal: AbortSignal.timeout(12_000) });
  const body = await response.json();
  console.log(`batch.http=${response.status} responses=${Array.isArray(body) ? body.length : 0}`);
  if (Array.isArray(body)) body.forEach((entry, index) => { if (entry.error) console.error(`batch.${calls[index]?.method ?? index}=FAIL ${entry.error.message ?? JSON.stringify(entry.error)}`); });
  if (!response.ok || !Array.isArray(body) || body.length !== calls.length || body.some((entry) => entry.error)) process.exitCode = 1;
  process.exit();
}
const probes = [
  ['chainId', () => client.getChainId()],
  ['archive.bytecode', () => client.getBytecode({ address: archiveAddress })],
  ...['mintSigner', 'maxMintPrice', 'paused', 'name', 'symbol', 'paymentToken'].map((functionName) => [
    `archive.${functionName}`,
    () => client.readContract({ address: archiveAddress, abi: archiveAbi, functionName }),
  ]),
  ...['name', 'symbol', 'decimals'].map((functionName) => [
    `paymentToken.${functionName}`,
    () => client.readContract({ address: paymentTokenAddress, abi: tokenAbi, functionName }),
  ]),
];
const delayArgument = process.argv.find((value) => value.startsWith('--delay='));
const delayMs = Math.max(0, Number(delayArgument?.slice('--delay='.length) ?? 0) || 0);

let failed = false;
for (const [name, probe] of probes) {
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  try {
    const value = await probe();
    const rendered = typeof value === 'bigint' ? value.toString() : String(value);
    console.log(`${name}=OK ${rendered.slice(0, 120)}`);
  } catch (error) {
    failed = true;
    const message = error && typeof error === 'object' && 'shortMessage' in error ? error.shortMessage : error instanceof Error ? error.message : String(error);
    console.error(`${name}=FAIL ${String(message).split('\n')[0]}`);
  }
}

process.exitCode = failed ? 1 : 0;
