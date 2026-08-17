import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { ModerationReport, ModerationReportCategory, ModerationReportStatus } from '@sketch-arena/protocol';
import type { CreateReportInput, ReportRepository } from './ReportRepository.js';

export class PostgresReportRepository implements ReportRepository {
  constructor(private readonly pool: Pool) {}
  create(input: CreateReportInput, now: number): Promise<ModerationReport> { return transaction(this.pool, async (client) => {
    const lock = `report:${input.reporterSessionId}:${input.targetSessionId}:${input.roomId}:${input.category}`; await client.query('select pg_advisory_xact_lock(hashtext($1))', [lock]);
    const duplicate = await client.query('select id from moderation_reports where reporter_session_id=$1 and target_session_id=$2 and room_id=$3 and category=$4 and created_at>$5 limit 1', [input.reporterSessionId, input.targetSessionId, input.roomId, input.category, new Date(now - 600_000)]);
    if (duplicate.rows[0]) throw new Error('You already sent this report for staff review');
    const value: ModerationReport = { id: randomUUID(), ...input, detail: input.detail.trim().slice(0, 500), status: 'open', createdAt: now, updatedAt: now };
    const result = await client.query(`insert into moderation_reports(id,room_id,room_name,reporter_session_id,reporter_name,target_session_id,target_player_id,target_name,category,detail,status,created_at,updated_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`, values(value)); return report(result.rows[0]);
  }); }
  async list(status?: ModerationReportStatus, limit = 100): Promise<ModerationReport[]> { const bounded = Math.max(1, Math.min(500, limit)); const result = status ? await this.pool.query('select * from moderation_reports where status=$1 order by created_at desc limit $2', [status, bounded]) : await this.pool.query('select * from moderation_reports order by created_at desc limit $1', [bounded]); return result.rows.map(report); }
  async update(id: string, status: ModerationReportStatus, handledBy: string, resolutionNote: string, now: number): Promise<ModerationReport> { const result = await this.pool.query('update moderation_reports set status=$2,handled_by=$3,resolution_note=$4,updated_at=$5 where id=$1 returning *', [id, status, handledBy, resolutionNote.trim().slice(0, 500), new Date(now)]); if (!result.rows[0]) throw new Error('Report not found'); return report(result.rows[0]); }
  async counts(): Promise<Record<ModerationReportStatus, number>> { const result = await this.pool.query('select status,count(*)::int count from moderation_reports group by status'); const count = (status: ModerationReportStatus) => Number(result.rows.find((row) => row.status === status)?.count ?? 0); return { open: count('open'), reviewing: count('reviewing'), resolved: count('resolved'), dismissed: count('dismissed') }; }
}

function values(value: ModerationReport): unknown[] { return [value.id, value.roomId, value.roomName, value.reporterSessionId, value.reporterName, value.targetSessionId, value.targetPlayerId, value.targetName, value.category, value.detail, value.status, new Date(value.createdAt), new Date(value.updatedAt)]; }
function time(value: unknown): number { return new Date(value as string | number | Date).getTime(); }
function report(row: Record<string, unknown>): ModerationReport { return { id: String(row.id), roomId: String(row.room_id), roomName: String(row.room_name), reporterSessionId: String(row.reporter_session_id), reporterName: String(row.reporter_name), targetSessionId: String(row.target_session_id), targetPlayerId: String(row.target_player_id), targetName: String(row.target_name), category: row.category as ModerationReportCategory, detail: String(row.detail), status: row.status as ModerationReportStatus, handledBy: row.handled_by ? String(row.handled_by) : undefined, resolutionNote: row.resolution_note ? String(row.resolution_note) : undefined, createdAt: time(row.created_at), updatedAt: time(row.updated_at) }; }
async function transaction<T>(pool: Pool, operation: (client: PoolClient) => Promise<T>): Promise<T> { const client = await pool.connect(); try { await client.query('begin'); const result = await operation(client); await client.query('commit'); return result; } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); } }
