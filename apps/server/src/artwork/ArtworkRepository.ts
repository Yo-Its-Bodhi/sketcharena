import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ArtworkDocument, ArtworkOrigin, ArtworkStatus, CanvasRatio, Stroke } from '@sketch-arena/protocol';

export interface SaveArtworkInput {
  id?: string;
  ownerSessionId: string;
  origin: ArtworkOrigin;
  status?: ArtworkStatus;
  title: string;
  description?: string;
  canvasRatio: CanvasRatio;
  width: number;
  height: number;
  strokes: Stroke[];
  sourceRoundId?: string;
}

export interface ArtworkRepository {
  save(input: SaveArtworkInput): Promise<ArtworkDocument>;
  get(id: string): Promise<ArtworkDocument | null>;
  listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]>;
}

// Development adapter. Production will implement this interface with Postgres
// metadata plus object storage for rendered previews/replay payloads.
export class MemoryArtworkRepository implements ArtworkRepository {
  private readonly records = new Map<string, ArtworkDocument>();

  async save(input: SaveArtworkInput): Promise<ArtworkDocument> {
    const now = Date.now();
    const previous = input.id ? this.records.get(input.id) : undefined;
    if (previous && previous.ownerSessionId !== input.ownerSessionId) throw new Error('Artwork owner mismatch');
    const document: ArtworkDocument = {
      id: previous?.id ?? randomUUID(), ownerSessionId: input.ownerSessionId, origin: input.origin,
      status: input.status ?? previous?.status ?? 'draft', title: input.title.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500), canvasRatio: input.canvasRatio,
      width: input.width, height: input.height, strokes: input.strokes, sourceRoundId: input.sourceRoundId,
      createdAt: previous?.createdAt ?? now, updatedAt: now, mint: previous?.mint,
    };
    this.records.set(document.id, document);
    return document;
  }

  async get(id: string): Promise<ArtworkDocument | null> { return this.records.get(id) ?? null; }
  async listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]> {
    return [...this.records.values()].filter((record) => record.ownerSessionId === ownerSessionId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
}

export class FileArtworkRepository implements ArtworkRepository {
  private readonly file: string;
  private records: Map<string, ArtworkDocument> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file = resolve(process.cwd(), '.data', 'artworks.json')) { this.file = resolve(file); }

  async save(input: SaveArtworkInput): Promise<ArtworkDocument> {
    const records = await this.load(); const now = Date.now();
    const previous = input.id ? records.get(input.id) : undefined;
    if (previous && previous.ownerSessionId !== input.ownerSessionId) throw new Error('Artwork owner mismatch');
    const document: ArtworkDocument = {
      id: previous?.id ?? randomUUID(), ownerSessionId: input.ownerSessionId, origin: input.origin,
      status: input.status ?? previous?.status ?? 'draft', title: input.title.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500), canvasRatio: input.canvasRatio,
      width: input.width, height: input.height, strokes: input.strokes, sourceRoundId: input.sourceRoundId,
      createdAt: previous?.createdAt ?? now, updatedAt: now, mint: previous?.mint,
    };
    records.set(document.id, document); await this.persist(records); return document;
  }
  async get(id: string): Promise<ArtworkDocument | null> { return (await this.load()).get(id) ?? null; }
  async listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]> {
    return [...(await this.load()).values()].filter((record) => record.ownerSessionId === ownerSessionId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  private async load(): Promise<Map<string, ArtworkDocument>> {
    if (this.records) return this.records;
    try { this.records = new Map((JSON.parse(await readFile(this.file, 'utf8')) as ArtworkDocument[]).map((item) => [item.id, item])); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.records = new Map();
    }
    return this.records;
  }
  private async persist(records: Map<string, ArtworkDocument>): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(temporary, JSON.stringify([...records.values()], null, 2), 'utf8');
      await rename(temporary, this.file);
    });
    return this.writeQueue;
  }
}
