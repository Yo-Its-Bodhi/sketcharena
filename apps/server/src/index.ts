import { createServer } from 'node:http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { ClientToServerEvents, ServerToClientEvents, Stroke } from '@sketch-arena/protocol';
import { FileArtworkRepository, MemoryArtworkRepository } from './artwork/ArtworkRepository.js';
import { GAME, GameRoom } from './game/GameRoom.js';
import { SlidingLimit } from './rateLimit.js';

const PORT = Number(process.env.PORT ?? 4100);
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((value) => value.trim());
const app = express();
const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: WEB_ORIGINS, methods: ['GET', 'POST'] }, maxHttpBufferSize: 256_000,
  pingInterval: 20_000, pingTimeout: 15_000,
});

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: WEB_ORIGINS }));
app.use(express.json({ limit: '256kb' }));

const rooms = new Map<string, GameRoom>();
const roomBindings = new Set<string>();
const artwork = process.env.ARTWORK_DATA_FILE === ':memory:'
  ? new MemoryArtworkRepository()
  : new FileArtworkRepository(process.env.ARTWORK_DATA_FILE);
const actionLimit = new SlidingLimit(35, 10_000);
const guessLimit = new SlidingLimit(8, 5_000);

const nameSchema = z.string().trim().min(2).max(20).regex(/^[\p{L}\p{N}_. -]+$/u);
const sessionSchema = z.object({ sessionId: z.string().uuid(), name: nameSchema });
const roomCreateSchema = z.object({
  name: z.string().trim().min(2).max(36), category: z.enum(['chaos', 'classic', 'crypto']).default('chaos'),
  isPrivate: z.boolean().optional().default(false), maxPlayers: z.number().int().min(2).max(GAME.maxPlayers).optional().default(8),
});
const roomJoinSchema = z.object({ roomId: z.string().min(1).optional(), inviteCode: z.string().min(4).max(12).optional() }).refine((value) => value.roomId || value.inviteCode);
const textSchema = z.object({ text: z.string().trim().min(1).max(160) });
const strokeSchema: z.ZodType<Stroke> = z.object({
  id: z.string().min(1).max(64), tool: z.enum(['pencil', 'eraser', 'fill']), color: z.string().regex(/^#[0-9a-f]{6}$/i),
  size: z.number().min(1).max(40), points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) })).min(1).max(GAME.maxPointsPerStroke),
  at: z.number().nonnegative(),
});
const artworkSchema = z.object({
  id: z.string().uuid().optional(), ownerSessionId: z.string().uuid(), origin: z.enum(['arena', 'studio']),
  status: z.enum(['draft', 'gallery', 'mint-ready']).optional(), title: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(), canvasRatio: z.enum(['square', 'portrait', 'landscape']),
  width: z.number().int().min(256).max(8000), height: z.number().int().min(256).max(8000),
  strokes: z.array(strokeSchema).max(GAME.maxStrokes), sourceRoundId: z.string().uuid().optional(),
});

app.get('/health', (_request, response) => response.json({ ok: true, rooms: rooms.size, now: Date.now() }));
app.get('/api/rooms', (_request, response) => response.json(publicRooms()));
app.get('/api/artworks', async (request, response) => {
  const sessionId = z.string().uuid().safeParse(request.query.sessionId);
  if (!sessionId.success) return response.status(400).json({ error: 'Valid sessionId required' });
  return response.json(await artwork.listByOwner(sessionId.data));
});
app.post('/api/artworks', async (request, response) => {
  const parsed = artworkSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Artwork package is invalid' });
  try { return response.status(201).json(await artwork.save(parsed.data)); }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Could not save artwork' }); }
});

