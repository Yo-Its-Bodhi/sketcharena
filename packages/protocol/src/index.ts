export type RoomPhase = 'lobby' | 'paused' | 'countdown' | 'drawing' | 'reveal' | 'afterparty';
export type CanvasRatio = 'square' | 'portrait' | 'landscape';
export type DrawTool = 'pencil' | 'eraser' | 'fill';
export type BrushStyle = 'pencil' | 'ink' | 'marker' | 'airbrush' | 'charcoal' | 'technical' | 'watercolor' | 'pastel' | 'pixel' | 'calligraphy' | 'neon';
export type StrokeShape = 'freehand' | 'line' | 'rectangle' | 'ellipse' | 'arrow' | 'triangle';
export type ArtworkBlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten';

export interface Point { x: number; y: number; pressure?: number; }

export interface Stroke {
  id: string;
  tool: DrawTool;
  color: string;
  size: number;
  points: Point[];
  at: number;
  brush?: BrushStyle;
  shape?: StrokeShape;
  opacity?: number;
  smoothing?: number;
  layerId?: string;
  blendMode?: ArtworkBlendMode;
}

export { renderArtworkDocumentSvg, renderArtworkSvg } from './renderArtworkSvg.js';

export interface PlayerView {
  id: string;
  sessionId: string;
  name: string;
  avatarSeed: number;
  avatarItem?: string;
  titleItem?: string;
  frameItem?: string;
  score: number;
  roundScore: number;
  streak: number;
  isHost: boolean;
  isDrawer: boolean;
  hasGuessed: boolean;
  connected: boolean;
  ready: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  phase: RoomPhase;
  playerCount: number;
  maxPlayers: number;
  category: string;
  isPrivate: boolean;
  matchRounds: number;
  roundSeconds: number;
}

export interface RoomView extends RoomSummary {
  players: PlayerView[];
  hostId: string | null;
  drawerId: string | null;
  round: number;
  totalRounds: number;
  deadline: number | null;
  hints: string[];
  strokes: Stroke[];
  canvasRatio: CanvasRatio;
  feed: FeedItem[];
}

export interface FeedItem {
  id: string;
  kind: 'guess' | 'close' | 'correct' | 'chat' | 'reaction' | 'system';
  playerId?: string;
  playerName?: string;
  text: string;
  at: number;
  points?: number;
  reactions?: Record<string, number>;
}

export interface RoundResult {
  roundId: string;
  prompt: string;
  drawerId: string | null;
  drawerName: string;
  strokes: Stroke[];
  scores: PlayerView[];
  correct: Array<{ playerId: string; playerName: string; points: number; elapsedMs: number }>;
  funniestCandidates: FeedItem[];
  reason: 'time' | 'all-guessed' | 'drawer-left' | 'host-ended';
  endedAt: number;
}

export interface MatchResult {
  matchId: string;
  roomId: string;
  rounds: RoundResult[];
  standings: PlayerView[];
  winner: PlayerView | null;
  winners: PlayerView[];
  tieBreak: {
    rule: 'points' | 'correct-guesses' | 'fastest-total' | 'shared';
    label: string;
  };
}

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
export type CosmeticSlot = 'avatar' | 'brush' | 'reaction' | 'title' | 'frame';
export interface SeasonItemDefinition { id: string; name: string; description: string; slot: CosmeticSlot; rarity: 'common' | 'rare' | 'epic' | 'legendary'; previewColor: string; glyph?: string; }
export interface CompetitiveTotals { chaosScore: number; matches: number; wins: number; sharedWins: number; correctGuesses: number; fastestGuesses: number; drawings: number; gamePoints: number; }
export interface CompetitiveProfile { allTime: CompetitiveTotals; season: CompetitiveTotals; weeks: Record<string, CompetitiveTotals>; months: Record<string, CompetitiveTotals>; }
export type LeaderboardPeriod = 'weekly' | 'monthly' | 'season' | 'all-time';
export interface LeaderboardEntry extends CompetitiveTotals { rank: number; sessionId: string; name: string; level: number; avatarItem?: string; titleItem?: string; frameItem?: string; }
export interface LeaderboardResponse { period: LeaderboardPeriod; periodKey: string; label: string; startsAt?: number; endsAt?: number; scoring: string[]; prizes: Array<{ rank: string; label: string; detail: string }>; entries: LeaderboardEntry[]; }

export type ModerationReportCategory = 'harassment' | 'hate-or-threats' | 'spam' | 'cheating' | 'unsafe-art' | 'other';
export type ModerationReportStatus = 'open' | 'reviewing' | 'resolved' | 'dismissed';
export interface ModerationReport {
  id: string;
  roomId: string;
  roomName: string;
  reporterSessionId: string;
  reporterName: string;
  targetSessionId: string;
  targetPlayerId: string;
  targetName: string;
  category: ModerationReportCategory;
  detail: string;
  status: ModerationReportStatus;
  createdAt: number;
  updatedAt: number;
  handledBy?: string;
  resolutionNote?: string;
}

export type ArtworkOrigin = 'arena' | 'studio';
export type ArtworkStatus = 'draft' | 'gallery' | 'mint-ready' | 'minted';
export type MintStatus = 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'expired';

