export type RoomPhase = 'lobby' | 'paused' | 'countdown' | 'drawing' | 'reveal' | 'afterparty';
export type CanvasRatio = 'square' | 'portrait' | 'landscape';
export type DrawTool = 'pencil' | 'eraser' | 'fill';

export interface Point { x: number; y: number; }

export interface Stroke {
  id: string;
  tool: DrawTool;
  color: string;
  size: number;
  points: Point[];
  at: number;
}

export interface PlayerView {
  id: string;
  sessionId: string;
  name: string;
  avatarSeed: number;
  score: number;
  roundScore: number;
  streak: number;
  isHost: boolean;
  isDrawer: boolean;
  hasGuessed: boolean;
  connected: boolean;
}

export interface RoomSummary {
  id: string;
  name: string;
  phase: RoomPhase;
  playerCount: number;
  maxPlayers: number;
  category: string;
  isPrivate: boolean;
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
}

export interface FeedItem {
  id: string;
  kind: 'guess' | 'close' | 'correct' | 'chat' | 'reaction' | 'system';
  playerId?: string;
  playerName?: string;
  text: string;
  at: number;
  points?: number;
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
  roomId: string;
  rounds: RoundResult[];
  standings: PlayerView[];
  winner: PlayerView | null;
}

export type ArtworkOrigin = 'arena' | 'studio';
export type ArtworkStatus = 'draft' | 'gallery' | 'mint-ready' | 'minted';

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
    tokenId?: string;
    transactionHash?: string;
    marketplaceUrl?: string;
  };
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

export interface ClientToServerEvents {
  'session:resume': (payload: { sessionId: string; name: string }, ack: (value: Ack<{ sessionId: string }>) => void) => void;
  'rooms:subscribe': () => void;
  'room:create': (payload: { name: string; category: string; isPrivate?: boolean; maxPlayers?: number }, ack: (value: Ack<{ room: RoomView; inviteCode?: string }>) => void) => void;
  'room:join': (payload: { roomId?: string; inviteCode?: string }, ack: (value: Ack<{ room: RoomView }>) => void) => void;
  'room:leave': (ack: (value: Ack) => void) => void;
  'game:start': (ack: (value: Ack) => void) => void;
  'game:rematch': (ack: (value: Ack) => void) => void;
  'guess:submit': (payload: { text: string }, ack: (value: Ack) => void) => void;
  'chat:send': (payload: { text: string }, ack: (value: Ack) => void) => void;
  'reaction:send': (payload: { emoji: string }, ack: (value: Ack) => void) => void;
  'draw:stroke': (stroke: Stroke) => void;
  'draw:preview': (stroke: Stroke) => void;
  'draw:clear': () => void;
  'draw:undo': () => void;
  'round:keep': (payload: { roundId: string }, ack: (value: Ack<ArtworkDocument>) => void) => void;
}