io.on('connection', (socket) => {
  let sessionId: string | null = null;
  let playerName = '';

  socket.on('session:resume', (payload, ack) => {
    const parsed = sessionSchema.safeParse(payload);
    if (!parsed.success) return ack({ ok: false, error: 'Choose a name between 2 and 20 characters' });
    sessionId = parsed.data.sessionId; playerName = parsed.data.name;
    for (const room of rooms.values()) {
      if (!room.hasSession(sessionId)) continue;
      const player = room.join(sessionId, socket.id, playerName);
      socket.join(room.id);
      socket.emit('room:state', room.view());
      const brief = room.currentBriefForSession(sessionId); if (brief) socket.emit('round:brief', brief);
      const reveal = room.currentReveal(); if (reveal) socket.emit('round:reveal', reveal);
      const match = room.matchResult(); if (match) socket.emit('match:complete', match);
      void player;
      break;
    }
    ack({ ok: true, data: { sessionId } });
  });

  socket.on('rooms:subscribe', () => socket.emit('rooms:list', publicRooms()));

  socket.on('room:create', (payload, ack) => guarded(socket.id, ack, () => {
    requireSession(sessionId);
    const input = roomCreateSchema.parse(payload);
    leaveCurrent(sessionId!, socket.id);
    const room = new GameRoom(input.name, input.category, input.isPrivate, input.maxPlayers);
    rooms.set(room.id, room); bindRoom(room);
    socket.join(room.id); room.join(sessionId!, socket.id, playerName); socket.emit('room:state', room.view());
    broadcastRooms();
    return { room: room.view(), inviteCode: room.inviteCode ?? undefined };
  }));

  socket.on('room:join', (payload, ack) => guarded(socket.id, ack, () => {
    requireSession(sessionId);
    const input = roomJoinSchema.parse(payload);
    const room = input.inviteCode
      ? [...rooms.values()].find((candidate) => candidate.inviteCode === input.inviteCode?.toUpperCase())
      : rooms.get(input.roomId!);
    if (!room) throw new Error('Arena not found');
    if (room.isPrivate && room.inviteCode !== input.inviteCode?.toUpperCase()) throw new Error('Invite code required');
    leaveCurrent(sessionId!, socket.id);
    socket.join(room.id); room.join(sessionId!, socket.id, playerName); socket.emit('room:state', room.view()); broadcastRooms();
    return { room: room.view() };
  }));

  socket.on('room:leave', (ack) => guarded(socket.id, ack, () => { requireSession(sessionId); leaveCurrent(sessionId!, socket.id); return undefined; }));
  socket.on('game:start', (ack) => guarded(socket.id, ack, () => { const room = currentRoom(sessionId); room.start(sessionId!); return undefined; }));
  socket.on('game:rematch', (ack) => guarded(socket.id, ack, () => { const room = currentRoom(sessionId); room.rematch(sessionId!); return undefined; }));
  socket.on('guess:submit', (payload, ack) => guarded(socket.id, ack, () => {
    if (!guessLimit.take(socket.id)) throw new Error('Easy—give the chat a second');
    const input = textSchema.parse(payload); currentRoom(sessionId).submitGuess(sessionId!, input.text); return undefined;
  }));
  socket.on('chat:send', (payload, ack) => guarded(socket.id, ack, () => { const input = textSchema.parse(payload); currentRoom(sessionId).sendChat(sessionId!, input.text); return undefined; }));
  socket.on('reaction:send', (payload, ack) => guarded(socket.id, ack, () => {
    const emoji = z.enum(['😂', '🔥', '💀', '👏', '🤯', '❤️']).parse(payload.emoji); currentRoom(sessionId).react(sessionId!, emoji); return undefined;
  }));
  socket.on('draw:stroke', (stroke) => { const parsed = strokeSchema.safeParse(stroke); if (parsed.success && sessionId) currentRoomOrNull(sessionId)?.addStroke(sessionId, parsed.data); });
  socket.on('draw:preview', (stroke) => { const parsed = strokeSchema.safeParse(stroke); if (parsed.success && sessionId) currentRoomOrNull(sessionId)?.previewStroke(sessionId, parsed.data); });
  socket.on('draw:clear', () => { if (sessionId) currentRoomOrNull(sessionId)?.clearCanvas(sessionId); });
  socket.on('draw:undo', () => { if (sessionId) currentRoomOrNull(sessionId)?.undo(sessionId); });
  socket.on('round:keep', (payload, ack) => guarded(socket.id, ack, async () => {
    const room = currentRoom(sessionId); room.keepRound(sessionId!, payload.roundId);
    const round = room.rounds.find((value) => value.roundId === payload.roundId)!;
    return artwork.save({ ownerSessionId: sessionId!, origin: 'arena', status: 'gallery', title: round.prompt, canvasRatio: room.canvasRatio,
      width: 1200, height: 1200, strokes: round.strokes, sourceRoundId: round.roundId });
  }));

  socket.on('disconnect', () => {
    if (!sessionId) return;
    currentRoomOrNull(sessionId)?.disconnect(sessionId);
    actionLimit.forget(socket.id); guessLimit.forget(socket.id); broadcastRooms();
  });
});

