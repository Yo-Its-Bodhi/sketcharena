import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { ProgressionRepository } from '../progression/ProgressionRepository.js';

export type PromotionKind = 'free-mint' | 'mint-discount';
export type PromotionStatus = 'active' | 'paused' | 'ended';
export interface PromotionRedemption { sessionId: string; at: number; }
export interface PromotionCampaign {
  id: string; name: string; codeHash: string; codeHint: string; kind: PromotionKind; usesPerPlayer: number; discountBps?: number; reason: string;
  maxRedemptions: number; startsAt: number; expiresAt: number; status: PromotionStatus; redemptions: PromotionRedemption[]; createdBy: string; createdAt: number; updatedAt: number;
}
export type PromotionCampaignView = Omit<PromotionCampaign, 'codeHash'>;
export interface PromotionAuditEntry { id: string; action: 'promotion.create' | 'promotion.pause' | 'promotion.resume' | 'promotion.redeem'; actor: string; campaignId: string; at: number; detail: string; }
interface PromotionState { campaigns: PromotionCampaign[]; audit: PromotionAuditEntry[]; }

export interface CreatePromotionInput { name: string; kind: PromotionKind; usesPerPlayer: number; discountBps?: number; reason: string; maxRedemptions: number; startsAt?: number; expiresAt: number; customCode?: string; }
export interface PromotionRepository {
  create(input: CreatePromotionInput, actor: string, now: number): Promise<{ campaign: PromotionCampaignView; code: string }>;
  list(now: number): Promise<PromotionCampaignView[]>;
  findByCode(code: string): Promise<PromotionCampaign | null>;
  recordRedemption(campaignId: string, sessionId: string, now: number): Promise<PromotionCampaignView>;
  setPaused(campaignId: string, paused: boolean, actor: string, now: number): Promise<PromotionCampaignView>;
  audit(limit?: number): Promise<PromotionAuditEntry[]>;
}

function cleanState(value?: Partial<PromotionState>): PromotionState { return { campaigns: value?.campaigns ?? [], audit: value?.audit ?? [] }; }
export function normalizeCode(code: string): string { return code.trim().toUpperCase().replace(/\s+/g, '-'); }
export function codeHash(code: string): string { return createHash('sha256').update(normalizeCode(code)).digest('hex'); }
export function generatedCode(): string { const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; const bytes = randomBytes(12); const body = [...bytes].map((byte) => alphabet[byte % alphabet.length]).join(''); return `PANIC-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8)}`; }
export function publicCampaign(campaign: PromotionCampaign, now: number): PromotionCampaignView {
  const view: Partial<PromotionCampaign> = structuredClone(campaign); delete view.codeHash;
  const ended = campaign.expiresAt <= now || campaign.redemptions.length >= campaign.maxRedemptions; return { ...(view as PromotionCampaignView), status: ended ? 'ended' : campaign.status };
}

