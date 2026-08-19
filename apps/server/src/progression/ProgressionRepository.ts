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
  passEntitlements: string[];
  achievements: string[];
  items: string[];
  equipped: { avatar?: string; brush?: string; reaction?: string; title?: string; frame?: string };
  competitive: CompetitiveProfile;
  rewards: RewardEntitlement[];
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface CompetitiveTotals { chaosScore: number; matches: number; wins: number; sharedWins: number; correctGuesses: number; fastestGuesses: number; drawings: number; gamePoints: number; }
export interface CompetitiveProfile { allTime: CompetitiveTotals; season: CompetitiveTotals; weeks: Record<string, CompetitiveTotals>; months: Record<string, CompetitiveTotals>; }
export type LeaderboardPeriod = 'weekly' | 'monthly' | 'season' | 'all-time';
export interface LeaderboardEntry extends CompetitiveTotals { rank: number; sessionId: string; name: string; level: number; avatarItem?: string; titleItem?: string; frameItem?: string; }
export interface LeaderboardResult { period: LeaderboardPeriod; periodKey: string; label: string; startsAt?: number; endsAt?: number; scoring: string[]; prizes: Array<{ rank: string; label: string; detail: string }>; entries: LeaderboardEntry[]; }
export interface MatchProgressInput { matchId: string; endedAt: number; players: Array<{ sessionId: string; gamePoints: number; won: boolean; sharedWin: boolean; correctGuesses: number; fastestGuesses: number; drawings: number; completedMatch?: boolean }> }

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

interface ProgressionState { players: PlayerProgress[]; audit: AdminAuditEntry[]; appliedKeys: string[]; redemptionKeys: string[]; matchKeys: string[]; }

