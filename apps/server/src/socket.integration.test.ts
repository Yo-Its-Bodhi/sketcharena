import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { io, type Socket } from 'socket.io-client';
import type { ArtworkDocument, ClientToServerEvents, ModerationReport, RoomView, RoundResult, ServerToClientEvents, Stroke } from '@sketch-arena/protocol';

type ArenaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(origin: string, child: ChildProcess, logs: string[]): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Socket test server exited early (${child.exitCode})\n${logs.join('')}`);
    try { const response = await fetch(`${origin}/health/ready`); if (response.ok) return; } catch { /* startup still in progress */ }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Socket test server did not become ready\n${logs.join('')}`);
}

function connect(origin: string, cookie?: string): Promise<ArenaSocket> {
  return new Promise((resolve, reject) => {
    const socket: ArenaSocket = io(origin, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: cookie ? { cookie } : undefined });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function nextRoomState(socket: ArenaSocket): Promise<RoomView> {
  return new Promise((resolve) => socket.once('room:state', resolve));
}

describe('Socket.IO authoritative transport lifecycle', () => {
  let child: ChildProcess;
  let origin = '';
  const logs: string[] = [];
  const sockets: ArenaSocket[] = [];
  const metricsToken = 'metrics-secret-that-is-definitely-32-characters';
  const backstageToken = 'operator-secret-that-is-definitely-32-chars';

  beforeAll(async () => {
    const port = await freePort(); origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, ['dist/index.js'], {
      cwd: process.cwd(), env: { ...process.env, PORT: String(port), BIND_HOST: '127.0.0.1', WEB_ORIGIN: origin, PUBLIC_APP_ORIGIN: origin, METRICS_TOKEN: metricsToken, RELEASE_SHA: 'integration-test-sha', BACKSTAGE_CREDENTIALS: JSON.stringify([{ name: 'test-moderator', role: 'operator', tokenHash: createHash('sha256').update(backstageToken).digest('hex') }]), ARTWORK_DATA_FILE: ':memory:', PROGRESSION_DATA_FILE: ':memory:', MINT_DATA_FILE: ':memory:', PROMOTION_DATA_FILE: ':memory:', REPORT_DATA_FILE: ':memory:', ACCOUNT_DATA_FILE: ':memory:' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout?.on('data', (chunk: Buffer) => logs.push(chunk.toString())); child.stderr?.on('data', (chunk: Buffer) => logs.push(chunk.toString()));
    await waitForServer(origin, child, logs);
  }, 15_000);

  afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    if (!child || child.exitCode !== null) return;
    child.kill('SIGTERM');
    await Promise.race([new Promise<void>((resolve) => child.once('exit', () => resolve())), new Promise<void>((resolve) => setTimeout(resolve, 2_000))]);
  });

  it('publishes correlated liveness and readiness without exposing configuration', async () => {
    const [liveResponse, readyResponse, roomsResponse, deniedMetrics, metricsResponse] = await Promise.all([
      fetch(`${origin}/health/live`), fetch(`${origin}/health/ready`), fetch(`${origin}/api/rooms`), fetch(`${origin}/metrics`),
      fetch(`${origin}/metrics`, { headers: { authorization: `Bearer ${metricsToken}` } }),
    ]);
    expect(liveResponse.status).toBe(200); expect(await liveResponse.json()).toMatchObject({ ok: true });
    expect(readyResponse.status).toBe(200);
    const readiness = await readyResponse.json() as Record<string, unknown>;
    expect(readiness).toMatchObject({ ok: true, status: 'ready', rooms: 0, connections: 0 });
    expect(JSON.stringify(readiness)).not.toMatch(/secret|token|private|rpc/i);
    expect(readiness).toMatchObject({ release: 'integration-test-sha' });
    expect(deniedMetrics.status).toBe(401);
    const metrics = await metricsResponse.text();
    expect(metricsResponse.status).toBe(200);
    expect(metrics).toContain('sketch_arena_ready 1');
    expect(metrics).toContain('sketch_arena_release_info{release="integration-test-sha"} 1');
    expect(metrics).not.toContain(metricsToken);
    expect(roomsResponse.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/i);
    expect(logs.join('')).toContain('"event":"server.ready"');
  });

  it('reserves a larger request budget for detailed Vault artwork only', async () => {
    const artworkBody = JSON.stringify({ padding: 'x'.repeat(5_000_000) });
    const ordinaryBody = JSON.stringify({ padding: 'x'.repeat(300_000) });
    const [artworkResponse, ordinaryResponse] = await Promise.all([
      fetch(`${origin}/api/artworks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: artworkBody }),
      fetch(`${origin}/api/promotions/redeem`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: ordinaryBody }),
    ]);
    expect(artworkResponse.status).toBe(401);
    expect(ordinaryResponse.status).toBe(413);
    expect(await ordinaryResponse.json()).toMatchObject({ error: 'Request is too large' });
  });

  it('migrates a legacy Vault into a revocable cookie session used by HTTP and live play', async () => {
    const credential = 'c'.repeat(64);
    const migrated = await fetch(`${origin}/api/account/migrate`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Cookie Player', deviceLabel: 'Integration browser' }) });
    expect(migrated.status).toBe(201); const account = await migrated.json() as { id: string; name: string; secured: boolean };
    expect(account).toMatchObject({ name: 'Cookie Player', secured: false });
    const cookie = migrated.headers.getSetCookie()[0]?.split(';')[0]; expect(cookie).toMatch(/^sketch_session=/);
    const accountResponse = await fetch(`${origin}/api/account`, { headers: { cookie: cookie! } });
    expect(accountResponse.status).toBe(200); expect(await accountResponse.json()).toMatchObject({ id: account.id, name: 'Cookie Player', passkeyCount: 0 });
    const duplicate = await fetch(`${origin}/api/account/migrate`, { method: 'POST', headers: { authorization: `Bearer ${'d'.repeat(64)}`, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'cookie player', deviceLabel: 'Impostor browser' }) });
    expect(duplicate.status).toBe(409); expect(await duplicate.json()).toMatchObject({ error: expect.stringContaining('already claimed') });
    const options = await fetch(`${origin}/api/account/passkeys/register/options`, { method: 'POST', headers: { cookie: cookie! } });
    expect(options.status).toBe(200); expect(await options.json()).toMatchObject({ options: { rp: { id: '127.0.0.1' }, authenticatorSelection: { residentKey: 'required', userVerification: 'required' } } });
    const player = await connect(origin, cookie); sockets.push(player);
    const resumed = await new Promise<{ ok: boolean; data?: { sessionId: string } }>((resolve) => player.emit('session:resume', { name: 'Cookie Player' }, resolve));
    expect(resumed).toMatchObject({ ok: true, data: { sessionId: account.id } });
  });

  it('joins two players, replaces a duplicate tab, rejects stale actions, and migrates the host', async () => {
    const aliceCredential = 'a'.repeat(64); const bobCredential = 'b'.repeat(64);
    const migrate = async (credential: string, name: string) => { const response = await fetch(`${origin}/api/account/migrate`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, deviceLabel: `${name} browser` }) }); expect(response.status).toBe(201); return response.headers.getSetCookie()[0]?.split(';')[0]; };
    const aliceCookie = await migrate(aliceCredential, 'Alice'); const bobCookie = await migrate(bobCredential, 'Bob');
    const alice = await connect(origin, aliceCookie); const bob = await connect(origin, bobCookie); sockets.push(alice, bob);
    const aliceSession = await new Promise<{ ok: boolean; data?: { sessionId: string }; error?: string }>((resolve) => alice.emit('session:resume', { name: 'Not Alice' }, resolve));
    const bobSession = await new Promise<{ ok: boolean; data?: { sessionId: string }; error?: string }>((resolve) => bob.emit('session:resume', { name: 'Not Bob' }, resolve));
    expect(aliceSession.ok).toBe(true); expect(bobSession.ok).toBe(true);

    const created = await new Promise<{ ok: boolean; data?: { room: RoomView }; error?: string }>((resolve) => alice.emit('room:create', { name: 'Transport Test', category: 'chaos', isPrivate: false, maxPlayers: 4, roundSeconds: 30 }, resolve));
    expect(created.ok).toBe(true); const roomId = created.data!.room.id;
    const aliceSawJoin = nextRoomState(alice);
    const joined = await new Promise<{ ok: boolean; data?: { room: RoomView }; error?: string }>((resolve) => bob.emit('room:join', { roomId }, resolve));
    expect(joined.ok).toBe(true); expect((await aliceSawJoin).playerCount).toBe(2);

    const oversizedStroke: Stroke = { id: 'oversized-stroke', tool: 'pencil', color: '#000000', size: 6, at: Date.now(), shape: 'freehand', points: Array.from({ length: 251 }, (_, index) => ({ x: index / 251, y: .5, pressure: .5 })) };
    const rejectedStroke = await new Promise<{ ok: boolean; error?: string }>((resolve) => alice.emit('draw:stroke', oversizedStroke, resolve));
    expect(rejectedStroke.ok).toBe(false); expect(rejectedStroke.error).toBeTruthy();

    const alicePlayer = joined.data!.room.players.find((player) => player.name === 'Alice')!;
    const reportAck = await new Promise<{ ok: boolean; data?: { reportId: string }; error?: string }>((resolve) => bob.emit('player:report', { playerId: alicePlayer.id, category: 'harassment', detail: 'Repeated targeted abuse during the room chat.' }, resolve));
    expect(reportAck.ok).toBe(true); expect(reportAck.data?.reportId).toMatch(/^[0-9a-f-]{36}$/i);
    const staffHeaders = { authorization: `Bearer ${backstageToken}`, 'content-type': 'application/json' };
    const closedPremium = await fetch(`${origin}/api/admin/grants`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ kind: 'battle-pass', amount: 1, reason: 'Season 0 must stay free', sessionIds: [aliceSession.data!.sessionId], idempotencyKey: 'closed-season-zero-premium' }) });
    expect(closedPremium.status).toBe(400); expect(await closedPremium.json()).toMatchObject({ error: 'Reward grant is invalid' });
    const reportResponse = await fetch(`${origin}/api/admin/reports`, { headers: staffHeaders });
    expect(reportResponse.status).toBe(200); const reportList = await reportResponse.json() as ModerationReport[];
    expect(reportList[0]).toMatchObject({ id: reportAck.data!.reportId, reporterName: 'Bob', targetName: 'Alice', status: 'open' });
    const reviewedResponse = await fetch(`${origin}/api/admin/reports/${reportAck.data!.reportId}/status`, { method: 'POST', headers: staffHeaders, body: JSON.stringify({ status: 'resolved', resolutionNote: 'Reviewed by the integration moderator.' }) });
    expect(reviewedResponse.status).toBe(200); expect(await reviewedResponse.json()).toMatchObject({ status: 'resolved', handledBy: 'backstage:test-moderator' });

    const replacement = await connect(origin, aliceCookie); sockets.push(replacement); const replacementState = nextRoomState(replacement);
    const resumed = await new Promise<{ ok: boolean; data?: { sessionId: string }; error?: string }>((resolve) => replacement.emit('session:resume', { name: 'Definitely Not Alice' }, resolve));
    expect(resumed.ok).toBe(true); expect((await replacementState).players.find((player) => player.name === 'Alice')?.connected).toBe(true);

    const staleAction = await new Promise<{ ok: boolean; error?: string }>((resolve) => alice.emit('chat:send', { text: 'stale tab speaking' }, resolve));
    expect(staleAction).toMatchObject({ ok: false }); expect(staleAction.error).toContain('moved to another tab');
    alice.disconnect(); await new Promise((resolve) => setTimeout(resolve, 100));

    const bobSawMigration = nextRoomState(bob);
    const left = await new Promise<{ ok: boolean; error?: string }>((resolve) => replacement.emit('room:leave', resolve));
    expect(left.ok).toBe(true); const migrated = await bobSawMigration;
    expect(migrated.playerCount).toBe(1); expect(migrated.players[0]).toMatchObject({ name: 'Bob', isHost: true, connected: true });
  }, 10_000);

  it('keeps a finished drawing after heavy room activity and advertises another public room when the first is full', async () => {
    const createPlayer = async (credential: string, name: string) => {
      const response = await fetch(`${origin}/api/account/migrate`, { method: 'POST', headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' }, body: JSON.stringify({ name, deviceLabel: `${name} browser` }) });
      expect(response.status).toBe(201); const cookie = response.headers.getSetCookie()[0]?.split(';')[0]; const player = await connect(origin, cookie); sockets.push(player);
      const resumed = await new Promise<{ ok: boolean; data?: { sessionId: string }; error?: string }>((resolve) => player.emit('session:resume', { name }, resolve));
      expect(resumed.ok).toBe(true); return { player, cookie };
    };
    const host = await createPlayer('1'.repeat(64), 'Room Host'); const artist = await createPlayer('2'.repeat(64), 'Vault Artist'); const overflow = await createPlayer('3'.repeat(64), 'Overflow Host');
    const created = await new Promise<{ ok: boolean; data?: { room: RoomView }; error?: string }>((resolve) => host.player.emit('room:create', { name: 'Full Public Room', category: 'chaos', isPrivate: false, maxPlayers: 2, roundSeconds: 30 }, resolve));
    expect(created.ok).toBe(true); const roomId = created.data!.room.id;
    const joined = await new Promise<{ ok: boolean; data?: { room: RoomView }; error?: string }>((resolve) => artist.player.emit('room:join', { roomId }, resolve));
    expect(joined).toMatchObject({ ok: true, data: { room: { playerCount: 2, maxPlayers: 2 } } });
    const second = await new Promise<{ ok: boolean; data?: { room: RoomView }; error?: string }>((resolve) => overflow.player.emit('room:create', { name: 'Overflow Public Room', category: 'music', isPrivate: false, maxPlayers: 8, roundSeconds: 45 }, resolve));
    expect(second.ok).toBe(true);
    const advertised = await (await fetch(`${origin}/api/rooms`)).json() as Array<{ id: string; playerCount: number; maxPlayers: number }>;
    expect(advertised).toEqual(expect.arrayContaining([expect.objectContaining({ id: roomId, playerCount: 2, maxPlayers: 2 }), expect.objectContaining({ id: second.data!.room.id, playerCount: 1, maxPlayers: 8 })]));

    const brief = Promise.race([
      new Promise<{ socket: ArenaSocket; cookie: string; prompt: string }>((resolve) => host.player.once('round:brief', (value) => resolve({ socket: host.player, cookie: host.cookie!, prompt: value.prompt }))),
      new Promise<{ socket: ArenaSocket; cookie: string; prompt: string }>((resolve) => artist.player.once('round:brief', (value) => resolve({ socket: artist.player, cookie: artist.cookie!, prompt: value.prompt }))),
    ]);
    const started = await new Promise<{ ok: boolean; error?: string }>((resolve) => host.player.emit('game:start', resolve)); expect(started.ok).toBe(true);
    const drawer = await brief; const guesser = drawer.socket === host.player ? artist.player : host.player;
    const revealed = new Promise<RoundResult>((resolve) => drawer.socket.once('round:reveal', resolve));
    const guessed = await new Promise<{ ok: boolean; error?: string }>((resolve) => guesser.emit('guess:submit', { text: drawer.prompt }, resolve)); expect(guessed.ok).toBe(true);
    const round = await revealed;
    const reactions = await Promise.all(Array.from({ length: 40 }, () => new Promise<{ ok: boolean; error?: string }>((resolve) => drawer.socket.emit('reaction:send', { emoji: '😂' }, resolve))));
    expect(reactions.some((ack) => !ack.ok && ack.error === 'Slow down for a moment')).toBe(true);
    const keepResponse = await fetch(`${origin}/api/artworks`, { method: 'POST', headers: { cookie: drawer.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ origin: 'arena', status: 'gallery', title: round.prompt, canvasRatio: 'square', width: 1200, height: 1200, strokes: round.strokes, sourceRoundId: round.roundId }) });
    expect(keepResponse.status).toBe(201); const kept = await keepResponse.json() as ArtworkDocument;
    expect(kept).toMatchObject({ origin: 'arena', status: 'gallery', sourceRoundId: round.roundId });
    const vaultResponse = await fetch(`${origin}/api/artworks`, { headers: { cookie: drawer.cookie } }); expect(vaultResponse.status).toBe(200);
    expect(await vaultResponse.json()).toEqual(expect.arrayContaining([expect.objectContaining({ id: kept.id, sourceRoundId: round.roundId })]));
  }, 15_000);
});
