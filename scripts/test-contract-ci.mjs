import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import process from 'node:process';

const hardhatCli = resolve(process.cwd(), 'node_modules', 'hardhat', 'dist', 'src', 'cli.js');
const hardhatEnv = { ...process.env, HARDHAT_DISABLE_TELEMETRY_PROMPT: 'true' };
if (process.platform === 'win32' && !hardhatEnv.NODE_OPTIONS?.includes('process.geteuid')) {
  hardhatEnv.NODE_OPTIONS = `${hardhatEnv.NODE_OPTIONS ?? ''} --import=data:text/javascript,process.geteuid=()=>1000`.trim();
}
const node = spawn(process.execPath, [hardhatCli, 'node', '--config', 'hardhat.panic.cjs', '--hostname', '127.0.0.1', '--port', '8546'], {
  cwd: process.cwd(),
  env: hardhatEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let nodeOutput = '';
node.stdout.on('data', (chunk) => { nodeOutput += chunk.toString(); });
node.stderr.on('data', (chunk) => { nodeOutput += chunk.toString(); });

const waitForRpc = async () => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (node.exitCode !== null) throw new Error(`Ephemeral chain exited before becoming ready.\n${nodeOutput}`);
    try {
      const response = await fetch('http://127.0.0.1:8546', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      });
      if (response.ok) return;
    } catch { /* keep waiting */ }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`Ephemeral chain did not become ready.\n${nodeOutput}`);
};

const runHarness = () => new Promise((resolveRun, rejectRun) => {
  const harness = spawn(process.execPath, ['scripts/test-panic-archive.mjs'], { cwd: process.cwd(), env: process.env, stdio: 'inherit' });
  harness.on('error', rejectRun);
  harness.on('exit', (code) => code === 0 ? resolveRun() : rejectRun(new Error(`Contract harness exited with code ${code}`)));
});

try {
  await waitForRpc();
  await runHarness();
} finally {
  node.kill('SIGTERM');
}
