import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const siblingModules = process.env.PANIC_ARCHIVE_NODE_MODULES
  ? resolve(process.env.PANIC_ARCHIVE_NODE_MODULES)
  : resolve(process.cwd(), '..', 'nftvault', 'node_modules');
let solc;
try { solc = require('solc'); }
catch { solc = require(resolve(siblingModules, 'solc')); }

const contractPath = resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.sol');
const input = {
  language: 'Solidity',
  sources: { 'contracts/SketchArenaPanicArchive.sol': { content: readFileSync(contractPath, 'utf8') } },
  settings: {
    evmVersion: 'paris',
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object', 'evm.deployedBytecode.object'] } },
  },
};

const findImport = (name) => {
  const candidates = [resolve(process.cwd(), name), resolve(process.cwd(), 'node_modules', name), resolve(siblingModules, name)];
  for (const candidate of candidates) {
    try { return { contents: readFileSync(candidate, 'utf8') }; }
    catch { /* keep looking */ }
  }
  return { error: `Import not found: ${name}` };
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImport }));
const diagnostics = output.errors ?? [];
for (const item of diagnostics) console[item.severity === 'error' ? 'error' : 'warn'](item.formattedMessage.trim());
if (diagnostics.some((item) => item.severity === 'error')) process.exitCode = 1;
else {
  const contract = output.contracts['contracts/SketchArenaPanicArchive.sol'].SketchArenaPanicArchive;
  const deployedBytes = contract.evm.deployedBytecode.object.length / 2;
  if (deployedBytes > 24_576) throw new Error(`Deployed bytecode exceeds EIP-170: ${deployedBytes} bytes`);
  console.log(`Panic Archive contract compiled with solc ${solc.version()}`);
  console.log(`ABI entries: ${contract.abi.length}; deployed bytecode: ${deployedBytes} bytes`);
  if (process.argv.includes('--write-artifact')) {
    const artifactPath = resolve(process.cwd(), 'contracts', 'SketchArenaPanicArchive.artifact.json');
    writeFileSync(artifactPath, `${JSON.stringify({
      contractName: 'SketchArenaPanicArchive',
      compiler: solc.version(),
      evmVersion: input.settings.evmVersion,
      sourceSha256: createHash('sha256').update(input.sources['contracts/SketchArenaPanicArchive.sol'].content).digest('hex'),
      abi: contract.abi,
      bytecode: `0x${contract.evm.bytecode.object}`,
      deployedBytecode: `0x${contract.evm.deployedBytecode.object}`,
    }, null, 2)}\n`);
    console.log(`Wrote reviewed deployment artifact: ${artifactPath}`);
  }
}