export interface PanicArchiveVoucher {
  recipient: `0x${string}`;
  tokenURIHash: `0x${string}`;
  artworkHash: `0x${string}`;
  price: string;
  nonce: string;
  deadline: string;
  seasonId: number;
  campaignId: `0x${string}`;
}

export interface MintPreparation {
  id: string;
  artworkId: string;
  status: MintStatus;
  walletAddress: `0x${string}`;
  contractAddress: `0x${string}`;
  chainId: number;
  chainName: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
  paymentToken: { address: `0x${string}`; name: string; symbol: string; decimals: number };
  priceQuote?: { usdCents: number; tokenUsd: number; source: string; quotedAt: number };
  rpcUrls: string[];
  blockExplorerUrl?: string;
  marketplaceUrl?: string;
  mediaURI: string;
  tokenURI: string;
  voucher: PanicArchiveVoucher;
  signature: `0x${string}`;
  transactionRequest: { to: `0x${string}`; from: `0x${string}`; value: `0x${string}`; data: `0x${string}` };
  approvalRequest?: { to: `0x${string}`; from: `0x${string}`; value: `0x0`; data: `0x${string}` };
  usesMintCredit: boolean;
  discountBps?: number;
  expiresAt: number;
  transactionHash?: `0x${string}`;
  tokenId?: string;
  error?: string;
}

export interface WalletChallenge {
  challengeId: string;
  address: `0x${string}`;
  message: string;
  expiresAt: number;
}

export interface ArtworkDocument {
  id: string;
  ownerSessionId: string;
  origin: ArtworkOrigin;
  status: ArtworkStatus;
  title: string;
  description: string;
  canvasRatio: CanvasRatio;
  width: number;
  height: number;
  strokes: Stroke[];
  previewUrl?: string;
  sourceRoundId?: string;
  createdAt: number;
  updatedAt: number;
  mint?: {
    network: 'shido';
    status?: MintStatus;
    walletAddress?: `0x${string}`;
    contractAddress?: `0x${string}`;
    tokenURI?: string;
    tokenId?: string;
    transactionHash?: string;
    marketplaceUrl?: string;
  };
}

export interface PanicArchiveItem {
  id: string;
  title: string;
  description: string;
  origin: ArtworkOrigin;
  canvasRatio: CanvasRatio;
  width: number;
  height: number;
  strokes: Stroke[];
  previewUrl?: string;
  createdAt: number;
  mintedAt: number;
  seasonId: number;
  seasonName: string;
  tokenId: string;
  contractAddress: `0x${string}`;
  transactionHash: string;
  tokenURI: string;
  marketplaceUrl?: string;
}

export interface ServerToClientEvents {
  'rooms:list': (rooms: RoomSummary[]) => void;
  'room:state': (room: RoomView) => void;
  'room:error': (message: string) => void;
  'feed:item': (item: FeedItem) => void;
  'draw:stroke': (stroke: Stroke) => void;
  'draw:preview': (stroke: Stroke) => void;
  'draw:clear': () => void;
  'round:brief': (payload: { prompt: string; round: number; totalRounds: number }) => void;
  'round:reveal': (result: RoundResult) => void;
  'match:complete': (result: MatchResult) => void;
}

export interface Ack<T = undefined> { ok: boolean; data?: T; error?: string; }

export const DRAW_LIMITS = {
  maxStrokes: 1_500,
  maxPointsPerStroke: 250,
} as const;

export interface ClientToServerEvents {
  'session:resume': (payload: { credential?: string; name: string }, ack: (value: Ack<{ sessionId: string; name: string }>) => void) => void;
  'rooms:subscribe': () => void;
  'room:create': (payload: { name: string; category: string; isPrivate?: boolean; maxPlayers?: number; roundSeconds?: number }, ack: (value: Ack<{ room: RoomView; inviteCode?: string }>) => void) => void;
  'room:join': (payload: { roomId?: string; inviteCode?: string }, ack: (value: Ack<{ room: RoomView }>) => void) => void;
  'room:leave': (ack: (value: Ack) => void) => void;
  'player:ready': (payload: { ready: boolean }, ack: (value: Ack) => void) => void;
  'player:kick': (payload: { playerId: string }, ack: (value: Ack) => void) => void;
  'player:report': (payload: { playerId: string; category: ModerationReportCategory; detail: string }, ack: (value: Ack<{ reportId: string }>) => void) => void;
  'game:start': (ack: (value: Ack) => void) => void;
  'game:rematch': (ack: (value: Ack) => void) => void;
  'guess:submit': (payload: { text: string }, ack: (value: Ack) => void) => void;
  'chat:send': (payload: { text: string }, ack: (value: Ack) => void) => void;
  'reaction:send': (payload: { emoji: string; targetId?: string }, ack: (value: Ack) => void) => void;
  'draw:stroke': (stroke: Stroke, ack: (value: Ack) => void) => void;
  'draw:preview': (stroke: Stroke) => void;
  'draw:clear': () => void;
  'draw:undo': () => void;
  'draw:move': (payload: { x: number; y: number }) => void;
  'round:keep': (payload: { roundId: string }, ack: (value: Ack<ArtworkDocument>) => void) => void;
}
