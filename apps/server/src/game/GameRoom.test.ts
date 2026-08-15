import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundResult, Stroke } from '@sketch-arena/protocol';
import { GAME, GameRoom } from './GameRoom.js';

describe('GameRoom authoritative lifecycle', () => {
  let now = 1_000_000;
  let room: GameRoom;
  let aliceId = '';
  let bobId = '';

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    room = new GameRoom('Friday Chaos', 'chaos', false, 8, () => now, () => 0);
    aliceId = room.join('11111111-1111-4111-8111-111111111111', 'socket-a', 'Alice').id;
    bobId = room.join('22222222-2222-4222-8222-222222222222', 'socket-b', 'Bob').id;
  });

  afterEach(() => {
    room.close();
    vi.useRealTimers();
  });

  it('allows only the host to start and rejects duplicate starts', () => {
    expect(() => room.start('22222222-2222-4222-8222-222222222222')).toThrow('Only the host');
    room.start('11111111-1111-4111-8111-111111111111');
    expect(room.phase).toBe('countdown');
    expect(() => room.start('11111111-1111-4111-8111-111111111111')).toThrow('already started');
  });

  it('scores an exact guess, rewards the artist, and ends when everyone guessed', () => {
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound();
    const guesserSession = room.drawerId === aliceId
      ? '22222222-2222-4222-8222-222222222222'
      : '11111111-1111-4111-8111-111111111111';
    now += 5_000;

    expect(room.submitGuess(guesserSession, `  ${room.currentPrompt.toUpperCase()}! `)).toEqual({ correct: true, close: false });
    expect(room.phase).toBe('reveal');
    expect(room.rounds).toHaveLength(1);
    expect(room.rounds[0]?.reason).toBe('all-guessed');
    expect(room.view().players.every((player) => player.score > 0)).toBe(true);
  });

  it('holds a disconnected seat, then safely resolves an expired drawer', () => {
    const reveals: RoundResult[] = [];
    room.on('reveal', (result) => reveals.push(result));
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound();
    const drawerSession = room.drawerId === aliceId
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222';

    room.disconnect(drawerSession);
    expect(room.players.size).toBe(2);
    room.removeExpiredDisconnects(now + GAME.reconnectMs - 1);
    expect(room.players.size).toBe(2);
    room.removeExpiredDisconnects(now + GAME.reconnectMs);

    expect(room.players.size).toBe(1);
    expect(room.phase).toBe('reveal');
    expect(reveals[0]?.reason).toBe('drawer-left');
  });

  it('accepts drawing data only from the current artist and caps point count', () => {
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound();
    const drawerSession = room.drawerId === aliceId
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222';
    const guesserSession = drawerSession.startsWith('1111')
      ? '22222222-2222-4222-8222-222222222222'
      : '11111111-1111-4111-8111-111111111111';
    const stroke: Stroke = {
      id: 'stroke-1', tool: 'pencil', color: '#ff5f46', size: 8,
      points: Array.from({ length: GAME.maxPointsPerStroke + 40 }, (_, index) => ({ x: index / 300, y: .5 })), at: 0,
    };

    room.addStroke(guesserSession, stroke);
    expect(room.strokes).toHaveLength(0);
    room.addStroke(drawerSession, stroke);
    expect(room.strokes[0]?.points).toHaveLength(GAME.maxPointsPerStroke);
  });

  it('streams safe drawing previews without committing duplicate strokes', () => {
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound();
    const drawerSession = room.drawerId === aliceId ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const previews: Stroke[] = []; room.on('preview', (stroke) => previews.push(stroke));
    const stroke: Stroke = { id: 'live-1', tool: 'pencil', color: '#171514', size: 6, points: [{ x: .1, y: .1 }, { x: .2, y: .2 }], at: 0 };
    room.previewStroke(drawerSession, stroke);
    expect(previews).toHaveLength(1); expect(room.strokes).toHaveLength(0);
    room.addStroke(drawerSession, stroke); expect(room.strokes).toHaveLength(1);
  });

  it('reveals timed hint letters while keeping the prompt secret from guessers', () => {
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound();
    const before = room.hints.filter((value) => value === '•').length;
    vi.advanceTimersByTime(GAME.roundMs * .36);
    expect(room.hints.filter((value) => value === '•').length).toBeLessThan(before);
    const drawerSession = room.drawerId === aliceId ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const guesserSession = drawerSession.startsWith('1111') ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';
    expect(room.currentBriefForSession(drawerSession)?.prompt).toBe(room.currentPrompt);
    expect(room.currentBriefForSession(guesserSession)).toBeNull();
  });

  it('pauses between rounds for a held seat and resumes when that player returns', () => {
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound(); room.finishRound('time');
    room.disconnect('22222222-2222-4222-8222-222222222222');
    vi.advanceTimersByTime(GAME.revealMs);
    expect(room.phase).toBe('paused');
    room.join('22222222-2222-4222-8222-222222222222', 'socket-b2', 'Bob');
    expect(room.phase).toBe('countdown');
  });

  it('lets only the artist keep their revealed round', () => {
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound();
    const drawerSession = room.drawerId === aliceId
      ? '11111111-1111-4111-8111-111111111111'
      : '22222222-2222-4222-8222-222222222222';
    const otherSession = drawerSession.startsWith('1111')
      ? '22222222-2222-4222-8222-222222222222'
      : '11111111-1111-4111-8111-111111111111';
    room.finishRound('time');
    const roundId = room.rounds[0]!.roundId;

    expect(() => room.keepRound(otherSession, roundId)).toThrow('Only the artist');
    expect(() => room.keepRound(drawerSession, roundId)).not.toThrow();
    expect(room.keptRoundIds.has(roundId)).toBe(true);
  });

  it('returns the same crew to a clean lobby for a host rematch', () => {
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound(); room.finishRound('time');
    vi.advanceTimersByTime(GAME.revealMs);
    room.beginRound(); room.finishRound('time');
    vi.advanceTimersByTime(GAME.revealMs);
    expect(room.phase).toBe('afterparty');

    expect(() => room.rematch('22222222-2222-4222-8222-222222222222')).toThrow('Only the host');
    room.rematch('11111111-1111-4111-8111-111111111111');
    expect(room.phase).toBe('lobby');
    expect(room.rounds).toHaveLength(0);
    expect(room.view().players.every((player) => player.score === 0)).toBe(true);
  });
});
