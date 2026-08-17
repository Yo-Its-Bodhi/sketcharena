import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type RewardKind = 'mint-credit' | 'mint-discount' | 'xp' | 'item' | 'achievement' | 'battle-pass';

export interface RewardEntitlement {
  id: string;
  kind: RewardKind;
  amount: number;
  itemId?: string;
  discountBps?: number;
  reason: string;
  campaignId?: string;
  grantedAt: number;
  expiresAt?: number;
  redeemedAmount?: number;
  redeemedAt?: number;
  acknowledgedAt?: number;
}

export interface PlayerProgress {
  sessionId: string;
  name: string;
  seasonId: string;
  xp: number;
  level: number;
  battlePass: 'free' | 'premium';
  achievements: string[];
  items: string[];
  equipped: { avatar?: string; brush?: string };
  rewards: RewardEntitlement[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface RewardGrantInput {
  sessionIds: string[];
  kind: RewardKind;
  amount: number;
  itemId?: string;
  discountBps?: number;
  reason: string;
  campaignId?: string;
  expiresAt?: number;
  idempotencyKey: string;
  actor: string;
}

export interface AdminAuditEntry {
  id: string;
  action: 'reward.grant';
  actor: string;
  reason: string;
  targetCount: number;
  campaignId?: string;
  idempotencyKey: string;
  at: number;
}

interface ProgressionState { players: PlayerProgress[]; audit: AdminAuditEntry[]; appliedKeys: string[]; redemptionKeys: string[]; }

const SEASON_LEVEL_REWARDS: Array<{ level: number; kind: 'mint-credit' | 'item' | 'achievement'; amount: number; itemId?: string; reason: string }> = [
  { level: 2, kind: 'item', amount: 1, itemId: 'yellow-weirdo-avatar', reason: 'Season 0 Level 2 · Yellow Weirdo avatar' },
  { level: 3, kind: 'mint-credit', amount: 1, reason: 'Season 0 Level 3 · free Panic Archive mint' },
  { level: 5, kind: 'item', amount: 1, itemId: 'panic-pencil', reason: 'Season 0 Level 5 · Panic Pencil cosmetic' },
  { level: 10, kind: 'mint-credit', amount: 2, reason: 'Season 0 Level 10 · two free Panic Archive mints' },
  { level: 20, kind: 'achievement', amount: 1, itemId: 'first-mess-finisher', reason: 'Completed the Season 0 progression track' },
];
const PREMIUM_LEVEL_REWARDS: Array<{ level: number; kind: 'mint-credit' | 'item'; amount: number; itemId?: string; reason: string }> = [
  { level: 1, kind: 'item', amount: 1, itemId: 'green-chaos-avatar', reason: 'Premium Panic Pass · Green Chaos avatar' },
  { level: 3, kind: 'mint-credit', amount: 1, reason: 'Premium Panic Pass Level 3 · bonus free mint' },
  { level: 5, kind: 'item', amount: 1, itemId: 'neon-panic-brush', reason: 'Premium Panic Pass Level 5 · Neon Panic brush' },
  { level: 10, kind: 'mint-credit', amount: 2, reason: 'Premium Panic Pass Level 10 · two bonus free mints' },
  { level: 20, kind: 'item', amount: 1, itemId: 'golden-chaos-avatar', reason: 'Premium Panic Pass Level 20 · Golden Chaos avatar' },
];
export const SEASON_ITEMS = [
  { id: 'yellow-weirdo-avatar', name: 'Yellow Weirdo', description: 'The original suspiciously cheerful face.', slot: 'avatar', rarity: 'common', previewColor: '#ffb703' },
  { id: 'green-chaos-avatar', name: 'Green Chaos', description: 'Looks worried. Probably knows the prompt.', slot: 'avatar', rarity: 'rare', previewColor: '#27ae8a' },
  { id: 'golden-chaos-avatar', name: 'Golden Chaos', description: 'Season finisher energy with questionable talent.', slot: 'avatar', rarity: 'legendary', previewColor: '#f2c94c' },
  { id: 'panic-pencil', name: 'Panic Pencil', description: 'A hot-red drawing cursor and Studio brush accent.', slot: 'brush', rarity: 'rare', previewColor: '#e54b3e' },
  { id: 'neon-panic-brush', name: 'Neon Panic', description: 'An electric premium brush accent for the Studio.', slot: 'brush', rarity: 'epic', previewColor: '#8b5cf6' },
] as const;

export interface ProgressionRepository {
  ensurePlayer(sessionId: string, name: string): Promise<PlayerProgress>;
  getPlayer(sessionId: string): Promise<PlayerProgress | null>;
  listPlayers(search?: string): Promise<PlayerProgress[]>;
  grant(input: RewardGrantInput): Promise<{ granted: number; skipped: number }>;
  acknowledge(sessionId: string, rewardId: string): Promise<PlayerProgress>;
  consumeMintCredit(sessionId: string, rewardId: string, idempotencyKey: string, amount?: number): Promise<PlayerProgress>;
  consumeMintDiscount(sessionId: string, rewardId: string, idempotencyKey: string, amount?: number): Promise<PlayerProgress>;
  equipItem(sessionId: string, itemId: string): Promise<PlayerProgress>;
  audit(limit?: number): Promise<AdminAuditEntry[]>;
}

function cleanState(value?: Partial<ProgressionState>): ProgressionState {
  return { players: value?.players ?? [], audit: value?.audit ?? [], appliedKeys: value?.appliedKeys ?? [], redemptionKeys: value?.redemptionKeys ?? [] };
}

export function ensurePlayerInState(state: ProgressionState, sessionId: string, name: string, now: number): PlayerProgress {
  const existing = state.players.find((player) => player.sessionId === sessionId);
  if (existing) {
    existing.name = name;
    existing.lastSeenAt = now;
    existing.equipped ??= {};
    ensureFirstMintCredit(existing, now);
    return existing;
  }
  const player: PlayerProgress = {
    sessionId, name, seasonId: 'season-0', xp: 0, level: 1, battlePass: 'free', achievements: [], items: [], equipped: {}, rewards: [],
    firstSeenAt: now, lastSeenAt: now,
  };
  ensureFirstMintCredit(player, now);
  state.players.push(player); return player;
}

function ensureFirstMintCredit(player: PlayerProgress, now: number): void {
  const existing = player.rewards.find((reward) => reward.campaignId === 'first-panic-archive-mint');
  // This is an always-on welcome entitlement, not a random drop. Mark legacy
  // and new grants as seen so players can use the credit immediately without
  // receiving a misleading "loot unlocked" notification on first sign-in.
  if (existing) { existing.acknowledgedAt ??= now; return; }
  player.rewards.push({
    id: randomUUID(),
    kind: 'mint-credit',
    amount: 1,
    reason: 'Your first Panic Archive mint is on us.',
    campaignId: 'first-panic-archive-mint',
    grantedAt: now,
    acknowledgedAt: now,
  });
}

export function grantInState(state: ProgressionState, input: RewardGrantInput, now: number): { granted: number; skipped: number } {
  if (state.appliedKeys.includes(input.idempotencyKey)) return { granted: 0, skipped: input.sessionIds.length };
  let granted = 0; let skipped = 0;
  for (const sessionId of new Set(input.sessionIds)) {
    const player = state.players.find((candidate) => candidate.sessionId === sessionId);
    if (!player) { skipped += 1; continue; }
    const duplicate = player.rewards.some((reward) => reward.campaignId && reward.campaignId === input.campaignId && reward.kind === input.kind && reward.itemId === input.itemId);
    if (duplicate) { skipped += 1; continue; }
    player.rewards.push({ id: randomUUID(), kind: input.kind, amount: input.amount, itemId: input.itemId, discountBps: input.discountBps, reason: input.reason,
      campaignId: input.campaignId, grantedAt: now, expiresAt: input.expiresAt });
    if (input.kind === 'xp') { player.xp += input.amount; player.level = Math.max(1, Math.floor(player.xp / 1_000) + 1); applySeasonLevelRewards(player, now); }
    if (input.kind === 'item' && input.itemId && !player.items.includes(input.itemId)) player.items.push(input.itemId);
    if (input.kind === 'achievement' && input.itemId && !player.achievements.includes(input.itemId)) player.achievements.push(input.itemId);
    if (input.kind === 'battle-pass') { player.battlePass = 'premium'; applyPremiumLevelRewards(player, now); }
    granted += 1;
  }
  state.appliedKeys.push(input.idempotencyKey);
  state.audit.unshift({ id: randomUUID(), action: 'reward.grant', actor: input.actor, reason: input.reason, targetCount: granted,
    campaignId: input.campaignId, idempotencyKey: input.idempotencyKey, at: now });
  state.audit = state.audit.slice(0, 5_000); state.appliedKeys = state.appliedKeys.slice(-10_000);
  return { granted, skipped };
}

function applySeasonLevelRewards(player: PlayerProgress, now: number): void {
  for (const tier of SEASON_LEVEL_REWARDS) {
    const campaignId = `season-0-level-${tier.level}`;
    if (player.level < tier.level || player.rewards.some((reward) => reward.campaignId === campaignId)) continue;
    player.rewards.push({ id: randomUUID(), kind: tier.kind, amount: tier.amount, itemId: tier.itemId, reason: tier.reason, campaignId, grantedAt: now });
    if (tier.kind === 'item' && tier.itemId && !player.items.includes(tier.itemId)) player.items.push(tier.itemId);
    if (tier.kind === 'achievement' && tier.itemId && !player.achievements.includes(tier.itemId)) player.achievements.push(tier.itemId);
  }
  applyPremiumLevelRewards(player, now);
}

function applyPremiumLevelRewards(player: PlayerProgress, now: number): void {
  if (player.battlePass !== 'premium') return;
  for (const tier of PREMIUM_LEVEL_REWARDS) {
    const campaignId = `season-0-premium-level-${tier.level}`;
    if (player.level < tier.level || player.rewards.some((reward) => reward.campaignId === campaignId)) continue;
    player.rewards.push({ id: randomUUID(), kind: tier.kind, amount: tier.amount, itemId: tier.itemId, reason: tier.reason, campaignId, grantedAt: now });
    if (tier.kind === 'item' && tier.itemId && !player.items.includes(tier.itemId)) player.items.push(tier.itemId);
  }
}

export function equipItemInState(state: ProgressionState, sessionId: string, itemId: string): PlayerProgress {
  const player = state.players.find((candidate) => candidate.sessionId === sessionId); if (!player) throw new Error('Player not found');
  const item = SEASON_ITEMS.find((candidate) => candidate.id === itemId); if (!item) throw new Error('Unknown cosmetic');
  if (!player.items.includes(itemId)) throw new Error('You have not unlocked that cosmetic');
  player.equipped ??= {}; player.equipped[item.slot] = itemId; return player;
}

export function consumeMintCreditInState(state: ProgressionState, sessionId: string, rewardId: string, idempotencyKey: string, amount: number, now: number): PlayerProgress {
  return consumeMintBenefitInState(state, sessionId, rewardId, idempotencyKey, amount, now, 'mint-credit');
}

export function consumeMintDiscountInState(state: ProgressionState, sessionId: string, rewardId: string, idempotencyKey: string, amount: number, now: number): PlayerProgress {
  return consumeMintBenefitInState(state, sessionId, rewardId, idempotencyKey, amount, now, 'mint-discount');
}

function consumeMintBenefitInState(state: ProgressionState, sessionId: string, rewardId: string, idempotencyKey: string, amount: number, now: number, kind: 'mint-credit' | 'mint-discount'): PlayerProgress {
  const player = state.players.find((candidate) => candidate.sessionId === sessionId);
  if (!player) throw new Error('Player not found');
  if (state.redemptionKeys.includes(idempotencyKey)) return player;
  const reward = player?.rewards.find((candidate) => candidate.id === rewardId);
  if (!player || !reward || reward.kind !== kind) throw new Error(kind === 'mint-credit' ? 'Mint Credit not found' : 'Mint discount not found');
  if (reward.expiresAt && reward.expiresAt <= now) throw new Error('Mint Credit expired');
  const redeemed = reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0);
  if (!Number.isInteger(amount) || amount < 1 || redeemed + amount > reward.amount) throw new Error(kind === 'mint-credit' ? 'Mint Credit is unavailable' : 'Mint discount is unavailable');
  reward.redeemedAmount = redeemed + amount;
  if (reward.redeemedAmount === reward.amount) reward.redeemedAt = now;
  state.redemptionKeys.push(idempotencyKey); state.redemptionKeys = state.redemptionKeys.slice(-10_000);
  return player;
}

export class MemoryProgressionRepository implements ProgressionRepository {
  private readonly state = cleanState();
  constructor(private readonly clock: () => number = Date.now) {}
  async ensurePlayer(sessionId: string, name: string): Promise<PlayerProgress> { return structuredClone(ensurePlayerInState(this.state, sessionId, name, this.clock())); }
  async getPlayer(sessionId: string): Promise<PlayerProgress | null> { return structuredClone(this.state.players.find((player) => player.sessionId === sessionId) ?? null); }
  async listPlayers(search = ''): Promise<PlayerProgress[]> {
    const query = search.trim().toLowerCase(); return structuredClone(this.state.players.filter((player) => !query || player.name.toLowerCase().includes(query) || player.sessionId.includes(query)));
  }
  async grant(input: RewardGrantInput): Promise<{ granted: number; skipped: number }> { return grantInState(this.state, input, this.clock()); }
  async acknowledge(sessionId: string, rewardId: string): Promise<PlayerProgress> {
    const player = this.state.players.find((candidate) => candidate.sessionId === sessionId); const reward = player?.rewards.find((candidate) => candidate.id === rewardId);
    if (!player || !reward) throw new Error('Reward not found'); reward.acknowledgedAt ??= this.clock(); return structuredClone(player);
  }
  async consumeMintCredit(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { return structuredClone(consumeMintCreditInState(this.state, sessionId, rewardId, idempotencyKey, amount, this.clock())); }
  async consumeMintDiscount(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { return structuredClone(consumeMintDiscountInState(this.state, sessionId, rewardId, idempotencyKey, amount, this.clock())); }
  async equipItem(sessionId: string, itemId: string): Promise<PlayerProgress> { return structuredClone(equipItemInState(this.state, sessionId, itemId)); }
  async audit(limit = 100): Promise<AdminAuditEntry[]> { return structuredClone(this.state.audit.slice(0, limit)); }
}

export class FileProgressionRepository implements ProgressionRepository {
  private state: ProgressionState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), '.data', 'progression.json'), private readonly clock: () => number = Date.now) {}
  async ensurePlayer(sessionId: string, name: string): Promise<PlayerProgress> { const state = await this.load(); const player = ensurePlayerInState(state, sessionId, name, this.clock()); await this.persist(state); return structuredClone(player); }
  async getPlayer(sessionId: string): Promise<PlayerProgress | null> { return structuredClone((await this.load()).players.find((player) => player.sessionId === sessionId) ?? null); }
  async listPlayers(search = ''): Promise<PlayerProgress[]> { const query = search.trim().toLowerCase(); return structuredClone((await this.load()).players.filter((player) => !query || player.name.toLowerCase().includes(query) || player.sessionId.includes(query))); }
  async grant(input: RewardGrantInput): Promise<{ granted: number; skipped: number }> { const state = await this.load(); const result = grantInState(state, input, this.clock()); await this.persist(state); return result; }
  async acknowledge(sessionId: string, rewardId: string): Promise<PlayerProgress> { const state = await this.load(); const player = state.players.find((candidate) => candidate.sessionId === sessionId); const reward = player?.rewards.find((candidate) => candidate.id === rewardId); if (!player || !reward) throw new Error('Reward not found'); reward.acknowledgedAt ??= this.clock(); await this.persist(state); return structuredClone(player); }
  async consumeMintCredit(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { const state = await this.load(); const player = consumeMintCreditInState(state, sessionId, rewardId, idempotencyKey, amount, this.clock()); await this.persist(state); return structuredClone(player); }
  async consumeMintDiscount(sessionId: string, rewardId: string, idempotencyKey: string, amount = 1): Promise<PlayerProgress> { const state = await this.load(); const player = consumeMintDiscountInState(state, sessionId, rewardId, idempotencyKey, amount, this.clock()); await this.persist(state); return structuredClone(player); }
  async equipItem(sessionId: string, itemId: string): Promise<PlayerProgress> { const state = await this.load(); const player = equipItemInState(state, sessionId, itemId); await this.persist(state); return structuredClone(player); }
  async audit(limit = 100): Promise<AdminAuditEntry[]> { return structuredClone((await this.load()).audit.slice(0, limit)); }
  private async load(): Promise<ProgressionState> {
    if (this.state) return this.state;
    try { this.state = cleanState(JSON.parse(await readFile(this.file, 'utf8')) as ProgressionState); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = cleanState(); }
    return this.state;
  }
  private async persist(state: ProgressionState): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.file); });
    return this.writeQueue;
  }
}
