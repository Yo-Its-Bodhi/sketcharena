import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { io } from 'socket.io-client';

const clientsRequested = boundedInteger(process.env.LOAD_CLIENTS, 32, 2, 160);
const roomSize = boundedInteger(process.env.LOAD_ROOM_SIZE, 8, 2, 8);
const actionsPerClient = boundedInteger(process.env.LOAD_ACTIONS_PER_CLIENT, 8, 2, 24);
const latencyBudgetMs = boundedInteger(process.env.LOAD_P95_BUDGET_MS, 1_500, 100, 10_000);
const metricsToken = 'local-load-metrics-token-at-least-32-characters';
const clients = [];
let child;

try {
  const port = await freePort(); const origin = `http://127.0.0.1:${port}`; assertSafeTarget(origin);
  const logs = [];
  child = spawn(process.execPath, ['apps/server/dist/index.js'], {
    cwd: process.cwd(), env: { ...process.env, NODE_ENV: 'test', PORT: String(port), BIND_HOST: '127.0.0.1', WEB_ORIGIN: origin, PUBLIC_APP_ORIGIN: origin,
      METRICS_TOKEN: metricsToken, ARTWORK_DATA_FILE: ':memory:', PROGRESSION_DATA_FILE: ':memory:', MINT_DATA_FILE: ':memory:', PROMOTION_DATA_FILE: ':memory:', REPORT_DATA_FILE: ':memory:', ACCOUNT_DATA_FILE: ':memory:', DATABASE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk) => logs.push(chunk.toString())); child.stderr?.on('data', (chunk) => logs.push(chunk.toString()));
  await waitReady(origin, child, logs);

  let broadcasts = 0;
  for (let index = 0; index < clientsRequested; index += 1) {
    const credential = createHash('sha256').update(`load-player-${index}`).digest('hex');
    const name = `Load ${index + 1}`;
    const cookie = await migrate(origin, credential, name);
    const socket = await connect(origin, cookie); socket.on('feed:item', () => { broadcasts += 1; }); clients.push(socket);
    const resumed = await acknowledged(socket, 'session:resume', { name });
    if (!resumed.ok) throw new Error(`Player ${index + 1} could not resume: ${resumed.error}`);
  }

  const roomIds = [];
  for (let offset = 0; offset < clients.length; offset += roomSize) {
    const group = clients.slice(offset, offset + roomSize); const created = await acknowledged(group[0], 'room:create', { name: `Load Room ${roomIds.length + 1}`, category: 'chaos', maxPlayers: roomSize, roundSeconds: 30, isPrivate: false });
    if (!created.ok) throw new Error(`Room creation failed: ${created.error}`); const roomId = created.data.room.id; roomIds.push(roomId);
    for (const member of group.slice(1)) { const joined = await acknowledged(member, 'room:join', { roomId }); if (!joined.ok) throw new Error(`Room join failed: ${joined.error}`); }
  }

  const latencies = []; let failures = 0; const startedAt = Date.now();
  await Promise.all(clients.flatMap((socket, clientIndex) => Array.from({ length: actionsPerClient }, async (_, actionIndex) => {
    const start = performance.now(); const result = actionIndex % 2
      ? await acknowledged(socket, 'reaction:send', { emoji: ['😂', '🔥', '👏', '🤯'][actionIndex % 4] })
      : await acknowledged(socket, 'chat:send', { text: `load-${clientIndex}-${actionIndex}` });
    latencies.push(performance.now() - start); if (!result.ok) failures += 1;
  })));
  await new Promise((resolve) => setTimeout(resolve, 150));

  const metricsResponse = await fetch(`${origin}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } });
  if (!metricsResponse.ok) throw new Error(`Metrics returned ${metricsResponse.status}`); const metrics = await metricsResponse.text();
  const reportedConnections = metric(metrics, 'sketch_arena_connections'); const reportedRooms = metric(metrics, 'sketch_arena_rooms');
  latencies.sort((a, b) => a - b); const p95 = percentile(latencies, .95); const durationMs = Date.now() - startedAt; const totalActions = clients.length * actionsPerClient;
  if (failures) throw new Error(`${failures}/${totalActions} acknowledged actions failed`);
  if (p95 > latencyBudgetMs) throw new Error(`p95 ${p95.toFixed(1)}ms exceeded ${latencyBudgetMs}ms budget`);
  if (reportedConnections !== clients.length || reportedRooms !== roomIds.length) throw new Error(`Metrics mismatch: ${reportedConnections} connections/${reportedRooms} rooms`);
  if (broadcasts < totalActions) throw new Error(`Only ${broadcasts} feed broadcasts observed for ${totalActions} actions`);
  console.log(JSON.stringify({ ok: true, clients: clients.length, rooms: roomIds.length, totalActions, failures, p50Ms: round(percentile(latencies, .5)), p95Ms: round(p95), maxMs: round(latencies.at(-1) ?? 0), broadcasts, durationMs }));
} finally {
  for (const socket of clients) socket.disconnect();
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await Promise.race([new Promise((resolve) => child.once('exit', resolve)), new Promise((resolve) => setTimeout(resolve, 2_000))]); }
}

function boundedInteger(value, fallback, minimum, maximum) { const parsed = Number(value ?? fallback); if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw new Error(`Load setting must be an integer from ${minimum} to ${maximum}`); return parsed; }
function assertSafeTarget(origin) { const url = new URL(origin); if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname) && process.env.ALLOW_REMOTE_LOAD_TEST !== 'true') throw new Error('Refusing to load-test a non-loopback host'); }
function round(value) { return Math.round(value * 10) / 10; }
function percentile(values, quantile) { return values[Math.max(0, Math.ceil(values.length * quantile) - 1)] ?? 0; }
function metric(text, name) { const match = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, 'm')); if (!match) throw new Error(`Metric ${name} missing`); return Number(match[1]); }
function acknowledged(socket, event, payload) { return new Promise((resolve) => { const timer = setTimeout(() => resolve({ ok: false, error: `${event} timed out` }), 5_000); socket.emit(event, payload, (result) => { clearTimeout(timer); resolve(result); }); }); }
async function migrate(origin, credential, name) {
  const response = await fetch(`${origin}/api/account/migrate`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, deviceLabel: 'Load test client' }) });
  if (!response.ok) throw new Error(`Could not establish ${name}: ${response.status} ${await response.text()}`);
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error(`Could not establish ${name}: session cookie missing`);
  return cookie;
}
function connect(origin, cookie) { return new Promise((resolve, reject) => { const socket = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : undefined }); socket.once('connect', () => resolve(socket)); socket.once('connect_error', reject); }); }
async function freePort() { const server = createServer(); await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); const port = server.address().port; await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); return port; }
async function waitReady(origin, processHandle, logs) { for (let attempt = 0; attempt < 100; attempt += 1) { if (processHandle.exitCode !== null) throw new Error(`Load server exited early\n${logs.join('')}`); try { if ((await fetch(`${origin}/health/ready`)).ok) return; } catch { /* starting */ } await new Promise((resolve) => setTimeout(resolve, 50)); } throw new Error(`Load server did not become ready\n${logs.join('')}`); }
