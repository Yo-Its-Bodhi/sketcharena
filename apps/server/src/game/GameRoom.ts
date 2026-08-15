import { randomBytes, randomUUID } from 'node:crypto';
import type { CanvasRatio, FeedItem, MatchResult, PlayerView, RoomPhase, RoomView, RoundResult, Stroke } from '@sketch-arena/protocol';
import { randomWord } from '../words.js';

export const GAME = {
  minPlayers: 2,
  maxPlayers: 8,
  roundsPerPlayer: 1,
  countdownMs: 3_000,
  roundMs: 45_000,
  revealMs: 8_000,
  reconnectMs: 20_000,
  maxStrokes: 1_500,
  maxPointsPerStroke: 250,
} as const;

interface PlayerRecord {
  id: string;
  socketId: string | null;
  sessionId: string;
  name: string;
  avatarSeed: number;
  score: number;
  roundScore: number;
  streak: number;
  maxStreak: number;
  connected: boolean;
  disconnectAt: number | null;
}

export interface RoomEventMap {
  state: (room: RoomView) => void;
  brief: (socketId: string, payload: { prompt: string; round: number; totalRounds: number }) => void;
  feed: (item: FeedItem) => void;
  reveal: (result: RoundResult) => void;
  complete: (result: MatchResult) => void;
  stroke: (stroke: Stroke, exceptSocketId: string) => void;
  preview: (stroke: Stroke, exceptSocketId: string) => void;
  clear: () => void;
}

type Handler<K extends keyof RoomEventMap> = RoomEventMap[K];

export class GameRoom {
  readonly id = randomUUID().slice(0, 10);
  readonly inviteCode: string | null;
  readonly createdAt = Date.now();
  readonly players = new Map<string, PlayerRecord>();
  readonly rounds: RoundResult[] = [];
  readonly keptRoundIds = new Set<string>();
  phase: RoomPhase = 'lobby';
  hostId: string | null = null;
  drawerId: string | null = null;
  round = 0;
  totalRounds = 0;
  deadline: number | null = null;
  hints: string[] = [];
  strokes: Stroke[] = [];
  canvasRatio: CanvasRatio = 'square';
  currentPrompt = '';
  currentRoundId = '';
  correct = new Map<string, { playerName: string; points: number; elapsedMs: number }>();
  funnyGuesses: FeedItem[] = [];
  private drawerOrder: string[] = [];
  private startedAt = 0;
  private timer: NodeJS.Timeout | null = null;
  private hintTimers: NodeJS.Timeout[] = [];
  private listeners = new Map<keyof RoomEventMap, Set<RoomEventMap[keyof RoomEventMap]>>();

  constructor(
    readonly name: string,
    readonly category = 'chaos',
    readonly isPrivate = false,
    readonly maxPlayers: number = GAME.maxPlayers,
    private readonly clock: () => number = Date.now,
    private readonly random: () => number = Math.random,
  ) {
    this.inviteCode = isPrivate ? randomBytes(4).toString('hex').toUpperCase() : null;
  }