abstract class StatefulPromotionRepository implements PromotionRepository {
  protected abstract readState(): Promise<PromotionState>;
  protected abstract commit(state: PromotionState): Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> { const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result; }
  create(input: CreatePromotionInput, actor: string, now: number): Promise<{ campaign: PromotionCampaignView; code: string }> { return this.serial(async () => {
    const state = await this.readState(); const code = normalizeCode(input.customCode || generatedCode()); const hash = codeHash(code);
    if (state.campaigns.some((campaign) => timingSafeEqual(Buffer.from(campaign.codeHash, 'hex'), Buffer.from(hash, 'hex')))) throw new Error('Promotion code already exists');
    const campaign: PromotionCampaign = { id: randomUUID(), name: input.name, codeHash: hash, codeHint: `${code.slice(0, 6)}…${code.slice(-4)}`, kind: input.kind, usesPerPlayer: input.usesPerPlayer,
      discountBps: input.kind === 'mint-discount' ? input.discountBps : undefined, reason: input.reason, maxRedemptions: input.maxRedemptions, startsAt: input.startsAt ?? now, expiresAt: input.expiresAt,
      status: 'active', redemptions: [], createdBy: actor, createdAt: now, updatedAt: now };
    state.campaigns.unshift(campaign); state.audit.unshift({ id: randomUUID(), action: 'promotion.create', actor, campaignId: campaign.id, at: now, detail: `${campaign.kind} · cap ${campaign.maxRedemptions}` }); await this.commit(state);
    return { campaign: publicCampaign(campaign, now), code };
  }); }
  async list(now: number): Promise<PromotionCampaignView[]> { return (await this.readState()).campaigns.map((campaign) => publicCampaign(campaign, now)); }
  async findByCode(code: string): Promise<PromotionCampaign | null> {
    const hash = Buffer.from(codeHash(code), 'hex'); const campaign = (await this.readState()).campaigns.find((candidate) => timingSafeEqual(hash, Buffer.from(candidate.codeHash, 'hex'))); return campaign ? structuredClone(campaign) : null;
  }
  recordRedemption(campaignId: string, sessionId: string, now: number): Promise<PromotionCampaignView> { return this.serial(async () => {
    const state = await this.readState(); const campaign = state.campaigns.find((candidate) => candidate.id === campaignId); if (!campaign) throw new Error('Promotion not found');
    if (campaign.redemptions.some((redemption) => redemption.sessionId === sessionId)) return publicCampaign(campaign, now);
    if (campaign.status !== 'active' || campaign.startsAt > now || campaign.expiresAt <= now || campaign.redemptions.length >= campaign.maxRedemptions) throw new Error('Promotion is unavailable');
    campaign.redemptions.push({ sessionId, at: now }); campaign.updatedAt = now; state.audit.unshift({ id: randomUUID(), action: 'promotion.redeem', actor: `player:${sessionId}`, campaignId, at: now, detail: campaign.kind }); await this.commit(state); return publicCampaign(campaign, now);
  }); }
  setPaused(campaignId: string, paused: boolean, actor: string, now: number): Promise<PromotionCampaignView> { return this.serial(async () => {
    const state = await this.readState(); const campaign = state.campaigns.find((candidate) => candidate.id === campaignId); if (!campaign) throw new Error('Promotion not found');
    campaign.status = paused ? 'paused' : 'active'; campaign.updatedAt = now; state.audit.unshift({ id: randomUUID(), action: paused ? 'promotion.pause' : 'promotion.resume', actor, campaignId, at: now, detail: campaign.name }); await this.commit(state); return publicCampaign(campaign, now);
  }); }
  async audit(limit = 100): Promise<PromotionAuditEntry[]> { return structuredClone((await this.readState()).audit.slice(0, limit)); }
}

export class MemoryPromotionRepository extends StatefulPromotionRepository { private readonly state = cleanState(); protected async readState(): Promise<PromotionState> { return this.state; } protected async commit(): Promise<void> {} }
export class FilePromotionRepository extends StatefulPromotionRepository {
  private state: PromotionState | null = null; private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), '.data', 'promotions.json')) { super(); }
  protected async readState(): Promise<PromotionState> { if (this.state) return this.state; try { this.state = cleanState(JSON.parse(await readFile(this.file, 'utf8')) as PromotionState); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = cleanState(); } return this.state; }
  protected async commit(state: PromotionState): Promise<void> { this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.file); }); return this.writeQueue; }
}

export class PromotionService {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly repository: PromotionRepository, private readonly progression: ProgressionRepository, private readonly clock: () => number = Date.now) {}
  create(input: CreatePromotionInput, actor: string) { return this.repository.create(input, actor, this.clock()); }
  list() { return this.repository.list(this.clock()); }
  audit(limit?: number) { return this.repository.audit(limit); }
  setPaused(id: string, paused: boolean, actor: string) { return this.repository.setPaused(id, paused, actor, this.clock()); }
  redeem(sessionId: string, code: string): Promise<{ campaign: PromotionCampaignView; reward: 'mint-credit' | 'mint-discount'; uses: number; discountBps?: number }> {
    const operation = async () => {
      const now = this.clock(); const campaign = await this.repository.findByCode(code); if (!campaign) throw new Error('That promo code is not valid');
      if (!await this.progression.getPlayer(sessionId)) throw new Error('Enter the Arena before redeeming a promo');
      if (campaign.redemptions.some((redemption) => redemption.sessionId === sessionId)) throw new Error('You already redeemed this promo');
      if (campaign.status !== 'active' || campaign.startsAt > now || campaign.expiresAt <= now || campaign.redemptions.length >= campaign.maxRedemptions) throw new Error('That promo has ended');
      const reward = campaign.kind === 'free-mint' ? 'mint-credit' as const : 'mint-discount' as const;
      await this.progression.grant({ sessionIds: [sessionId], kind: reward, amount: campaign.usesPerPlayer, discountBps: campaign.discountBps, reason: campaign.reason, campaignId: `promo-${campaign.id}`, idempotencyKey: `promo-${campaign.id}-${sessionId}`, actor: 'system:promotion' });
      return { campaign: await this.repository.recordRedemption(campaign.id, sessionId, now), reward, uses: campaign.usesPerPlayer, discountBps: campaign.discountBps };
    };
    const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result;
  }
}
