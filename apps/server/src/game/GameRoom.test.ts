import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoundResult, Stroke } from '@sketch-arena/protocol';
import { GAME, GameRoom } from './GameRoom.js';

describe('GameRoom authoritative lifecycle', () => {
  let now = 1_000_000;
  let room: GameRoom;
  let aliceId = '';

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    room = new GameRoom('Friday Chaos', 'chaos', false, 8, GAME.roundMs, () => now, () => 0);
    aliceId = room.join('11111111-1111-4111-8111-111111111111', 'socket-a', 'Alice').id;
    room.join('22222222-2222-4222-8222-222222222222', 'socket-b', 'Bob');
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

  it('publishes an equipped avatar cosmetic to the room without exposing inventory', () => {
    room.join('11111111-1111-4111-8111-111111111111', 'socket-a-new', 'Alice', 'golden-chaos-avatar');
    expect(room.view().players.find((player) => player.name === 'Alice')).toMatchObject({ avatarItem: 'golden-chaos-avatar', avatarSeed: 1 });
  });

  it('uses room capacity as the fixed match length and rotates two players evenly', () => {
    room.start('11111111-1111-4111-8111-111111111111');
    expect(room.totalRounds).toBe(8);
    const drawers: string[] = [];
    for (let round = 0; round < 8; round += 1) {
      room.beginRound(); drawers.push(room.drawerId!); room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    }

    expect(room.phase).toBe('afterparty');
    expect(room.rounds).toHaveLength(8);
    expect(drawers.filter((id) => id === aliceId)).toHaveLength(4);
    expect(drawers.filter((id) => id !== aliceId)).toHaveLength(4);
  });

  it('keeps uneven crews fair while honoring the configured room capacity', () => {
    const charlieId = room.join('33333333-3333-4333-8333-333333333333', 'socket-c', 'Charlie').id;
    room.start('11111111-1111-4111-8111-111111111111');
    const counts = new Map<string, number>();
    for (let round = 0; round < 8; round += 1) {
      room.beginRound(); counts.set(room.drawerId!, (counts.get(room.drawerId!) ?? 0) + 1); room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    }

    expect(room.phase).toBe('afterparty');
    expect([...counts.keys()].sort()).toEqual([aliceId, charlieId, ...[...counts.keys()].filter((id) => id !== aliceId && id !== charlieId)].sort());
    expect([...counts.values()].sort()).toEqual([2, 3, 3]);
  });

  it('rebalances unfinished turns after a player permanently leaves', () => {
    room = new GameRoom('Six Drawing Show', 'chaos', false, 6, GAME.roundMs, () => now, () => 0);
    room.join('11111111-1111-4111-8111-111111111111', 'socket-a', 'Alice');
    room.join('22222222-2222-4222-8222-222222222222', 'socket-b', 'Bob');
    room.join('33333333-3333-4333-8333-333333333333', 'socket-c', 'Charlie');
    room.start('11111111-1111-4111-8111-111111111111');
    room.beginRound();
    const leaver = room.view().players.find((player) => player.id !== room.drawerId)!;
    room.leaveBySession(leaver.sessionId);
    room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    for (let round = 1; round < 6; round += 1) {
      room.beginRound(); room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    }

    expect(room.phase).toBe('afterparty');
    expect(room.rounds).toHaveLength(6);
  });

  it('publishes lobby readiness and clears it when the match starts', () => {
    const bobSession = '22222222-2222-4222-8222-222222222222';
    room.setReady(bobSession, true);
    expect(room.view().players.find((player) => player.sessionId === bobSession)?.ready).toBe(true);

    room.start('11111111-1111-4111-8111-111111111111');
    expect(room.view().players.every((player) => !player.ready)).toBe(true);
    expect(() => room.setReady(bobSession, true)).toThrow('only available in the lobby');
  });

  it('allows only the host to remove and room-ban another player', () => {
    const bobSession = '22222222-2222-4222-8222-222222222222';
    const bob = room.view().players.find((player) => player.sessionId === bobSession)!;
    expect(() => room.kick(bobSession, aliceId)).toThrow('Only the host');
    expect(() => room.kick('11111111-1111-4111-8111-111111111111', aliceId)).toThrow('cannot remove themselves');

    const removed = room.kick('11111111-1111-4111-8111-111111111111', bob.id);
    expect(removed).toMatchObject({ sessionId: bobSession, name: 'Bob' });
    expect(room.players.size).toBe(1);
    expect(() => room.join(bobSession, 'socket-b2', 'Bob')).toThrow('host removed you');
  });

  it('resolves report subjects from authoritative room identity without allowing self-reports', () => {
    const aliceSession = '11111111-1111-4111-8111-111111111111'; const bobSession = '22222222-2222-4222-8222-222222222222';
    const bob = room.view().players.find((player) => player.sessionId === bobSession)!;
    expect(room.reportTarget(aliceSession, bob.id)).toMatchObject({ reporterName: 'Alice', targetName: 'Bob', targetSessionId: bobSession });
    expect(() => room.reportTarget(aliceSession, aliceId)).toThrow('cannot report yourself');
    expect(() => room.reportTarget(aliceSession, 'missing-player')).toThrow('no longer in this arena');
  });

  it('rebalances the fixed match after a host removes a player mid-game', () => {
    room = new GameRoom('Six Drawing Show', 'chaos', false, 6, GAME.roundMs, () => now, () => 0);
    room.join('11111111-1111-4111-8111-111111111111', 'socket-a', 'Alice');
    room.join('22222222-2222-4222-8222-222222222222', 'socket-b', 'Bob');
    room.join('33333333-3333-4333-8333-333333333333', 'socket-c', 'Charlie');
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound();
    const target = room.view().players.find((player) => player.id !== room.hostId && player.id !== room.drawerId)
      ?? room.view().players.find((player) => player.id !== room.hostId)!;
    room.kick('11111111-1111-4111-8111-111111111111', target.id);
    if (room.phase === 'drawing') room.finishRound('time');
    vi.advanceTimersByTime(GAME.revealMs);
    while (room.phase !== 'afterparty') {
      room.beginRound(); room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    }
    expect(room.rounds).toHaveLength(6);
  });

  it('ignores a late disconnect from a socket that has already been replaced', () => {
    const session = '11111111-1111-4111-8111-111111111111';
    room.join(session, 'socket-a2', 'Alice');

    expect(room.ownsSocket(session, 'socket-a2')).toBe(true);
    room.disconnect(session, 'socket-a');

    expect(room.ownsSocket(session, 'socket-a2')).toBe(true);
    expect(room.view().players.find((player) => player.sessionId === session)?.connected).toBe(true);
  });

  it('pauses an active round for a required reconnect and resumes its remaining clock', () => {
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound();
    const drawerSession = room.drawerId === aliceId ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const drawerSocket = drawerSession.startsWith('1111') ? 'socket-a' : 'socket-b';
    now += 7_000;

    room.disconnect(drawerSession, drawerSocket);
    expect(room.phase).toBe('paused');
    room.join(drawerSession, `${drawerSocket}-resumed`, drawerSession.startsWith('1111') ? 'Alice' : 'Bob');

    expect(room.phase).toBe('drawing');
    expect(room.deadline! - now).toBe(GAME.roundMs - 7_000);
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

  it('locks the artist out of chat while the secret prompt is active', () => {
    room.start('11111111-1111-4111-8111-111111111111'); room.beginRound();
    const drawerSession = room.drawerId === aliceId ? '11111111-1111-4111-8111-111111111111' : '22222222-2222-4222-8222-222222222222';
    const guesserSession = drawerSession.startsWith('1111') ? '22222222-2222-4222-8222-222222222222' : '11111111-1111-4111-8111-111111111111';

    expect(() => room.sendChat(drawerSession, room.currentPrompt)).toThrow('Chat is locked');
    expect(() => room.sendChat(guesserSession, 'this is safe')).not.toThrow();
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
    for (let round = 0; round < 8; round += 1) {
      room.beginRound(); room.finishRound('time'); vi.advanceTimersByTime(GAME.revealMs);
    }
    expect(room.phase).toBe('afterparty');

    expect(() => room.rematch('22222222-2222-4222-8222-222222222222')).toThrow('Only the host');
    room.rematch('11111111-1111-4111-8111-111111111111');
    expect(room.phase).toBe('lobby');
    expect(room.rounds).toHaveLength(0);
    expect(room.view().players.every((player) => player.score === 0)).toBe(true);
  });
});
