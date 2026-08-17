import { describe, expect, it } from 'vitest';
import { OperationalState } from './operations.js';

describe('OperationalState', () => {
  it('moves from starting to ready to draining and never reopens during shutdown', () => {
    const state = new OperationalState(1_000);
    expect(state.snapshot(2, 3, 2_500)).toEqual({ ok: false, status: 'starting', uptimeSeconds: 1, rooms: 2, connections: 3, now: 2_500 });
    state.markReady(); expect(state.isReady()).toBe(true);
    expect(state.beginShutdown()).toBe(true); expect(state.snapshot(2, 3, 3_000)).toMatchObject({ ok: false, status: 'draining' });
    expect(state.beginShutdown()).toBe(false); state.markReady(); expect(state.isReady()).toBe(false);
  });
});