const SEASON_LEVEL_REWARDS: Array<{ level: number; kind: 'mint-credit' | 'item' | 'achievement'; amount: number; itemId?: string; reason: string }> = [
  { level: 2, kind: 'item', amount: 1, itemId: 'yellow-weirdo-avatar', reason: 'Season 0 Level 2 · Yellow Weirdo avatar' },
  { level: 3, kind: 'mint-credit', amount: 1, reason: 'Season 0 Level 3 · free Panic Archive mint' },
  { level: 5, kind: 'item', amount: 1, itemId: 'panic-pencil', reason: 'Season 0 Level 5 · Panic Pencil cosmetic' },
  { level: 7, kind: 'item', amount: 1, itemId: 'screaming-pencil-reaction', reason: 'Season 0 Level 7 · Screaming Pencil reaction' },
  { level: 10, kind: 'mint-credit', amount: 2, reason: 'Season 0 Level 10 · two free Panic Archive mints' },
  { level: 12, kind: 'item', amount: 1, itemId: 'beautiful-disaster-title', reason: 'Season 0 Level 12 · Beautiful Disaster title' },
  { level: 15, kind: 'item', amount: 1, itemId: 'taped-masterpiece-frame', reason: 'Season 0 Level 15 · Taped Masterpiece profile frame' },
  { level: 20, kind: 'achievement', amount: 1, itemId: 'first-mess-finisher', reason: 'Completed the Season 0 progression track' },
];
const PREMIUM_LEVEL_REWARDS: Array<{ level: number; kind: 'mint-credit' | 'item'; amount: number; itemId?: string; reason: string }> = [
  { level: 1, kind: 'item', amount: 1, itemId: 'green-chaos-avatar', reason: 'Premium Panic Pass · Green Chaos avatar' },
  { level: 2, kind: 'item', amount: 1, itemId: 'riot-marker-brush', reason: 'Premium Panic Pass Level 2 · Riot Marker brush' },
  { level: 3, kind: 'mint-credit', amount: 1, reason: 'Premium Panic Pass Level 3 · bonus free mint' },
  { level: 5, kind: 'item', amount: 1, itemId: 'neon-panic-brush', reason: 'Premium Panic Pass Level 5 · Neon Panic brush' },
  { level: 7, kind: 'item', amount: 1, itemId: 'tiny-fire-reaction', reason: 'Premium Panic Pass Level 7 · Tiny Fire reaction' },
  { level: 10, kind: 'mint-credit', amount: 2, reason: 'Premium Panic Pass Level 10 · two bonus free mints' },
  { level: 12, kind: 'item', amount: 1, itemId: 'chaos-charcoal-brush', reason: 'Premium Panic Pass Level 12 · Chaos Charcoal brush' },
  { level: 15, kind: 'item', amount: 1, itemId: 'velvet-rope-frame', reason: 'Premium Panic Pass Level 15 · Velvet Rope frame' },
  { level: 18, kind: 'item', amount: 1, itemId: 'professional-disaster-title', reason: 'Premium Panic Pass Level 18 · Professional Disaster title' },
  { level: 20, kind: 'item', amount: 1, itemId: 'golden-chaos-avatar', reason: 'Premium Panic Pass Level 20 · Golden Chaos avatar' },
];
export const SEASON_ITEMS = [
  { id: 'yellow-weirdo-avatar', name: 'Yellow Weirdo', description: 'The original suspiciously cheerful face.', slot: 'avatar', rarity: 'common', previewColor: '#ffb703' },
  { id: 'green-chaos-avatar', name: 'Green Chaos', description: 'Looks worried. Probably knows the prompt.', slot: 'avatar', rarity: 'rare', previewColor: '#27ae8a' },
  { id: 'golden-chaos-avatar', name: 'Golden Chaos', description: 'Season finisher energy with questionable talent.', slot: 'avatar', rarity: 'legendary', previewColor: '#f2c94c' },
  { id: 'panic-pencil', name: 'Panic Pencil', description: 'A hot-red drawing cursor and Studio brush accent.', slot: 'brush', rarity: 'rare', previewColor: '#e54b3e' },
  { id: 'riot-marker-brush', name: 'Riot Marker', description: 'A broad translucent premium marker that visibly stacks wet ink.', slot: 'brush', rarity: 'rare', previewColor: '#ef476f' },
  { id: 'neon-panic-brush', name: 'Neon Panic', description: 'A bright-core premium brush with a genuine electric glow.', slot: 'brush', rarity: 'epic', previewColor: '#8b5cf6' },
  { id: 'chaos-charcoal-brush', name: 'Chaos Charcoal', description: 'A dry, grainy premium stick with broken fibres and dust.', slot: 'brush', rarity: 'epic', previewColor: '#34302d' },
  { id: 'screaming-pencil-reaction', name: 'Screaming Pencil', description: 'An exclusive reaction for drawings that have seen things.', slot: 'reaction', rarity: 'rare', previewColor: '#ffb703', glyph: '✏️' },
  { id: 'tiny-fire-reaction', name: 'Tiny Fire', description: 'Premium portable arson for the reaction rail.', slot: 'reaction', rarity: 'epic', previewColor: '#ef476f', glyph: '🧨' },
  { id: 'beautiful-disaster-title', name: 'Beautiful Disaster', description: 'A player title displayed beneath your name.', slot: 'title', rarity: 'epic', previewColor: '#27ae8a' },
  { id: 'taped-masterpiece-frame', name: 'Taped Masterpiece', description: 'A wonky gallery frame around your Arena face.', slot: 'frame', rarity: 'epic', previewColor: '#2878ff' },
  { id: 'velvet-rope-frame', name: 'Velvet Rope', description: 'A premium coral-and-gold frame for extremely important nonsense.', slot: 'frame', rarity: 'legendary', previewColor: '#ef476f' },
  { id: 'professional-disaster-title', name: 'Professional Disaster', description: 'A premium title for players who fail with exceptional consistency.', slot: 'title', rarity: 'legendary', previewColor: '#ffb703' },
] as const;
const SEASON_0_PUBLIC_ITEM_IDS = new Set<string>(['yellow-weirdo-avatar', 'panic-pencil', 'screaming-pencil-reaction', 'beautiful-disaster-title', 'taped-masterpiece-frame']);
export const ACTIVE_SEASON_ITEMS = SEASON_ITEMS.filter((item) => SEASON_0_PUBLIC_ITEM_IDS.has(item.id));

export interface ProgressionRepository {
  ensurePlayer(sessionId: string, name: string): Promise<PlayerProgress>;
  getPlayer(sessionId: string): Promise<PlayerProgress | null>;
  listPlayers(search?: string): Promise<PlayerProgress[]>;
  grant(input: RewardGrantInput): Promise<{ granted: number; skipped: number }>;
  acknowledge(sessionId: string, rewardId: string): Promise<PlayerProgress>;
  consumeMintCredit(sessionId: string, rewardId: string, idempotencyKey: string, amount?: number): Promise<PlayerProgress>;
  consumeMintDiscount(sessionId: string, rewardId: string, idempotencyKey: string, amount?: number): Promise<PlayerProgress>;
  equipItem(sessionId: string, itemId: string): Promise<PlayerProgress>;
  recordMatch(input: MatchProgressInput): Promise<{ recorded: boolean }>;
  leaderboard(period: LeaderboardPeriod, now?: number, limit?: number): Promise<LeaderboardResult>;
  audit(limit?: number): Promise<AdminAuditEntry[]>;
}

