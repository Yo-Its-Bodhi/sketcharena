import { describe, expect, it } from 'vitest';
import { SlidingLimit } from './rateLimit.js';

describe('SlidingLimit', () => {
  it('rejects events over budget and reopens after the rolling window', () => {
    const limit = new SlidingLimit(3, 1_000);
    expect(limit.take('socket-a', 1_000)).toBe(true);
    expect(limit.take('socket-a', 1_200)).toBe(true);
    expect(limit.take('socket-a', 1_400)).toBe(true);
    expect(limit.take('socket-a', 1_500)).toBe(false);
    expect(limit.take('socket-a', 2_001)).toBe(true);
  });

  it('isolates clients and removes disconnected client history', () => {
    const limit = new SlidingLimit(1, 1_000);
    expect(limit.take('socket-a', 5_000)).toBe(true);
    expect(limit.take('socket-b', 5_000)).toBe(true);
    expect(limit.take('socket-a', 5_001)).toBe(false);
    limit.forget('socket-a');
    expect(limit.take('socket-a', 5_002)).toBe(true);
  });
});
