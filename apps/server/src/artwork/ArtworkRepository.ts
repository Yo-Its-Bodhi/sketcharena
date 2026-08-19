import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ArtworkDocument, ArtworkOrigin, ArtworkStatus, CanvasRatio, PanicArchiveItem, Stroke } from '@sketch-arena/protocol';

export function toPanicArchiveItem(record: ArtworkDocument): PanicArchiveItem {
  if (record.mint?.status !== 'confirmed' || !record.mint.tokenId || !record.mint.contractAddress || !record.mint.transactionHash || !record.mint.tokenURI) throw new Error('Artwork is not a confirmed Panic Archive mint');
  return { id: record.id, title: record.title, description: record.description, origin: record.origin, canvasRatio: record.canvasRatio, width: record.width, height: record.height, strokes: record.strokes, previewUrl: record.previewUrl, createdAt: record.createdAt, mintedAt: record.updatedAt, seasonId: 0, seasonName: 'The First Mess', tokenId: record.mint.tokenId, contractAddress: record.mint.contractAddress, transactionHash: record.mint.transactionHash, tokenURI: record.mint.tokenURI, marketplaceUrl: record.mint.marketplaceUrl };
}

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
  previewUrl?: string;
  sourceRoundId?: string;
}

export interface ArtworkRepository {
  save(input: SaveArtworkInput): Promise<ArtworkDocument>;
  get(id: string): Promise<ArtworkDocument | null>;
  listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]>;
  listMinted(limit?: number, contractAddress?: string): Promise<ArtworkDocument[]>;
  deleteOwned(id: string, ownerSessionId: string): Promise<boolean>;
  updateMint(id: string, ownerSessionId: string, mint: NonNullable<ArtworkDocument['mint']>, status: ArtworkDocument['status']): Promise<ArtworkDocument>;
}

// Development adapter. Production will implement this interface with Postgres
// metadata plus object storage for rendered previews/replay payloads.
export class MemoryArtworkRepository implements ArtworkRepository {
  private readonly records = new Map<string, ArtworkDocument>();

  async save(input: SaveArtworkInput): Promise<ArtworkDocument> {
    const now = Date.now();
    const replay = !input.id && input.sourceRoundId
      ? [...this.records.values()].find((record) => record.ownerSessionId === input.ownerSessionId && record.origin === input.origin && record.sourceRoundId === input.sourceRoundId)
      : undefined;
    if (replay) return replay;
    const previous = input.id ? this.records.get(input.id) : undefined;
    if (previous && previous.ownerSessionId !== input.ownerSessionId) throw new Error('Artwork owner mismatch');
    if (previous && isConfirmedMint(previous)) return previous;
    const document: ArtworkDocument = {
      id: previous?.id ?? input.id ?? randomUUID(), ownerSessionId: input.ownerSessionId, origin: input.origin,
      status: input.status ?? previous?.status ?? 'draft', title: input.title.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500), canvasRatio: input.canvasRatio,
      width: input.width, height: input.height, strokes: input.strokes, previewUrl: input.previewUrl ?? previous?.previewUrl, sourceRoundId: input.sourceRoundId,
      createdAt: previous?.createdAt ?? now, updatedAt: now, mint: previous?.mint,
    };
    this.records.set(document.id, document);
    return document;
  }

  async get(id: string): Promise<ArtworkDocument | null> { return this.records.get(id) ?? null; }
  async listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]> {
    return [...this.records.values()].filter((record) => record.ownerSessionId === ownerSessionId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async listMinted(limit = 100, contractAddress?: string): Promise<ArtworkDocument[]> {
    const activeContract = contractAddress?.toLowerCase();
    return [...this.records.values()].filter((record) => isConfirmedMint(record) && record.mint?.contractAddress && (!activeContract || record.mint.contractAddress.toLowerCase() === activeContract)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(500, limit)));
  }
  async deleteOwned(id: string, ownerSessionId: string): Promise<boolean> {
    const record = this.records.get(id); if (!record || record.ownerSessionId !== ownerSessionId) return false;
    return this.records.delete(id);
  }
  async updateMint(id: string, ownerSessionId: string, mint: NonNullable<ArtworkDocument['mint']>, status: ArtworkDocument['status']): Promise<ArtworkDocument> {
    const record = this.records.get(id); if (!record) throw new Error('Artwork not found'); if (record.ownerSessionId !== ownerSessionId) throw new Error('Artwork owner mismatch');
    const updated = { ...record, mint: { ...record.mint, ...mint }, status, updatedAt: Date.now() }; this.records.set(id, updated); return updated;
  }
}