function bindRoom(room: GameRoom): void {
  if (roomBindings.has(room.id)) return;
  roomBindings.add(room.id);
  room.on('state', (state) => { io.to(room.id).emit('room:state', state); broadcastRooms(); });
  room.on('feed', (item) => io.to(room.id).emit('feed:item', item));
  room.on('brief', (socketId, payload) => io.to(socketId).emit('round:brief', payload));
  room.on('stroke', (stroke, except) => socketBroadcastExcept(except, room.id, 'draw:stroke', stroke));
  room.on('preview', (stroke, except) => socketBroadcastExcept(except, room.id, 'draw:preview', stroke));
  room.on('clear', () => io.to(room.id).emit('draw:clear'));
  room.on('reveal', (result) => io.to(room.id).emit('round:reveal', result));
  room.on('complete', (result) => io.to(room.id).emit('match:complete', result));
}

function socketBroadcastExcept(socketId: string, roomId: string, event: 'draw:stroke' | 'draw:preview', stroke: Stroke): void {
  io.sockets.sockets.get(socketId)?.to(roomId).emit(event, stroke);
}
function publicRooms() { return [...rooms.values()].filter((room) => !room.isPrivate).map((room) => room.summary()); }
function broadcastRooms(): void { io.emit('rooms:list', publicRooms()); }
function currentRoom(sessionId: string | null): GameRoom { const room = currentRoomOrNull(sessionId); if (!room) throw new Error('Join an arena first'); return room; }
function currentRoomOrNull(sessionId: string | null): GameRoom | null { if (!sessionId) return null; return [...rooms.values()].find((room) => room.hasSession(sessionId)) ?? null; }
function leaveCurrent(sessionId: string, socketId?: string): void {
  const room = currentRoomOrNull(sessionId); if (!room) return;
  room.leaveBySession(sessionId);
  if (socketId) io.sockets.sockets.get(socketId)?.leave(room.id);
  if (room.isEmpty()) { room.close(); rooms.delete(room.id); roomBindings.delete(room.id); }
  broadcastRooms();
}
function requireSession(sessionId: string | null): asserts sessionId is string { if (!sessionId) throw new Error('Session not ready'); }
function guarded<T>(key: string, ack: (value: { ok: boolean; data?: T; error?: string }) => void, action: () => T | Promise<T>): void {
  if (!actionLimit.take(key)) return ack({ ok: false, error: 'Slow down for a moment' });
  Promise.resolve().then(action).then((data) => ack({ ok: true, data }), (error: unknown) => ack({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }));
}

setInterval(() => {
  for (const [id, room] of rooms) {
    room.removeExpiredDisconnects();
    if (room.isEmpty()) { room.close(); rooms.delete(id); roomBindings.delete(id); }
  }
  broadcastRooms();
}, 5_000).unref();

server.listen(PORT, BIND_HOST, () => console.log(`Sketch Arena server ready on http://${BIND_HOST}:${PORT}`));

function shutdown(): void {
  for (const room of rooms.values()) room.close();
  io.close(() => server.close(() => process.exit(0)));
  setTimeout(() => process.exit(1), 8_000).unref();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
