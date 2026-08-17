import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileReportRepository, MemoryReportRepository } from './ReportRepository.js';

const input = { roomId: 'room-1', roomName: 'Friday Chaos', reporterSessionId: '11111111-1111-4111-8111-111111111111', reporterName: 'Alice', targetSessionId: '22222222-2222-4222-8222-222222222222', targetPlayerId: 'player-b', targetName: 'Bob', category: 'harassment' as const, detail: 'Repeated targeted abuse in the room chat.' };

describe('ReportRepository', () => {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  it('deduplicates rapid reports and records named review decisions', async () => {
    const repository = new MemoryReportRepository(); const report = await repository.create(input, 1_000);
    expect(report).toMatchObject({ status: 'open', reporterName: 'Alice', targetName: 'Bob' });
    await expect(repository.create(input, 2_000)).rejects.toThrow('already sent');
    const reviewing = await repository.update(report.id, 'reviewing', 'backstage:mod-jules', 'Checking room context.', 3_000);
    expect(reviewing).toMatchObject({ status: 'reviewing', handledBy: 'backstage:mod-jules' });
    expect(await repository.counts()).toEqual({ open: 0, reviewing: 1, resolved: 0, dismissed: 0 });
  });

  it('persists reports without losing staff-only evidence', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sketch-reports-')); temporary.push(directory); const file = join(directory, 'reports.json');
    const first = new FileReportRepository(file); const created = await first.create(input, 1_000);
    const second = new FileReportRepository(file); expect(await second.list()).toEqual([created]);
    await expect(second.update('00000000-0000-4000-8000-000000000000', 'resolved', 'backstage:mod', 'No match.', 2_000)).rejects.toThrow('not found');
  });
});