export class FileArtworkRepository implements ArtworkRepository {
  private readonly file: string;
  private records: Map<string, ArtworkDocument> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(file = resolve(process.cwd(), '.data', 'artworks.json')) { this.file = resolve(file); }

  async save(input: SaveArtworkInput): Promise<ArtworkDocument> {
    const records = await this.load(); const now = Date.now();
    const replay = !input.id && input.sourceRoundId
      ? [...records.values()].find((record) => record.ownerSessionId === input.ownerSessionId && record.origin === input.origin && record.sourceRoundId === input.sourceRoundId)
      : undefined;
    if (replay) return replay;
    const previous = input.id ? records.get(input.id) : undefined;
    if (previous && previous.ownerSessionId !== input.ownerSessionId) throw new Error('Artwork owner mismatch');
    if (previous && isConfirmedMint(previous)) return previous;
    const document: ArtworkDocument = {
      id: previous?.id ?? input.id ?? randomUUID(), ownerSessionId: input.ownerSessionId, origin: input.origin,
      status: input.status ?? previous?.status ?? 'draft', title: input.title.trim().slice(0, 80),
      description: (input.description ?? '').trim().slice(0, 500), canvasRatio: input.canvasRatio,
      width: input.width, height: input.height, strokes: input.strokes, previewUrl: input.previewUrl ?? previous?.previewUrl, sourceRoundId: input.sourceRoundId,
      createdAt: previous?.createdAt ?? now, updatedAt: now, mint: previous?.mint,
    };
    records.set(document.id, document); await this.persist(records); return document;
  }
  async get(id: string): Promise<ArtworkDocument | null> { return (await this.load()).get(id) ?? null; }
  async listByOwner(ownerSessionId: string): Promise<ArtworkDocument[]> {
    return [...(await this.load()).values()].filter((record) => record.ownerSessionId === ownerSessionId).sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async listMinted(limit = 100, contractAddress?: string): Promise<ArtworkDocument[]> {
    const activeContract = contractAddress?.toLowerCase();
    return [...(await this.load()).values()].filter((record) => isConfirmedMint(record) && record.mint?.contractAddress && (!activeContract || record.mint.contractAddress.toLowerCase() === activeContract)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(500, limit)));
  }
  async deleteOwned(id: string, ownerSessionId: string): Promise<boolean> {
    const records = await this.load(); const record = records.get(id); if (!record || record.ownerSessionId !== ownerSessionId) return false;
    records.delete(id); await this.persist(records); return true;
  }
  async updateMint(id: string, ownerSessionId: string, mint: NonNullable<ArtworkDocument['mint']>, status: ArtworkDocument['status']): Promise<ArtworkDocument> {
    const records = await this.load(); const record = records.get(id); if (!record) throw new Error('Artwork not found'); if (record.ownerSessionId !== ownerSessionId) throw new Error('Artwork owner mismatch');
    const updated = { ...record, mint: { ...record.mint, ...mint }, status, updatedAt: Date.now() }; records.set(id, updated); await this.persist(records); return updated;
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

function isConfirmedMint(record: ArtworkDocument): boolean { return record.mint?.status === 'confirmed' && Boolean(record.mint.tokenId && record.mint.contractAddress && record.mint.transactionHash && record.mint.tokenURI); }
