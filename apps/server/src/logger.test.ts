import { describe, expect, it } from 'vitest';
import { errorFields, formatLogRecord } from './logger.js';

describe('structured logger', () => {
  it('creates one machine-readable record without undefined fields', () => {
    const line = formatLogRecord('info', 'server.ready', { port: 4100, secret: undefined }, new Date('2026-08-16T00:00:00.000Z'));
    expect(JSON.parse(line)).toEqual({ timestamp: '2026-08-16T00:00:00.000Z', level: 'info', event: 'server.ready', port: 4100 });
    expect(line).not.toContain('\n');
  });

  it('serializes safe error identity without dumping arbitrary objects', () => {
    expect(errorFields(new TypeError('boom'))).toEqual({ errorName: 'TypeError', errorMessage: 'boom' });
    expect(errorFields({ token: 'do-not-log-me' })).toEqual({ errorMessage: 'Unknown error' });
  });
});
