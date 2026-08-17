import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import type { ArtworkDocument, ArtworkOrigin, ArtworkStatus, CanvasRatio, Stroke } from '@sketch-arena/protocol';
import type { ArtworkRepository, SaveArtworkInput } from './ArtworkRepository.js';

export class PostgresArtworkRepository implements ArtworkRepository {
  constructor(private readonly pool: Pool) {}

  async save(input: SaveArtworkInput): Promise<ArtworkDocument> {
    const now = Date.now();
    if (input.id) {
      const existing = await this.get(input.id);
      if (existing && existing.ownerSessionId !== input.ownerSessionId) throw new Error('Artwork owner mismatch');
      const document = createDocument(input, now, existing ?? undefined);
      const result = await this.pool.query(`insert into artworks(id,owner_session_id,origin,status,title,description,canvas_ratio,width,height,strokes,preview_url,source_round_id,mint,created_at,updated_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15)
        on conflict(id) do update set origin=excluded.origin,status=excluded.status,title=excluded.title,description=excluded.description,canvas_ratio=excluded.canvas_ratio,width=excluded.width,height=excluded.height,strokes=excluded.strokes,preview_url=excluded.preview_url,source_round_id=excluded.source_round_id,updated_at=excluded.updated_at
        where artworks.owner_session_id=excluded.owner_session_id returning *`, values(document));
      if (!result.rows[0]) throw new Error('Artwork owner mismatch');
      return fromRow(result.rows[0]);
    }

    const document = createDocument(input, now);
    const result = await this.pool.query(`insert into artworks(id,owner_session_id,origin,status,title,description,canvas_ratio,width,height,strokes,preview_url,source_round_id,mint,created_at,updated_at)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::jsonb,$14,$15)
      on conflict(owner_session_id,origin,source_round_id) where source_round_id is not null do nothing returning *`, values(document));
    if (result.rows[0]) return fromRow(result.rows[0]);
    const replay = await this.pool.query('select * from artworks where owner_session_id=$1 and origin=$2 and source_round_id=$3', [input.ownerSessionId, input.origin, input.sourceRoundId]);
    if (!replay.rows[0]) throw new Error('Artwork save conflict');
    return fromRow(replay.rows[0]);
  }

  async get(id: string): Promise<ArtworkDocument | null> { const result = await this.pool.query('select * from artworks where id=$1', [id]); return result.rows[0] ? fromRow(result.rows[0]) : null; }
  async listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]> { const result = await this.pool.query('select * from artworks where owner_session_id=$1 order by updated_at desc', [ownerSessionId]); return result.rows.map(fromRow); }
  async listMinted(limit = 100): Promise<ArtworkDocument[]> {
    const result = await this.pool.query(`select * from artworks where status='minted' and mint->>'status'='confirmed' and coalesce(mint->>'tokenId','')<>'' and coalesce(mint->>'contractAddress','')<>'' and coalesce(mint->>'transactionHash','')<>'' and coalesce(mint->>'tokenURI','')<>'' order by updated_at desc limit $1`, [Math.max(1, Math.min(500, limit))]);
    return result.rows.map(fromRow);
  }
  async updateMint(id: string, ownerSessionId: string, mint: NonNullable<ArtworkDocument['mint']>, status: ArtworkStatus): Promise<ArtworkDocument> {
    const result = await this.pool.query('update artworks set mint=coalesce(mint,\'{}\'::jsonb) || $3::jsonb,status=$4,updated_at=$5 where id=$1 and owner_session_id=$2 returning *', [id, ownerSessionId, JSON.stringify(mint), status, new Date()]);
    if (result.rows[0]) return fromRow(result.rows[0]);
    const exists = await this.pool.query('select owner_session_id from artworks where id=$1', [id]);
    if (!exists.rows[0]) throw new Error('Artwork not found');
    throw new Error('Artwork owner mismatch');
  }
}

function createDocument(input: SaveArtworkInput, now: number, previous?: ArtworkDocument): ArtworkDocument {
  return { id: previous?.id ?? input.id ?? randomUUID(), ownerSessionId: input.ownerSessionId, origin: input.origin, status: input.status ?? previous?.status ?? 'draft', title: input.title.trim().slice(0, 80), description: (input.description ?? '').trim().slice(0, 500), canvasRatio: input.canvasRatio, width: input.width, height: input.height, strokes: input.strokes, previewUrl: previous?.previewUrl, sourceRoundId: input.sourceRoundId, createdAt: previous?.createdAt ?? now, updatedAt: now, mint: previous?.mint };
}
function values(document: ArtworkDocument): unknown[] { return [document.id, document.ownerSessionId, document.origin, document.status, document.title, document.description, document.canvasRatio, document.width, document.height, JSON.stringify(document.strokes), document.previewUrl ?? null, document.sourceRoundId ?? null, document.mint ? JSON.stringify(document.mint) : null, new Date(document.createdAt), new Date(document.updatedAt)]; }
function time(value: unknown): number { return new Date(value as string | number | Date).getTime(); }
function fromRow(row: Record<string, unknown>): ArtworkDocument { return { id: String(row.id), ownerSessionId: String(row.owner_session_id), origin: row.origin as ArtworkOrigin, status: row.status as ArtworkStatus, title: String(row.title), description: String(row.description), canvasRatio: row.canvas_ratio as CanvasRatio, width: Number(row.width), height: Number(row.height), strokes: row.strokes as Stroke[], previewUrl: row.preview_url ? String(row.preview_url) : undefined, sourceRoundId: row.source_round_id ? String(row.source_round_id) : undefined, createdAt: time(row.created_at), updatedAt: time(row.updated_at), mint: row.mint ? row.mint as ArtworkDocument['mint'] : undefined };
}