function cleanState(value?: Partial<ProgressionState>): ProgressionState {
  return { players: value?.players ?? [], audit: value?.audit ?? [], appliedKeys: value?.appliedKeys ?? [], redemptionKeys: value?.redemptionKeys ?? [], matchKeys: value?.matchKeys ?? [] };
}

const emptyTotals = (): CompetitiveTotals => ({ chaosScore: 0, matches: 0, wins: 0, sharedWins: 0, correctGuesses: 0, fastestGuesses: 0, drawings: 0, gamePoints: 0 });
const emptyCompetitive = (): CompetitiveProfile => ({ allTime: emptyTotals(), season: emptyTotals(), weeks: {}, months: {} });
function normalizePlayer(player: PlayerProgress): PlayerProgress { player.equipped ??= {}; player.passEntitlements ??= []; player.competitive ??= emptyCompetitive(); player.competitive.allTime ??= emptyTotals(); player.competitive.season ??= emptyTotals(); player.competitive.weeks ??= {}; player.competitive.months ??= {}; return player; }

export function ensurePlayerInState(state: ProgressionState, sessionId: string, name: string, now: number): PlayerProgress {
  const existing = state.players.find((player) => player.sessionId === sessionId);
  if (existing) {
    existing.name = name;
    existing.lastSeenAt = now;
    normalizePlayer(existing);
    ensureFirstMintCredit(existing, now);
    ensureFoundingSeasonOnePass(existing);
    applySeasonLevelRewards(existing, now);
    return existing;
  }
  const player: PlayerProgress = {
    sessionId, name, seasonId: 'season-0', xp: 0, level: 1, battlePass: 'free', passEntitlements: [], achievements: [], items: [], equipped: {}, competitive: emptyCompetitive(), rewards: [],
    firstSeenAt: now, lastSeenAt: now,
  };
  ensureFirstMintCredit(player, now);
  ensureFoundingSeasonOnePass(player);
  state.players.push(player); return player;
}

