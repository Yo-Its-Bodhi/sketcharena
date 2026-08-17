import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresReportRepository } from './PostgresReportRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresReportRepository integration', () => {
  let pool: Pool; let repository: PostgresReportRepository;
  beforeAll(() => { pool = new Pool({ connectionString, max: 2 }); repository = new PostgresReportRepository(pool); });
  afterAll(async () => { await pool.end(); });
  it('deduplicates private reports and records named staff resolution', async () => {
    const input = { roomId: randomUUID(), roomName: 'CI room', reporterSessionId: randomUUID(), reporterName: 'Reporter', targetSessionId: randomUUID(), targetPlayerId: randomUUID(), targetName: 'Subject', category: 'spam' as const, detail: 'Repeated disruptive messages during the match.' };
    const created = await repository.create(input, 10_000); await expect(repository.create(input, 10_001)).rejects.toThrow(/already sent/);
    const resolved = await repository.update(created.id, 'resolved', 'ci:operator', 'Verified and handled.', 11_000); expect(resolved.handledBy).toBe('ci:operator'); expect((await repository.counts()).resolved).toBeGreaterThanOrEqual(1);
  });
});
