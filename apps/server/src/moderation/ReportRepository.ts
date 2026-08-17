import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ModerationReport, ModerationReportCategory, ModerationReportStatus } from '@sketch-arena/protocol';

export interface CreateReportInput {
  roomId: string; roomName: string; reporterSessionId: string; reporterName: string;
  targetSessionId: string; targetPlayerId: string; targetName: string;
  category: ModerationReportCategory; detail: string;
}
interface ReportState { reports: ModerationReport[]; }

export interface ReportRepository {
  create(input: CreateReportInput, now: number): Promise<ModerationReport>;
  list(status?: ModerationReportStatus, limit?: number): Promise<ModerationReport[]>;
  update(id: string, status: ModerationReportStatus, handledBy: string, resolutionNote: string, now: number): Promise<ModerationReport>;
  counts(): Promise<Record<ModerationReportStatus, number>>;
}

const cleanState = (value?: Partial<ReportState>): ReportState => ({ reports: value?.reports ?? [] });

function createInState(state: ReportState, input: CreateReportInput, now: number): ModerationReport {
  const duplicate = state.reports.find((report) => report.reporterSessionId === input.reporterSessionId && report.targetSessionId === input.targetSessionId
    && report.roomId === input.roomId && report.category === input.category && now - report.createdAt < 600_000);
  if (duplicate) throw new Error('You already sent this report for staff review');
  const report: ModerationReport = { id: randomUUID(), ...input, detail: input.detail.trim().slice(0, 500), status: 'open', createdAt: now, updatedAt: now };
  state.reports.unshift(report); state.reports = state.reports.slice(0, 10_000); return report;
}

function updateInState(state: ReportState, id: string, status: ModerationReportStatus, handledBy: string, resolutionNote: string, now: number): ModerationReport {
  const report = state.reports.find((candidate) => candidate.id === id); if (!report) throw new Error('Report not found');
  report.status = status; report.updatedAt = now; report.handledBy = handledBy; report.resolutionNote = resolutionNote.trim().slice(0, 500); return report;
}

abstract class StatefulReportRepository implements ReportRepository {
  protected abstract readState(): Promise<ReportState>;
  protected abstract commit(state: ReportState): Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result; }
  create(input: CreateReportInput, now: number): Promise<ModerationReport> { return this.serial(async () => { const state = await this.readState(); const report = createInState(state, input, now); await this.commit(state); return structuredClone(report); }); }
  async list(status?: ModerationReportStatus, limit = 100): Promise<ModerationReport[]> { const reports = (await this.readState()).reports.filter((report) => !status || report.status === status).slice(0, Math.max(1, Math.min(500, limit))); return structuredClone(reports); }
  update(id: string, status: ModerationReportStatus, handledBy: string, resolutionNote: string, now: number): Promise<ModerationReport> { return this.serial(async () => { const state = await this.readState(); const report = updateInState(state, id, status, handledBy, resolutionNote, now); await this.commit(state); return structuredClone(report); }); }
  async counts(): Promise<Record<ModerationReportStatus, number>> { const reports = (await this.readState()).reports; return { open: reports.filter((report) => report.status === 'open').length, reviewing: reports.filter((report) => report.status === 'reviewing').length, resolved: reports.filter((report) => report.status === 'resolved').length, dismissed: reports.filter((report) => report.status === 'dismissed').length }; }
}

export class MemoryReportRepository extends StatefulReportRepository {
  private readonly state = cleanState();
  protected async readState(): Promise<ReportState> { return this.state; }
  protected async commit(): Promise<void> {}
}

export class FileReportRepository extends StatefulReportRepository {
  private state: ReportState | null = null; private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), '.data', 'moderation-reports.json')) { super(); }
  protected async readState(): Promise<ReportState> { if (this.state) return this.state; try { this.state = cleanState(JSON.parse(await readFile(this.file, 'utf8')) as ReportState); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = cleanState(); } return this.state; }
  protected async commit(state: ReportState): Promise<void> { this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.file); }); return this.writeQueue; }
}