function ensureFoundingSeasonOnePass(player: PlayerProgress): void {
  const entitlement = 'season-1-premium';
  if (!player.passEntitlements.includes(entitlement)) player.passEntitlements.push(entitlement);
  const campaignId = 'season-0-founding-weirdos-season-1-premium';
  player.rewards = player.rewards.filter((reward) => reward.campaignId !== campaignId);
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
    if (input.kind === 'battle-pass') {
      const entitlement = input.itemId ?? 'season-0-premium';
      if (!player.passEntitlements.includes(entitlement)) player.passEntitlements.push(entitlement);
      if (entitlement === 'season-0-premium') { player.battlePass = 'premium'; applyPremiumLevelRewards(player, now); }
    }
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

export function recordMatchInState(state: ProgressionState, input: MatchProgressInput): { recorded: boolean } {
  if (state.matchKeys.includes(input.matchId)) return { recorded: false };
  const week = utcWeekKey(input.endedAt); const month = utcMonthKey(input.endedAt);
  for (const result of input.players) {
    const player = state.players.find((candidate) => candidate.sessionId === result.sessionId); if (!player) continue;
    normalizePlayer(player);
    const completedMatch = result.completedMatch !== false;
    const delta: CompetitiveTotals = { chaosScore: (completedMatch ? 100 : 0) + (completedMatch && result.won ? result.sharedWin ? 175 : 250 : 0) + result.correctGuesses * 75 + result.fastestGuesses * 100 + result.drawings * 40,
      matches: completedMatch ? 1 : 0, wins: completedMatch && result.won ? 1 : 0, sharedWins: completedMatch && result.sharedWin ? 1 : 0, correctGuesses: result.correctGuesses, fastestGuesses: result.fastestGuesses, drawings: result.drawings, gamePoints: result.gamePoints };
    addTotals(player.competitive.allTime, delta); addTotals(player.competitive.season, delta);
    player.competitive.weeks[week] ??= emptyTotals(); player.competitive.months[month] ??= emptyTotals();
    addTotals(player.competitive.weeks[week]!, delta); addTotals(player.competitive.months[month]!, delta);
    player.competitive.weeks = keepRecent(player.competitive.weeks, 16); player.competitive.months = keepRecent(player.competitive.months, 18);
  }
  state.matchKeys.push(input.matchId); state.matchKeys = state.matchKeys.slice(-10_000); return { recorded: true };
}

export function buildLeaderboard(players: PlayerProgress[], period: LeaderboardPeriod, now = Date.now(), limit = 100): LeaderboardResult {
  const week = utcWeekKey(now); const month = utcMonthKey(now); const range = periodRange(period, now);
  const values = players.map(normalizePlayer).map((player) => ({ sessionId: player.sessionId, name: player.name, level: player.level, avatarItem: player.equipped.avatar, titleItem: player.equipped.title, frameItem: player.equipped.frame,
    ...(period === 'weekly' ? player.competitive.weeks[week] ?? emptyTotals() : period === 'monthly' ? player.competitive.months[month] ?? emptyTotals() : period === 'season' ? player.competitive.season : player.competitive.allTime) }))
    .filter((entry) => entry.matches > 0).sort((a, b) => b.chaosScore - a.chaosScore || b.wins - a.wins || b.correctGuesses - a.correctGuesses || b.gamePoints - a.gamePoints || a.name.localeCompare(b.name));
  let previousScore = -1; let previousWins = -1; let rank = 0;
  const entries = values.slice(0, Math.max(1, Math.min(250, limit))).map((entry, index) => { if (entry.chaosScore !== previousScore || entry.wins !== previousWins) rank = index + 1; previousScore = entry.chaosScore; previousWins = entry.wins; return { ...entry, rank }; });
  return { period, periodKey: period === 'weekly' ? week : period === 'monthly' ? month : period === 'season' ? 'season-0' : 'all-time', label: range.label, startsAt: range.startsAt, endsAt: range.endsAt,
    scoring: ['+100 finish an 8-drawing match', '+250 solo win · +175 shared crown', '+75 correct guess', '+100 fastest solve', '+40 completed drawing'], prizes: leaderboardPrizes(period), entries };
}

function addTotals(target: CompetitiveTotals, delta: CompetitiveTotals): void { for (const key of Object.keys(delta) as Array<keyof CompetitiveTotals>) target[key] += delta[key]; }
function keepRecent(values: Record<string, CompetitiveTotals>, count: number): Record<string, CompetitiveTotals> { return Object.fromEntries(Object.entries(values).sort(([a], [b]) => b.localeCompare(a)).slice(0, count)); }
export function utcMonthKey(now: number): string { const date = new Date(now); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
export function utcWeekKey(now: number): string { const date = new Date(now); const day = date.getUTCDay() || 7; date.setUTCDate(date.getUTCDate() + 4 - day); const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1); const week = Math.ceil((((date.getTime() - yearStart) / 86_400_000) + 1) / 7); return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`; }
function periodRange(period: LeaderboardPeriod, now: number): { label: string; startsAt?: number; endsAt?: number } { const date = new Date(now); if (period === 'weekly') { const day = date.getUTCDay() || 7; const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() - day + 1); return { label: 'This week · resets Monday 00:00 UTC', startsAt, endsAt: startsAt + 7 * 86_400_000 }; } if (period === 'monthly') { const startsAt = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1); return { label: 'This month · resets on the 1st UTC', startsAt, endsAt: Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) }; } return { label: period === 'season' ? 'Season 0 · The First Mess' : 'All recorded chaos' }; }
function leaderboardPrizes(period: LeaderboardPeriod): Array<{ rank: string; label: string; detail: string }> { if (period === 'weekly') return [{ rank: '#1', label: 'Weekly Chaos Crown', detail: 'Badge + 750 XP' }, { rank: '#2', label: 'Almost Functional', detail: 'Badge + 500 XP' }, { rank: '#3', label: 'Podium Gremlin', detail: 'Badge + 300 XP' }]; if (period === 'monthly') return [{ rank: '#1', label: 'Monthly Menace', detail: 'Badge + 2 Mint Credits' }, { rank: '#2', label: 'Certified Threat', detail: 'Badge + 1 Mint Credit' }, { rank: '#3', label: 'Public Nuisance', detail: 'Badge + 1 Mint Credit' }]; return [{ rank: 'TOP', label: period === 'season' ? 'Season rewards loading…' : 'Hall of Chaos', detail: 'Permanent bragging rights. Bigger prizes will be announced.' }]; }

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
  async recordMatch(input: MatchProgressInput): Promise<{ recorded: boolean }> { return recordMatchInState(this.state, input); }
  async leaderboard(period: LeaderboardPeriod, now = this.clock(), limit = 100): Promise<LeaderboardResult> { return structuredClone(buildLeaderboard(this.state.players, period, now, limit)); }
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
  async recordMatch(input: MatchProgressInput): Promise<{ recorded: boolean }> { const state = await this.load(); const result = recordMatchInState(state, input); await this.persist(state); return result; }
  async leaderboard(period: LeaderboardPeriod, now = this.clock(), limit = 100): Promise<LeaderboardResult> { return structuredClone(buildLeaderboard((await this.load()).players, period, now, limit)); }
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