  on<K extends keyof RoomEventMap>(event: K, handler: Handler<K>): () => void {
    let set = this.listeners.get(event) as Set<Handler<K>> | undefined;
    if (!set) {
      set = new Set<Handler<K>>();
      this.listeners.set(event, set as Set<RoomEventMap[keyof RoomEventMap]>);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  private emit<K extends keyof RoomEventMap>(event: K, ...args: Parameters<RoomEventMap[K]>): void {
    const set = this.listeners.get(event) as Set<(...values: Parameters<RoomEventMap[K]>) => void> | undefined;
    set?.forEach((handler) => handler(...args));
  }

  join(sessionId: string, socketId: string, name: string): PlayerView {
    const returning = [...this.players.values()].find((player) => player.sessionId === sessionId);
    if (returning) {
      returning.socketId = socketId;
      returning.connected = true;
      returning.disconnectAt = null;
      returning.name = name;
      if (this.phase === 'paused' && this.connectedPlayerCount() >= GAME.minPlayers) this.beginCountdown();
      else this.emitState();
      return this.playerView(returning);
    }
    if (this.phase !== 'lobby') throw new Error('This match is already underway');
    if (this.players.size >= this.maxPlayers) throw new Error('The arena is full');
    const player: PlayerRecord = {
      id: randomUUID().slice(0, 12), socketId, sessionId, name, avatarSeed: Math.floor(this.random() * 10_000),
      score: 0, roundScore: 0, streak: 0, maxStreak: 0, connected: true, disconnectAt: null,
    };
    this.players.set(player.id, player);
    this.hostId ??= player.id;
    this.emit('feed', this.system(`${name} entered the arena`));
    this.emitState();
    return this.playerView(player);
  }

  leaveBySession(sessionId: string): void {
    const player = this.bySession(sessionId);
    if (!player) return;
    const wasDrawer = player.id === this.drawerId;
    this.players.delete(player.id);
    this.drawerOrder = this.drawerOrder.filter((id) => id !== player.id);
    this.correct.delete(player.id);
    if (this.hostId === player.id) this.hostId = this.players.keys().next().value ?? null;
    this.emit('feed', this.system(`${player.name} left the arena`));

    if (wasDrawer && this.phase === 'drawing') this.finishRound('drawer-left');
    else if (this.phase !== 'lobby' && this.connectedPlayerCount() < GAME.minPlayers) this.resetToLobby('Waiting for more players');
    else this.emitState();
  }

  disconnect(sessionId: string): void {
    const player = this.bySession(sessionId);
    if (!player) return;
    player.socketId = null;
    player.connected = false;
    player.disconnectAt = this.clock();
    this.emit('feed', this.system(`${player.name} lost connection — holding their seat`));
    this.emitState();
  }

  removeExpiredDisconnects(now = this.clock()): void {
    for (const player of [...this.players.values()]) {
      if (!player.connected && player.disconnectAt !== null && now - player.disconnectAt >= GAME.reconnectMs) {
        this.leaveBySession(player.sessionId);
      }
    }
  }

  start(requestingSessionId: string): void {
    const requester = this.bySession(requestingSessionId);
    if (!requester || requester.id !== this.hostId) throw new Error('Only the host can start the match');
    if (this.phase !== 'lobby') throw new Error('The match has already started');
    if (this.connectedPlayerCount() < GAME.minPlayers) throw new Error('At least two players are required');
    this.rounds.length = 0;
    this.keptRoundIds.clear();
    this.round = 0;
    this.totalRounds = this.connectedPlayerCount() * GAME.roundsPerPlayer;
    this.drawerOrder = this.shuffle([...this.players.values()].filter((player) => player.connected).map((player) => player.id));
    for (const player of this.players.values()) {
      player.score = 0; player.roundScore = 0; player.streak = 0; player.maxStreak = 0;
    }
    this.beginCountdown();
  }

  rematch(requestingSessionId: string): void {
    const requester = this.bySession(requestingSessionId);
    if (!requester || requester.id !== this.hostId) throw new Error('Only the host can call the rematch');
    if (this.phase !== 'afterparty') throw new Error('Finish this match first');
    this.rounds.length = 0; this.keptRoundIds.clear(); this.round = 0; this.totalRounds = 0;
    for (const player of this.players.values()) { player.score = 0; player.roundScore = 0; player.streak = 0; player.maxStreak = 0; }
    this.resetToLobby('Same crew. Fresh disasters.');
  }

  private beginCountdown(): void {
    this.clearTimer();
    if (this.connectedPlayerCount() < GAME.minPlayers) {
      const heldSeats = [...this.players.values()].filter((player) => !player.connected && player.disconnectAt !== null);
      if (this.players.size >= GAME.minPlayers && heldSeats.length) {
        this.phase = 'paused';
        this.deadline = Math.min(...heldSeats.map((player) => player.disconnectAt! + GAME.reconnectMs));
        this.emitState();
        this.timer = setTimeout(() => this.beginCountdown(), Math.min(1_000, Math.max(50, this.deadline - this.clock())));
        return;
      }
      return this.resetToLobby('Waiting for more players');
    }
    if (this.round >= this.totalRounds || this.drawerOrder.length === 0) return this.completeMatch();
    this.phase = 'countdown';
    this.deadline = this.clock() + GAME.countdownMs;
    this.emitState();
    this.timer = setTimeout(() => this.beginRound(), GAME.countdownMs);
  }

  beginRound(): void {
    this.clearTimer();
    const drawerId = this.drawerOrder.shift();
    const drawer = drawerId ? this.players.get(drawerId) : undefined;
    if (!drawer?.connected || !drawer.socketId) return this.beginCountdown();

    this.round += 1;
    this.phase = 'drawing';
    this.drawerId = drawer.id;
    this.currentPrompt = randomWord(this.category, this.random);
    this.currentRoundId = randomUUID();
    this.startedAt = this.clock();
    this.deadline = this.startedAt + GAME.roundMs;
    this.hints = [...this.currentPrompt].map((character) => character === ' ' ? ' ' : '•');
    this.strokes = [];
    this.correct.clear();
    this.funnyGuesses = [];
    for (const player of this.players.values()) player.roundScore = 0;
    this.emit('brief', drawer.socketId, { prompt: this.currentPrompt, round: this.round, totalRounds: this.totalRounds });
    this.emitState();
    this.hintTimers = [0.36, 0.68].map((portion) => setTimeout(() => this.revealHint(), GAME.roundMs * portion));
    this.timer = setTimeout(() => this.finishRound('time'), GAME.roundMs);
  }

  submitGuess(sessionId: string, text: string): { correct: boolean; close: boolean } {
    if (this.phase !== 'drawing') throw new Error('Guesses are closed');
    const player = this.bySession(sessionId);
    if (!player || !player.connected) throw new Error('Player not found');
    if (player.id === this.drawerId) throw new Error('The drawer cannot guess');
    if (this.correct.has(player.id)) throw new Error('You already got it');
    const normalized = normalize(text);
    const answer = normalize(this.currentPrompt);
    if (!normalized) throw new Error('Type a guess');

    if (normalized === answer) {
      const elapsedMs = this.clock() - this.startedAt;
      const urgency = Math.max(0, 1 - elapsedMs / GAME.roundMs);
      const points = Math.round(100 + urgency * 400 + Math.min(player.streak * 25, 100));
      player.score += points;
      player.roundScore += points;
      player.streak += 1;
      player.maxStreak = Math.max(player.maxStreak, player.streak);
      this.correct.set(player.id, { playerName: player.name, points, elapsedMs });
      const drawer = this.drawerId ? this.players.get(this.drawerId) : undefined;
      if (drawer) { drawer.score += 100; drawer.roundScore += 100; }
      this.emit('feed', { id: randomUUID(), kind: 'correct', playerId: player.id, playerName: player.name, text: 'got it!', at: this.clock(), points });
      this.emitState();
      if (this.everyGuesserFinished()) this.finishRound('all-guessed');
      return { correct: true, close: false };
    }

    player.streak = 0;
    const close = similarity(normalized, answer) >= 0.72;
    const item: FeedItem = { id: randomUUID(), kind: close ? 'close' : 'guess', playerId: player.id, playerName: player.name, text: text.trim().slice(0, 80), at: this.clock() };
    this.funnyGuesses.push(item);
    this.funnyGuesses = this.funnyGuesses.slice(-12);
    this.emit('feed', item);
    return { correct: false, close };
  }

  sendChat(sessionId: string, text: string): void {
    const player = this.bySession(sessionId);
    if (!player) throw new Error('Player not found');
    this.emit('feed', { id: randomUUID(), kind: 'chat', playerId: player.id, playerName: player.name, text: text.trim().slice(0, 160), at: this.clock() });
  }

  react(sessionId: string, emoji: string): void {
    const player = this.bySession(sessionId);
    if (!player) throw new Error('Player not found');
    this.emit('feed', { id: randomUUID(), kind: 'reaction', playerId: player.id, playerName: player.name, text: emoji, at: this.clock() });
  }

  addStroke(sessionId: string, stroke: Stroke): void {
    if (this.phase !== 'drawing') return;
    const drawer = this.bySession(sessionId);
    if (!drawer || drawer.id !== this.drawerId || !drawer.socketId || this.strokes.length >= GAME.maxStrokes) return;
    const safe: Stroke = { ...stroke, points: stroke.points.slice(0, GAME.maxPointsPerStroke), at: this.clock() - this.startedAt };
    this.strokes.push(safe);
    this.emit('stroke', safe, drawer.socketId);
  }

  previewStroke(sessionId: string, stroke: Stroke): void {
    if (this.phase !== 'drawing') return;
    const drawer = this.bySession(sessionId);
    if (!drawer || drawer.id !== this.drawerId || !drawer.socketId) return;
    const safe: Stroke = { ...stroke, points: stroke.points.slice(0, GAME.maxPointsPerStroke), at: this.clock() - this.startedAt };
    this.emit('preview', safe, drawer.socketId);
  }

  clearCanvas(sessionId: string): void {
    if (this.bySession(sessionId)?.id !== this.drawerId) return;
    this.strokes = [];
    this.emit('clear');
  }

  undo(sessionId: string): void {
    if (this.bySession(sessionId)?.id !== this.drawerId) return;
    this.strokes.pop();
    this.emitState();
  }

  finishRound(reason: RoundResult['reason']): void {
    if (this.phase !== 'drawing') return;
    this.clearTimer();
    this.phase = 'reveal';
    this.deadline = this.clock() + GAME.revealMs;
    const drawer = this.drawerId ? this.players.get(this.drawerId) : undefined;
    const result: RoundResult = {
      roundId: this.currentRoundId, prompt: this.currentPrompt, drawerId: this.drawerId,
      drawerName: drawer?.name ?? 'Mystery Artist', strokes: [...this.strokes], scores: this.sortedPlayers(),
      correct: [...this.correct.entries()].map(([playerId, value]) => ({ playerId, ...value })),
      funniestCandidates: [...this.funnyGuesses], reason, endedAt: this.clock(),
    };
    this.rounds.push(result);
    this.emit('reveal', result);
    this.emitState();
    this.timer = setTimeout(() => this.beginCountdown(), GAME.revealMs);
  }

  keepRound(sessionId: string, roundId: string): void {
    const round = this.rounds.find((value) => value.roundId === roundId);
    const player = this.bySession(sessionId);
    if (!round || !player || round.drawerId !== player.id) throw new Error('Only the artist can keep this drawing');
    this.keptRoundIds.add(roundId);
  }

  view(): RoomView {
    return {
      id: this.id, name: this.name, phase: this.phase, playerCount: this.connectedPlayerCount(), maxPlayers: this.maxPlayers,
      category: this.category, isPrivate: this.isPrivate, players: this.sortedPlayers(), hostId: this.hostId,
      drawerId: this.drawerId, round: this.round, totalRounds: this.totalRounds, deadline: this.deadline,
      hints: [...this.hints], strokes: [...this.strokes], canvasRatio: this.canvasRatio,
    };
  }

  summary() { const { players: _players, ...summary } = this.view(); return summary; }
  hasSession(sessionId: string): boolean { return Boolean(this.bySession(sessionId)); }
  currentBriefForSession(sessionId: string): { prompt: string; round: number; totalRounds: number } | null {
    return this.phase === 'drawing' && this.bySession(sessionId)?.id === this.drawerId
      ? { prompt: this.currentPrompt, round: this.round, totalRounds: this.totalRounds } : null;
  }
  currentReveal(): RoundResult | null { return this.phase === 'reveal' ? this.rounds.at(-1) ?? null : null; }
  matchResult(): MatchResult | null {
    if (this.phase !== 'afterparty') return null;
    const standings = this.sortedPlayers();
    return { roomId: this.id, rounds: [...this.rounds], standings, winner: standings[0] ?? null };
  }
  isEmpty(): boolean { return this.players.size === 0; }
  close(): void { this.clearTimer(); this.listeners.clear(); }

  private completeMatch(): void {
    this.clearTimer();
    this.phase = 'afterparty';
    this.deadline = null;
    const standings = this.sortedPlayers();
    this.emit('complete', { roomId: this.id, rounds: [...this.rounds], standings, winner: standings[0] ?? null });
    this.emitState();
  }

  private resetToLobby(message: string): void {
    this.clearTimer();
    this.phase = 'lobby'; this.drawerId = null; this.deadline = null; this.currentPrompt = ''; this.strokes = [];
    this.emit('feed', this.system(message));
    this.emitState();
  }

  private emitState(): void { this.emit('state', this.view()); }
  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.hintTimers.forEach(clearTimeout);
    this.hintTimers = [];
  }
  private revealHint(): void {
    if (this.phase !== 'drawing') return;
    const hidden = this.hints.map((value, index) => value === '•' ? index : -1).filter((index) => index >= 0);
    if (!hidden.length) return;
    const revealCount = Math.max(1, Math.ceil(hidden.length * 0.18));
    for (let count = 0; count < revealCount && hidden.length; count += 1) {
      const pick = Math.floor(this.random() * hidden.length);
      const index = hidden.splice(pick, 1)[0]!;
      this.hints[index] = this.currentPrompt[index]!;
    }
    this.emitState();
  }
  private bySession(sessionId: string): PlayerRecord | undefined { return [...this.players.values()].find((player) => player.sessionId === sessionId); }
  private connectedPlayerCount(): number { return [...this.players.values()].filter((player) => player.connected).length; }
  private everyGuesserFinished(): boolean {
    return [...this.players.values()].filter((player) => player.connected && player.id !== this.drawerId).every((player) => this.correct.has(player.id));
  }
  private sortedPlayers(): PlayerView[] { return [...this.players.values()].map((player) => this.playerView(player)).sort((a, b) => b.score - a.score); }
  private playerView(player: PlayerRecord): PlayerView {
    return { id: player.id, sessionId: player.sessionId, name: player.name, avatarSeed: player.avatarSeed, score: player.score,
      roundScore: player.roundScore, streak: player.streak, isHost: player.id === this.hostId, isDrawer: player.id === this.drawerId,
      hasGuessed: this.correct.has(player.id), connected: player.connected };
  }
  private system(text: string): FeedItem { return { id: randomUUID(), kind: 'system', text, at: this.clock() }; }
  private shuffle(values: string[]): string[] {
    for (let index = values.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(this.random() * (index + 1));
      [values[index], values[swap]] = [values[swap]!, values[index]!];
    }
    return values;
  }
}

function normalize(value: string): string { return value.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' '); }

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const rows = Array.from({ length: a.length + 1 }, (_, index) => [index, ...Array<number>(b.length).fill(0)]);
  for (let column = 1; column <= b.length; column += 1) rows[0]![column] = column;
  for (let row = 1; row <= a.length; row += 1) for (let column = 1; column <= b.length; column += 1) {
    rows[row]![column] = Math.min(rows[row - 1]![column]! + 1, rows[row]![column - 1]! + 1, rows[row - 1]![column - 1]! + (a[row - 1] === b[column - 1] ? 0 : 1));
  }
  return 1 - rows[a.length]![b.length]! / Math.max(a.length, b.length, 1);
}
