import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DRAW_LIMITS, type Ack, type ArtworkDocument, type CanvasRatio, type FeedItem, type MatchResult, type MintPreparation, type ModerationReport, type ModerationReportCategory, type PanicArchiveItem, type PlayerProgress, type PlayerView, type RewardEntitlement, type RoomPhase, type RoomSummary, type RoomView, type RoundResult, type SeasonItemDefinition, type Stroke } from '@sketch-arena/protocol';
import { Canvas, type CanvasLayer } from './Canvas';
import { normalizeArtworkStrokes } from './strokeTransport';
import { gameAudio } from './sound';
import { socket } from './socket';
import { walletError } from './walletErrors';
import { accountStatus, ensureDeviceSession, listDeviceSessions, revokeDeviceSession, secureAccountWithPasskey, signInWithPasskey, type DeviceSessionInfo, type PlayerAccountInfo } from './account';

type Screen = 'landing' | 'lobby' | 'arena' | 'studio' | 'vault' | 'archive' | 'afterparty' | 'backstage';
type AdminMintRecord = { id: string; artworkId: string; ownerSessionId: string; status: 'prepared' | 'submitted' | 'confirmed' | 'failed' | 'expired'; walletAddress: string; usesMintCredit: boolean; discountBps?: number; expiresAt: number; transactionHash?: string; tokenId?: string; error?: string; updatedAt: number };
type AdminPromotion = { id: string; name: string; codeHint: string; kind: 'free-mint' | 'mint-discount'; usesPerPlayer: number; discountBps?: number; reason: string; maxRedemptions: number; expiresAt: number; status: 'active' | 'paused' | 'ended'; redemptions: Array<{ sessionId: string; at: number }>; createdBy: string; createdAt: number; updatedAt: number };
type ContractAccessChoice = 'approve' | 'remove-approval' | 'block' | 'unblock' | 'require-allowlist' | 'open-vouchers' | 'pause-minting' | 'unpause-minting';
type AdminContractTransaction = { chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrl?: string; request: { to: `0x${string}`; value: `0x${string}`; data: `0x${string}` }; summary: string };
type AdminDeploymentTransaction = { chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrl?: string; owner: `0x${string}`; request: { value: '0x0'; data: `0x${string}` }; artifact: { contractName: string; compiler: string; sourceSha256: string; deployedBytes: number }; parameters: { mintSigner: `0x${string}`; payoutReceiver: `0x${string}`; paymentToken: `0x${string}`; maxSupply: string; maxMintPrice: string; collectionMetadataURI: string; artistRoyaltyPercent: number; startsPaused: true } };
type AdminOverview = { actor: { name: string; role: 'viewer' | 'operator' | 'admin' }; season: { id: string; name: string }; players: number; availableMintCredits: number; rooms: number; moderation: Record<'open' | 'reviewing' | 'resolved' | 'dismissed', number>; minting: { enabled: boolean; contractControlsEnabled: boolean; collection: string; chainName: string; missing: string[] }; mintOps: { wallets: number; total: number; prepared: number; submitted: number; confirmed: number; failed: number; recent: AdminMintRecord[] }; promotions: { total: number; active: number; campaigns: AdminPromotion[] }; audit: Array<{ id: string; action: string; actor: string; reason: string; targetCount: number; campaignId?: string; at: number }> };
type PromptDeckId = 'chaos' | 'classic' | 'crypto' | 'animals' | 'food' | 'screen' | 'music' | 'places' | 'legends';
interface CreateRoomOptions { name: string; category: PromptDeckId; isPrivate: boolean; maxPlayers: number; roundSeconds: 30 | 45 | 60; }
const PROMPT_DECKS: Array<{ id: PromptDeckId; name: string; icon: string; difficulty: 'EASY' | 'MEDIUM' | 'HARD'; detail: string }> = [
  { id: 'chaos', name: 'Arena Chaos', icon: '?!', difficulty: 'EASY', detail: 'The signature beautifully weird deck' },
  { id: 'classic', name: 'Quick Draw', icon: '✎', difficulty: 'EASY', detail: 'Familiar crowd pleasers' },
  { id: 'animals', name: 'Animal Antics', icon: '♞', difficulty: 'EASY', detail: 'Critters behaving badly' },
  { id: 'food', name: 'Food Fight', icon: '♨', difficulty: 'EASY', detail: 'Snacks with main-character energy' },
  { id: 'screen', name: 'Screen Time', icon: '▶', difficulty: 'MEDIUM', detail: 'Movies, TV & famous scenes' },
  { id: 'music', name: 'Loud Icons', icon: '♫', difficulty: 'MEDIUM', detail: 'Musicians & bands' },
  { id: 'places', name: 'Wish You Were Here', icon: '⌖', difficulty: 'MEDIUM', detail: 'Places & landmarks' },
  { id: 'crypto', name: 'Web3 Nonsense', icon: '₿', difficulty: 'HARD', detail: 'Blockchain panic vocabulary' },
  { id: 'legends', name: 'Mythical Mess', icon: '♜', difficulty: 'HARD', detail: 'Monsters in ridiculous situations' },
];
const storedCredential = localStorage.getItem('arena-credential');
let sessionCredential = storedCredential ?? Array.from(crypto.getRandomValues(new Uint8Array(32)), (value) => value.toString(16).padStart(2, '0')).join('');
localStorage.setItem('arena-credential', sessionCredential);
let sessionId = '';

export function App() {
  const [screen, setScreen] = useState<Screen>(() => location.pathname === '/backstage' ? 'backstage' : location.pathname === '/archive' ? 'archive' : 'landing');
  const [name, setName] = useState(localStorage.getItem('arena-name') ?? '');
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [reveal, setReveal] = useState<RoundResult | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [savedRounds, setSavedRounds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [progression, setProgression] = useState<PlayerProgress | null>(null);
  const lastPhase = useRef<RoomPhase | null>(null);
  const refreshProgression = useCallback(() => fetch('/api/progression', { headers: { authorization: `Bearer ${sessionCredential}` } })
    .then((response) => response.ok ? response.json() as Promise<PlayerProgress> : Promise.reject())
    .then((value) => { setProgression(value); if (value.equipped.brush) localStorage.setItem('sketch-equipped-brush', value.equipped.brush); }).catch(() => undefined), []);

  useEffect(() => {
    const savedName = localStorage.getItem('arena-name')?.trim();
    const connect = () => {
      setConnected(true);
      if (savedName) socket.emit('session:resume', { credential: sessionCredential, name: savedName }, (ack) => {
        if (!ack.ok || !ack.data) return setError(ack.error ?? 'Could not restore your session');
        sessionId = ack.data.sessionId; localStorage.setItem('arena-session', sessionId); socket.emit('rooms:subscribe'); void refreshProgression();
      });
    };
    const disconnect = () => setConnected(false);
    const state = (value: RoomView) => {
      if (!value.players.some((player) => player.sessionId === sessionId)) return;
      if (value.phase !== lastPhase.current) {
        if (value.phase === 'countdown') gameAudio.play('start');
        if (value.phase === 'drawing') gameAudio.play('turn');
        if (value.phase === 'reveal') gameAudio.play('round-end');
        lastPhase.current = value.phase;
      }
      setRoom(value);
      if (value.phase !== 'reveal') setReveal(null);
      if (value.phase !== 'drawing') setPrompt('');
      setScreen(value.phase === 'afterparty' ? 'afterparty' : 'arena');
    };
    const item = (value: FeedItem) => {
      if (value.kind === 'correct') gameAudio.play('correct');
      else if (value.kind === 'close') gameAudio.play('close');
      else if (value.kind === 'chat' || value.kind === 'guess') gameAudio.play('chat');
      else if (value.kind === 'system' && value.text.includes('entered')) gameAudio.play('join');
      setFeed((items) => [...items.slice(-79), value]);
    };
    const mergeStroke = (value: Stroke) => setRoom((valueRoom) => valueRoom ? { ...valueRoom, strokes: [...valueRoom.strokes.filter((stroke) => stroke.id !== value.id), value] } : valueRoom);
    const clear = () => setRoom((valueRoom) => valueRoom ? { ...valueRoom, strokes: [] } : valueRoom);
    socket.on('connect', connect); socket.on('disconnect', disconnect); socket.on('rooms:list', setRooms); socket.on('room:state', state);
    socket.on('feed:item', item); socket.on('draw:stroke', mergeStroke); socket.on('draw:preview', mergeStroke); socket.on('draw:clear', clear);
    socket.on('room:error', (message) => setError(message));
    socket.on('round:brief', (value) => setPrompt(value.prompt)); socket.on('round:reveal', (value) => setReveal(value));
    socket.on('match:complete', (value) => { gameAudio.play('victory'); setMatch(value); setScreen('afterparty'); setTimeout(() => void refreshProgression(), 250); });
    const unlockAudio = () => { void gameAudio.unlock(); };
    document.addEventListener('pointerdown', unlockAudio, { once: true });
    void (async () => { if (savedName) await ensureDeviceSession(sessionCredential, savedName).catch(() => undefined); socket.connect(); })();
    return () => { document.removeEventListener('pointerdown', unlockAudio); socket.off(); socket.disconnect(); };
  }, [refreshProgression]);

  useEffect(() => {
    if (screen !== 'lobby') return;
    void refreshProgression(); const timer = setInterval(() => void refreshProgression(), 30_000);
    return () => clearInterval(timer);
  }, [screen, refreshProgression]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 4_500);
    return () => clearTimeout(timer);
  }, [error]);

  const enter = async () => {
    const clean = name.trim(); if (clean.length < 2) return setError('Give the crowd a name to yell.');
    localStorage.setItem('arena-name', clean); setError(''); await ensureDeviceSession(sessionCredential, clean).catch(() => undefined);
    socket.emit('session:resume', { credential: sessionCredential, name: clean }, (ack) => {
      if (!ack.ok || !ack.data) return setError(ack.error ?? 'Could not enter');
      sessionId = ack.data.sessionId; localStorage.setItem('arena-session', sessionId); socket.emit('rooms:subscribe'); void refreshProgression();
      const invited = new URLSearchParams(location.search).get('join');
      if (invited) socket.emit('room:join', { inviteCode: invited }, (joined) => { handleAck(joined); if (joined.ok) history.replaceState({}, '', location.pathname); });
      else setScreen('lobby');
    });
  };
  const handleAck = <T,>(ack: Ack<T>) => { if (!ack.ok) setError(ack.error ?? 'Something went sideways'); };
  const keepRound = useCallback((roundId: string) => new Promise<ArtworkDocument>((resolve, reject) => {
    socket.emit('round:keep', { roundId }, (ack) => {
      if (!ack.ok || !ack.data) return reject(new Error(ack.error ?? 'Could not save that masterpiece'));
      setSavedRounds((values) => [...new Set([...values, roundId])]);
      resolve(ack.data);
    });
  }), []);
  const acknowledgeReward = (rewardId: string) => fetch(`/api/progression/rewards/${rewardId}/acknowledge`, { method: 'POST', headers: { authorization: `Bearer ${sessionCredential}` } })
    .then(async (response) => { if (!response.ok) throw new Error((await response.json() as { error?: string }).error); return response.json() as Promise<PlayerProgress>; })
    .then(setProgression).catch((reason: Error) => setError(reason.message || 'Could not claim that reward'));
  const equipItem = async (itemId: string) => {
    const response = await fetch('/api/progression/equip', { method: 'POST', headers: { authorization: `Bearer ${sessionCredential}`, 'content-type': 'application/json' }, body: JSON.stringify({ itemId }) });
    const result = await response.json() as PlayerProgress & { error?: string }; if (!response.ok) throw new Error(result.error || 'Could not equip that cosmetic'); setProgression(result); if (result.equipped.brush) localStorage.setItem('sketch-equipped-brush', result.equipped.brush);
  };
  const redeemPromotion = async (code: string): Promise<string> => {
    const response = await fetch('/api/promotions/redeem', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionCredential}` }, body: JSON.stringify({ code }) });
    const result = await response.json() as { error?: string; reward?: 'mint-credit' | 'mint-discount'; uses?: number; discountBps?: number };
    if (!response.ok) throw new Error(result.error || 'That promo could not be redeemed'); await refreshProgression();
    return result.reward === 'mint-credit' ? `${result.uses} free mint${result.uses === 1 ? '' : 's'} added to your Vault.` : `${(result.discountBps ?? 0) / 100}% off your next ${result.uses === 1 ? '' : `${result.uses} `}Panic Archive mint${result.uses === 1 ? '' : 's'}.`;
  };
  const passkeyLogin = async () => {
    try {
      const account = await signInWithPasskey(); localStorage.setItem('arena-name', account.name); setName(account.name); setError('');
      if (socket.connected) socket.disconnect(); socket.connect(); setScreen('lobby');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Passkey sign-in failed'); }
  };
  const createRoom = (options: CreateRoomOptions) => socket.emit('room:create', options, (ack) => {
    handleAck(ack);
    if (!ack.ok || !ack.data) return;
    setInviteCode(ack.data.inviteCode ?? ''); setRoom(ack.data.room); setFeed([]); setSavedRounds([]); setScreen('arena');
  });
  const joinRoom = (payload: { roomId?: string; inviteCode?: string }) => socket.emit('room:join', payload, (ack) => {
    handleAck(ack);
    if (!ack.ok || !ack.data) return;
    setInviteCode(''); setRoom(ack.data.room); setFeed([]); setSavedRounds([]); setScreen('arena');
  });
  const openArchive = () => { history.pushState({}, '', '/archive'); setScreen('archive'); };
  const closeArchive = () => { history.pushState({}, '', '/'); setScreen(name ? 'lobby' : 'landing'); };

  return <MotionConfig reducedMotion="user"><div className="app">
    <div className="paper-noise"/><div className="cinematic-vignette"/><div className="stage-light stage-light-a"/><div className="stage-light stage-light-b"/><SparkField/>
    {(screen === 'vault' || screen === 'archive') && <div className="section-floating-nav"><MainNav active={screen} play={() => { history.pushState({}, '', '/'); setScreen(name ? 'lobby' : 'landing'); }} studio={() => { history.pushState({}, '', '/'); setScreen('studio'); }} vault={() => { history.pushState({}, '', '/'); setScreen('vault'); }} archive={openArchive}/></div>}
    <AnimatePresence mode="wait">
      {screen === 'landing' && <Landing key="landing" name={name} setName={setName} enter={() => void enter()} passkeyLogin={() => void passkeyLogin()} studio={() => setScreen('studio')} vault={() => setScreen('vault')} archive={openArchive} connected={connected} error={error}/>}
      {screen === 'lobby' && <Lobby key="lobby" name={name} rooms={rooms} progression={progression} acknowledgeReward={acknowledgeReward} equipItem={equipItem} redeemPromotion={redeemPromotion} create={createRoom} join={(id) => joinRoom({ roomId: id })} joinCode={(code) => joinRoom({ inviteCode: code })} studio={() => setScreen('studio')} vault={() => setScreen('vault')} archive={openArchive}/>}
      {screen === 'arena' && room && <Arena key="arena" connected={connected} room={room} prompt={prompt} feed={feed} inviteCode={inviteCode} reveal={reveal} setReveal={setReveal} savedRounds={savedRounds} keepRound={keepRound} reportError={setError} leave={() => socket.emit('room:leave', (ack) => { handleAck(ack); if (!ack.ok) return; setRoom(null); setFeed([]); setInviteCode(''); setScreen('lobby'); socket.emit('rooms:subscribe'); })}/>}
      {screen === 'studio' && <Studio key="studio" back={() => setScreen(name ? 'lobby' : 'landing')} vault={() => setScreen('vault')}/>} 
      {screen === 'vault' && <Vault key="vault" back={() => setScreen(name ? 'lobby' : 'landing')} studio={() => setScreen('studio')}/>} 
      {screen === 'archive' && <PanicArchive key="archive" back={closeArchive}/>}
      {screen === 'afterparty' && match && <Afterparty
        key="afterparty"
        match={match}
        savedRounds={savedRounds}
        keepRound={keepRound}
        reportError={setError}
        replay={() => socket.emit('game:rematch', (ack) => { if (!ack.ok) return setError(ack.error ?? 'Could not start a rematch'); setMatch(null); })}
        vault={() => { socket.emit('room:leave', (ack) => { if (!ack.ok) return setError(ack.error ?? 'Could not open your Vault'); setRoom(null); setMatch(null); setScreen('vault'); }); }}
        home={() => { socket.emit('room:leave', (ack) => { if (!ack.ok) return setError(ack.error ?? 'Could not leave the match'); setRoom(null); setMatch(null); setScreen('lobby'); }); }}
      />}
      {screen === 'backstage' && <Backstage key="backstage" home={() => { history.pushState({}, '', '/'); setScreen(name ? 'lobby' : 'landing'); }}/>}
    </AnimatePresence>
    <AnimatePresence>{error && screen !== 'landing' && <motion.div className="toast-error" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} role="alert"><b>WHOOPS.</b> {error}</motion.div>}</AnimatePresence>
  </div></MotionConfig>;
}

function Landing({ name, setName, enter, passkeyLogin, studio, vault, archive, connected, error }: { name: string; setName: (value: string) => void; enter: () => void; passkeyLogin: () => void; studio: () => void; vault: () => void; archive: () => void; connected: boolean; error: string }) {
  return <motion.main className="landing screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: .98 }}>
    <header className="topbar brand-topbar"><Brand/><MainNav active="play" play={() => document.getElementById('arena-entry')?.scrollIntoView({ behavior: 'smooth', block: 'center' })} studio={studio} vault={vault} archive={archive}/><span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? 'stage online' : 'warming up'}</span></header>
    <section className="hero">
      <div className="hero-doodles" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/><span className="orbit-line"/><span className="pencil-comet">✎</span></div>
      <motion.div className="hero-kicker" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>LIVE DRAWING. LOUD GUESSING.</motion.div>
      <motion.h1 initial={{ y: 45, rotate: -1, opacity: 0 }} animate={{ y: 0, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 120 }}>DRAW BADLY.<br/><em>GUESS LOUDLY.</em></motion.h1>
      <p>The drawing game where panic is a feature and every disaster can become collectible.</p>
      <div className="hero-proof" aria-label="Game features"><span><b>45</b> SEC ROUNDS</span><i/><span><b>∞</b> BAD GUESSES</span><i/><span><b>1</b> GLORIOUS MESS</span></div>
      <div className="entry-card" id="arena-entry">
        <label>WHAT SHOULD THE CROWD CALL YOU?</label>
        <div><input value={name} maxLength={20} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && enter()} placeholder="Your stage name" autoFocus/><button className="primary" onClick={enter}>ENTER THE ARENA <b>→</b></button></div>
        <button className="passkey-login" onClick={passkeyLogin}>⌁ SIGN IN WITH A PASSKEY</button>{error && <span className="error">{error}</span>}
      </div>
      <button className="studio-link" onClick={studio}><span>✦</span><b>SOLO STUDIO</b><small>Take your time. Make something beautiful.</small><i>→</i></button>
    </section>
      <div className="ticker"><span>30–60 SECOND ROUNDS</span><b>✦</b><span>REAL-TIME CHAOS</span><b>✦</b><span>SHIDO CREATOR EXPORT</span><b>✦</b><span>KEEP THE MOMENT</span></div>
  </motion.main>;
}

function Lobby({ name, rooms, progression, acknowledgeReward, equipItem, redeemPromotion, create, join, joinCode, studio, vault, archive }: { name: string; rooms: RoomSummary[]; progression: PlayerProgress | null; acknowledgeReward: (rewardId: string) => void; equipItem: (itemId: string) => Promise<void>; redeemPromotion: (code: string) => Promise<string>; create: (options: CreateRoomOptions) => void; join: (id: string) => void; joinCode: (code: string) => void; studio: () => void; vault: () => void; archive: () => void }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [code, setCode] = useState('');
  const [roomName, setRoomName] = useState(`${name}'s Arena`);
  const [category, setCategory] = useState<CreateRoomOptions['category']>('chaos');
  const [isPrivate, setPrivate] = useState(false);
  const [maxPlayers, setMaxPlayers] = useState(8);
  const [roundSeconds, setRoundSeconds] = useState<30 | 45 | 60>(45);
  const setupDialogRef = useDialogFocus(setupOpen, () => setSetupOpen(false));
  const openRoom = rooms.find((value) => value.phase === 'lobby' && value.playerCount < value.maxPlayers);
  const quickPlay = () => openRoom ? join(openRoom.id) : create({ name: 'Open Mic Mayhem', category: 'chaos', isPrivate: false, maxPlayers: 8, roundSeconds: 45 });
  const submitCreate = () => { create({ name: roomName.trim() || `${name}'s Arena`, category, isPrivate, maxPlayers, roundSeconds }); setSetupOpen(false); };

  return <motion.main className="screen lobby lobby-v2" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
    <header className="topbar brand-topbar"><Brand/><MainNav active="play" play={() => undefined} studio={studio} vault={vault} archive={archive}/><div className="player-chip"><Avatar seed={name.length * 91} item={progression?.equipped.avatar}/><span><small>TONIGHT’S TROUBLEMAKER</small><b>{name}</b></span></div></header>
    {progression && <ProgressDock progression={progression} acknowledgeReward={acknowledgeReward} equipItem={equipItem} redeemPromotion={redeemPromotion}/>}
    <section className="lobby-heading lobby-heading-v2"><div><span>SKETCH ARENA LIVE</span><h1>How do you<br/><em>want to play?</em></h1><p>Be drawing—or yelling wrong answers—in under ten seconds.</p></div><div className="doodle-orbit" aria-hidden="true"><b>45</b><span>SECONDS OF<br/>POOR DECISIONS</span></div></section>

    <section className="play-paths">
      <button className="play-path quick-path" onClick={quickPlay}><span className="path-number">01</span><small>FASTEST WAY IN</small><h2>THROW ME<br/>IN.</h2><p>{openRoom ? `Joining ${openRoom.name}` : 'We’ll open a public room and bring the chaos to you.'}</p><b>QUICK PLAY <i>→</i></b><span className="scribble-face" aria-hidden="true">◉‿◉</span></button>
      <button className="play-path host-path" onClick={() => setSetupOpen(true)}><span className="path-number">02</span><small>YOUR RULES</small><h2>HOST THE<br/>SHOW.</h2><p>Pick the prompts, invite the group, then hit the big red button.</p><b>SET UP A ROOM <i>→</i></b><span className="sketch-star" aria-hidden="true">✦</span></button>
      <div className="play-path code-path"><span className="path-number">03</span><small>GOT AN INVITE?</small><h2>CRASH A<br/>PARTY.</h2><div className="code-entry"><input aria-label="Invite code" value={code} maxLength={12} onChange={(event) => setCode(event.target.value.toUpperCase())} onKeyDown={(event) => event.key === 'Enter' && code.trim() && joinCode(code.trim())} placeholder="ENTER CODE"/><button disabled={!code.trim()} onClick={() => joinCode(code.trim())}>GO</button></div></div>
    </section>

    <section className="rooms-section"><div className="rooms-title"><div><span className="live-dot"/> LIVE ARENAS</div><small>{rooms.length ? `${rooms.length} room${rooms.length === 1 ? '' : 's'} making questionable art` : 'Quiet... suspiciously quiet.'}</small></div><div className="room-strip">
      {rooms.map((room, index) => <motion.button className="room-ticket" disabled={room.phase !== 'lobby' || room.playerCount >= room.maxPlayers} onClick={() => join(room.id)} key={room.id} initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * .05 }}><span className="ticket-icon">{room.category === 'crypto' ? '₿' : room.category === 'classic' ? '✎' : '?!'}</span><span><small>{room.category} • {room.phase}</small><b>{room.name}</b></span><i>{room.playerCount}/{room.maxPlayers}</i><strong>{room.phase === 'lobby' ? 'JOIN →' : 'WATCHING'}</strong></motion.button>)}
      {!rooms.length && <button className="room-ticket empty-ticket" onClick={() => setSetupOpen(true)}><span className="ticket-icon">＋</span><span><small>NO ROOMS YET</small><b>Make the first bad decision</b></span><strong>HOST →</strong></button>}
    </div></section>

    <div className="creative-paths"><button className="studio-banner studio-banner-v2" onClick={studio}><span>OTHER MOOD</span><b><i>SOLO STUDIO</i> — No clock. Serious tools. Your storefront.</b><strong>CREATE IN PEACE →</strong></button><button className="vault-shortcut" onClick={vault}><span>YOUR COLLECTION</span><b>ARTWORK VAULT</b><strong>OPEN →</strong></button><button className="vault-shortcut archive-shortcut" onClick={archive}><span>PUBLIC COLLECTION</span><b>THE PANIC ARCHIVE</b><strong>VISIT →</strong></button></div>

    <AnimatePresence>{setupOpen && <motion.div className="setup-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && setSetupOpen(false)}>
      <motion.section ref={setupDialogRef} tabIndex={-1} className="setup-sheet" role="dialog" aria-modal="true" aria-labelledby="room-setup-title" initial={{ y: 40, rotate: 1, opacity: 0 }} animate={{ y: 0, rotate: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}>
        <button className="setup-close" onClick={() => setSetupOpen(false)} aria-label="Close room setup">×</button><span>ROOM SETUP</span><h2 id="room-setup-title">Build your<br/>little circus.</h2>
        <label>ROOM NAME<input autoFocus value={roomName} maxLength={36} onChange={(event) => setRoomName(event.target.value)}/></label>
        <fieldset className="prompt-deck-grid"><legend>PROMPT DECK · 9 WAYS TO PANIC</legend>{PROMPT_DECKS.map((deck) => <button type="button" className={category === deck.id ? 'selected' : ''} onClick={() => setCategory(deck.id)} key={deck.id}><b>{deck.icon}</b><span>{deck.name}<small>{deck.difficulty} · {deck.detail}</small></span></button>)}</fieldset>
        <div className="setup-rules"><RulePicker label="MAX PLAYERS" values={[4,6,8]} value={maxPlayers} setValue={setMaxPlayers}/><div className="fixed-match-rule"><small>MATCH LENGTH</small><b>8 drawings every game</b><span>Turns rotate fairly through everyone who joins.</span></div><RulePicker label="SECONDS" values={[30,45,60]} value={roundSeconds} setValue={(value) => setRoundSeconds(value as 30 | 45 | 60)}/></div>
        <button className={`privacy-toggle ${isPrivate ? 'selected' : ''}`} onClick={() => setPrivate((value) => !value)}><span>{isPrivate ? '●' : '○'}</span><b>{isPrivate ? 'PRIVATE INVITE ROOM' : 'PUBLIC DROP-IN ROOM'}</b><small>{isPrivate ? 'Only people with the code can join' : 'Anyone in the lobby can jump in'}</small></button><button className="primary setup-submit" onClick={submitCreate}>OPEN THE DOORS →</button>
      </motion.section>
    </motion.div>}</AnimatePresence>
  </motion.main>;
}

function Backstage({ home }: { home: () => void }) {
  const [token, setToken] = useState(sessionStorage.getItem('sketch-backstage-token') ?? '');
  const initialToken = useRef(token);
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [players, setPlayers] = useState<PlayerProgress[]>([]);
  const [reports, setReports] = useState<ModerationReport[]>([]);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<'locked' | 'loading' | 'ready'>('locked');
  const [message, setMessage] = useState('');
  const [renderedAt] = useState(() => Date.now());
  const [scope, setScope] = useState<'player' | 'everyone'>('player');
  const [target, setTarget] = useState('');
  const [kind, setKind] = useState<RewardEntitlement['kind']>('mint-credit');
  const [amount, setAmount] = useState(1);
  const [discountPercent, setDiscountPercent] = useState(25);
  const [itemId, setItemId] = useState('');
  const [reason, setReason] = useState('Season 0 thank-you');
  const [campaignId, setCampaignId] = useState('season-0-thanks');
  const [previewCount, setPreviewCount] = useState<number | null>(null);
  const [promoName, setPromoName] = useState('Season 0 surprise'); const [promoKind, setPromoKind] = useState<'free-mint' | 'mint-discount'>('free-mint');
  const [promoUses, setPromoUses] = useState(1); const [promoDiscount, setPromoDiscount] = useState(25); const [promoCap, setPromoCap] = useState(100); const [promoDays, setPromoDays] = useState(30);
  const [promoReason, setPromoReason] = useState('A little something from the Sketch Arena crew.'); const [promoCustomCode, setPromoCustomCode] = useState(''); const [issuedCode, setIssuedCode] = useState('');
  const [accessChoice, setAccessChoice] = useState<ContractAccessChoice>('approve'); const [accessAddress, setAccessAddress] = useState(''); const [accessMessage, setAccessMessage] = useState('');
  const [deployment, setDeployment] = useState<AdminDeploymentTransaction | null>(null); const [deploymentMessage, setDeploymentMessage] = useState(''); const [deploymentBusy, setDeploymentBusy] = useState(false);
  const canOperate = overview?.actor.role === 'operator' || overview?.actor.role === 'admin'; const canAdmin = overview?.actor.role === 'admin';
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  const adminFetch = async <T,>(path: string, options?: RequestInit): Promise<T> => {
    const response = await fetch(path, { ...options, headers: { ...headers, ...(options?.headers ?? {}) } });
    if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Backstage request failed');
    return response.json() as Promise<T>;
  };
  const load = useCallback(async (candidate: string, query: string) => {
    setStatus('loading'); setMessage('');
    try {
      const auth = { authorization: `Bearer ${candidate}` };
      const [nextOverview, nextPlayers, nextReports] = await Promise.all([
        fetch('/api/admin/overview', { headers: auth }),
        fetch(`/api/admin/players?search=${encodeURIComponent(query)}`, { headers: auth }),
        fetch('/api/admin/reports', { headers: auth }),
      ]);
      if (!nextOverview.ok) throw new Error((await nextOverview.json() as { error?: string }).error ?? 'Backstage is locked');
      if (!nextPlayers.ok) throw new Error('Could not load players');
      if (!nextReports.ok) throw new Error('Could not load moderation reports');
      setOverview(await nextOverview.json() as AdminOverview); setPlayers(await nextPlayers.json() as PlayerProgress[]); setReports(await nextReports.json() as ModerationReport[]);
      setToken(candidate); sessionStorage.setItem('sketch-backstage-token', candidate); setStatus('ready');
    } catch (error) { setStatus('locked'); setMessage(error instanceof Error ? error.message : 'Backstage is locked'); }
  }, []);
  useEffect(() => {
    if (initialToken.current.length < 32) return;
    const timer = setTimeout(() => void load(initialToken.current, ''), 0);
    return () => clearTimeout(timer);
  }, [load]);
  const rewardBody = () => ({ kind, amount, ...(kind === 'mint-discount' ? { discountBps: discountPercent * 100 } : {}), ...(itemId ? { itemId } : {}), reason, ...(campaignId ? { campaignId } : {}), idempotencyKey: `${campaignId || kind}-${crypto.randomUUID()}` });
  const sendGrant = async (confirmEveryone = false) => {
    setMessage('');
    try {
      let success = '';
      if (scope === 'player') {
        if (!target) throw new Error('Choose a player first');
        const result = await adminFetch<{ granted: number; skipped: number }>('/api/admin/grants', { method: 'POST', body: JSON.stringify({ ...rewardBody(), sessionIds: [target] }) });
        success = `Granted to ${result.granted} player${result.granted === 1 ? '' : 's'}${result.skipped ? `; ${result.skipped} skipped` : ''}.`;
      } else {
        const result = await adminFetch<{ dryRun?: boolean; eligiblePlayers?: number; granted?: number; skipped?: number }>('/api/admin/campaigns/all-players', { method: 'POST', body: JSON.stringify({ ...rewardBody(), dryRun: !confirmEveryone, ...(confirmEveryone ? { confirmation: 'GRANT TO ALL PLAYERS' } : {}) }) });
        if (!confirmEveryone) { setPreviewCount(result.eligiblePlayers ?? 0); return; }
        success = `Campaign sent to ${result.granted ?? 0} players${result.skipped ? `; ${result.skipped} skipped` : ''}.`; setPreviewCount(null);
      }
      await load(token, search);
      setMessage(success);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not send reward'); }
  };
  const createPromotion = async () => {
    setMessage(''); setIssuedCode('');
    try {
      const result = await adminFetch<{ campaign: AdminPromotion; code: string }>('/api/admin/promotions', { method: 'POST', body: JSON.stringify({ name: promoName, kind: promoKind, usesPerPlayer: promoUses,
        ...(promoKind === 'mint-discount' ? { discountBps: promoDiscount * 100 } : {}), reason: promoReason, maxRedemptions: promoCap, expiresInDays: promoDays, ...(promoCustomCode.trim() ? { customCode: promoCustomCode.trim() } : {}) }) });
      setIssuedCode(result.code); await load(token, search); setMessage(`Created ${result.campaign.name}. Copy the code now—it will not be shown in full again.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create promotion'); }
  };
  const setPromotionPaused = async (promotion: AdminPromotion, paused: boolean) => { try { await adminFetch(`/api/admin/promotions/${promotion.id}/pause`, { method: 'POST', body: JSON.stringify({ paused }) }); await load(token, search); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not update promotion'); } };
  const reviewReport = async (reportId: string, nextStatus: ModerationReport['status'], resolutionNote: string) => { try { await adminFetch(`/api/admin/reports/${reportId}/status`, { method: 'POST', body: JSON.stringify({ status: nextStatus, resolutionNote }) }); await load(token, search); } catch (error) { setMessage(error instanceof Error ? error.message : 'Could not update report'); } };
  const submitContractAccess = async () => {
    const provider = injectedWallet(); if (!provider) return setAccessMessage('Open this control room in a browser with an EVM wallet. The owner key is never stored by Sketch Arena.');
    setAccessMessage('Preparing the exact owner-only contract call…');
    try {
      const body = accessChoice === 'pause-minting' || accessChoice === 'unpause-minting' ? { action: 'set-paused', enabled: accessChoice === 'pause-minting' }
        : accessChoice === 'require-allowlist' || accessChoice === 'open-vouchers' ? { action: 'set-allowlist', enabled: accessChoice === 'require-allowlist' }
        : accessChoice === 'block' || accessChoice === 'unblock' ? { action: 'set-blocked', address: accessAddress, enabled: accessChoice === 'block' }
        : { action: 'set-approved', address: accessAddress, enabled: accessChoice === 'approve' };
      const transaction = await adminFetch<AdminContractTransaction>('/api/admin/contract-access/prepare', { method: 'POST', body: JSON.stringify(body) });
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[]; const from = accounts[0]; if (!from) throw new Error('No owner wallet was selected');
      await ensureWalletChain(provider, transaction); const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...transaction.request, from }] }) as string;
      setAccessMessage(`${transaction.summary}. Submitted ${hash.slice(0, 12)}… — verify confirmation in ${transaction.chainName} before treating it as active.`);
    } catch (error) { setAccessMessage(walletError(error)); }
  };
  const deployCollection = async () => {
    setDeploymentBusy(true); setDeploymentMessage('');
    try {
      if (!deployment) {
        const prepared = await adminFetch<AdminDeploymentTransaction>('/api/admin/contract-deployment/prepare');
        setDeployment(prepared); setDeploymentMessage('Review the exact roles and safety settings below. Nothing has been sent to your wallet yet.'); return;
      }
      const provider = injectedWallet(); if (!provider) throw new Error('Open Backstage in a browser with your admin EVM wallet. Sketch Arena never needs its private key.');
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[]; const from = accounts[0];
      if (!from || from.toLowerCase() !== deployment.owner.toLowerCase()) throw new Error(`Select the approved admin wallet ending ${deployment.owner.slice(-6)}. The connected wallet cannot deploy this collection.`);
      await ensureWalletChain(provider, deployment);
      const hash = await provider.request({ method: 'eth_sendTransaction', params: [{ ...deployment.request, from }] }) as string;
      setDeploymentMessage(`Deployment submitted ${hash.slice(0, 12)}… Waiting for the network receipt…`);
      const receipt = await waitForWalletReceipt(provider, hash, 'Collection deployment');
      if (!receipt.contractAddress) throw new Error('The network confirmed the transaction but did not return a collection address.');
      const code = await provider.request({ method: 'eth_getCode', params: [receipt.contractAddress, 'latest'] }) as string;
      if (!code || code === '0x') throw new Error('The receipt returned an address with no contract code. Minting remains locked.');
      setDeploymentMessage(`DEPLOYED PAUSED · ${receipt.contractAddress} · ${hash}. Send this address back here so it can be verified and connected before any mint opens.`);
    } catch (error) { setDeploymentMessage(walletError(error)); }
    finally { setDeploymentBusy(false); }
  };

  return <motion.main className="backstage screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <header className="backstage-bar"><button onClick={home}>← ARENA</button><Brand/><span><i/> {overview ? `${overview.actor.name} · ${overview.actor.role}` : 'PRIVATE CONTROL ROOM'}</span></header>
    {status !== 'ready' ? <section className="backstage-lock"><div className="loot-weirdos"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><small>AUTHORIZED WEIRDOS ONLY</small><h1>BACKSTAGE.</h1><p>Campaigns, player rewards and mint power live behind this door. The key stays in this browser tab only.</p><label>BACKSTAGE KEY<input type="password" value={token} onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load(token, '')} placeholder="Paste the server admin key"/></label><button className="primary" disabled={status === 'loading' || token.length < 32} onClick={() => void load(token, '')}>{status === 'loading' ? 'CHECKING…' : 'UNLOCK CONTROL ROOM →'}</button>{message && <b className="backstage-message">{message}</b>}</section> : <>
      <section className="backstage-heading"><div><small>PANIC ARCHIVE OPERATIONS · {overview?.actor.role.toUpperCase()}</small><h1>BACKSTAGE.</h1><p>Player rewards, voucher operations and infrastructure health—with scoped staff access and receipts for every consequential action.</p></div><div className="loot-weirdos"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div></section>
      <section className="backstage-metrics"><article><small>SEASON</small><b>{overview?.season.name}</b><em>{overview?.season.id}</em></article><article><small>PLAYERS</small><b>{overview?.players ?? 0}</b><em>known troublemakers</em></article><article><small>OPEN REPORTS</small><b>{(overview?.moderation.open ?? 0) + (overview?.moderation.reviewing ?? 0)}</b><em>{overview?.moderation.reviewing ?? 0} under review</em></article><article><small>MINT CREDITS</small><b>{overview?.availableMintCredits ?? 0}</b><em>available to redeem</em></article><article><small>LIVE ROOMS</small><b>{overview?.rooms ?? 0}</b><em>right now</em></article><article className={overview?.minting.enabled ? 'mint-live' : 'mint-locked'}><small>MINT ENGINE</small><b>{overview?.minting.enabled ? 'READY' : 'LOCKED'}</b><em>{overview?.minting.enabled ? overview.minting.chainName : 'production gate closed'}</em></article></section>
      <div className="backstage-grid"><section className={`backstage-panel grant-console ${!canOperate ? 'permission-locked' : ''}`}><span>REWARD CONSOLE · OPERATOR+</span><h2>Send something good.</h2>{!canOperate && <div className="permission-note">VIEWER ACCESS — reward controls are read-only.</div>}<div className="scope-tabs"><button disabled={!canOperate} className={scope === 'player' ? 'active' : ''} onClick={() => { setScope('player'); setPreviewCount(null); }}>ONE PLAYER</button><button disabled={!canAdmin} title={!canAdmin ? 'Admin permission required for global drops' : undefined} className={scope === 'everyone' ? 'active danger' : ''} onClick={() => { setScope('everyone'); setPreviewCount(null); }}>EVERYONE · ADMIN</button></div>{scope === 'player' && <label>RECIPIENT<select disabled={!canOperate} value={target} onChange={(event) => setTarget(event.target.value)}><option value="">Choose a player…</option>{players.map((player) => <option key={player.sessionId} value={player.sessionId}>{player.name} · Level {player.level}</option>)}</select></label>}<div className="grant-fields"><label>REWARD TYPE<select disabled={!canOperate} value={kind} onChange={(event) => setKind(event.target.value as RewardEntitlement['kind'])}><option value="mint-credit">Mint Credit</option><option value="mint-discount">Mint discount</option><option value="xp">XP</option><option value="item">Item / cosmetic</option><option value="achievement">Achievement</option><option value="battle-pass">Premium Panic Pass</option></select></label><label>{kind === 'mint-discount' ? 'USES' : 'AMOUNT'}<input disabled={!canOperate} type="number" min="1" max="100000" value={amount} onChange={(event) => setAmount(Math.max(1, Number(event.target.value)))}/></label></div>{kind === 'mint-discount' && <label>DISCOUNT PERCENT <b>{discountPercent}%</b><input disabled={!canOperate} type="range" min="1" max="100" value={discountPercent} onChange={(event) => setDiscountPercent(Number(event.target.value))}/></label>}{(kind === 'item' || kind === 'achievement') && <label>ITEM / ACHIEVEMENT ID<input disabled={!canOperate} value={itemId} onChange={(event) => setItemId(event.target.value)} placeholder="founders-scribble"/></label>}<label>PLAYER-FACING REASON<input disabled={!canOperate} value={reason} maxLength={240} onChange={(event) => setReason(event.target.value)}/></label><label>CAMPAIGN ID<input disabled={!canOperate} value={campaignId} maxLength={80} onChange={(event) => { setCampaignId(event.target.value); setPreviewCount(null); }} placeholder="season-0-thanks"/></label>{previewCount === null ? <button disabled={!canOperate || (scope === 'everyone' && !canAdmin)} className={scope === 'everyone' ? 'bulk-preview' : 'primary'} onClick={() => void sendGrant()}>{scope === 'everyone' ? 'PREVIEW GLOBAL DROP →' : 'SEND REWARD →'}</button> : <div className="bulk-confirm"><b>{previewCount} PLAYERS WILL RECEIVE THIS</b><p>This is the final gate. Duplicate campaign grants will be skipped.</p><button onClick={() => void sendGrant(true)}>CONFIRM GLOBAL DROP →</button><button onClick={() => setPreviewCount(null)}>CANCEL</button></div>}{message && <b className="backstage-message">{message}</b>}</section>
      <section className="backstage-panel player-ledger"><div className="panel-title"><div><span>PLAYER LEDGER</span><h2>People & progress.</h2></div><input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && void load(token, search)} placeholder="Search name"/></div><div className="player-table"><div className="table-head"><span>PLAYER</span><span>LEVEL</span><span>PASS</span><span>CREDITS</span></div>{players.map((player) => <button key={player.sessionId} onClick={() => { setTarget(player.sessionId); setScope('player'); }}><span><b>{player.name}</b><small>{player.sessionId.slice(0, 8)}…</small></span><strong>{player.level}</strong><em>{player.battlePass}</em><i>{player.rewards.filter((reward) => reward.kind === 'mint-credit' && (!reward.expiresAt || reward.expiresAt > renderedAt)).reduce((sum, reward) => sum + Math.max(0, reward.amount - (reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0))), 0)}</i></button>)}</div></section>
      <section className="backstage-panel audit-ledger"><span>AUDIT TRAIL</span><h2>Every button leaves footprints.</h2><div>{overview?.audit.length ? overview.audit.map((entry) => <article key={entry.id}><i>{new Date(entry.at).toLocaleString()}</i><b>{entry.reason}</b><small>{entry.actor} · {entry.targetCount} target{entry.targetCount === 1 ? '' : 's'}{entry.campaignId ? ` · ${entry.campaignId}` : ''}</small></article>) : <p>No operator actions yet. Suspiciously clean.</p>}</div></section></div>
      <ModerationQueue reports={reports} canOperate={Boolean(canOperate)} update={reviewReport}/>
      <section className="backstage-panel mint-ops-ledger"><div className="panel-title"><div><span>MINT OPERATIONS</span><h2>Every trophy, no pretending.</h2></div><div className="mint-op-counts"><b>{overview?.mintOps.wallets ?? 0}<small>WALLETS</small></b><b>{overview?.mintOps.prepared ?? 0}<small>READY</small></b><b>{overview?.mintOps.submitted ?? 0}<small>PENDING</small></b><b>{overview?.mintOps.confirmed ?? 0}<small>MINTED</small></b><b>{overview?.mintOps.failed ?? 0}<small>FAILED</small></b></div></div>{!overview?.minting.enabled && <div className="ops-gate"><b>PRODUCTION GATE CLOSED</b><span>{overview?.minting.missing.length ?? 0} deployment or live infrastructure check{overview?.minting.missing.length === 1 ? '' : 's'} have not cleared. No voucher can be issued.</span></div>}<div className="mint-op-table"><div className="mint-op-head"><span>STATE</span><span>WALLET / ARTWORK</span><span>PAYMENT</span><span>CHAIN PROOF</span><span>UPDATED</span></div>{overview?.mintOps.recent.length ? overview.mintOps.recent.map((mint) => <article key={mint.id}><strong className={`mint-state ${mint.status}`}>{mint.status}</strong><span><b>{mint.walletAddress.slice(0, 6)}…{mint.walletAddress.slice(-4)}</b><small>{mint.artworkId.slice(0, 8)}…</small></span><em>{mint.usesMintCredit ? 'MINT CREDIT' : mint.discountBps ? `${mint.discountBps / 100}% OFF` : 'ARENA FEE'}</em><span><b>{mint.tokenId ? `PANIC #${mint.tokenId}` : mint.transactionHash ? `${mint.transactionHash.slice(0, 10)}…` : 'NOT SUBMITTED'}</b>{mint.error && <small>{mint.error}</small>}</span><time>{new Date(mint.updatedAt).toLocaleString()}</time></article>) : <div className="ops-empty">No mint attempts yet. The archive ledger is clean.</div>}</div></section>
      {!overview?.minting.contractControlsEnabled && <section className={`backstage-panel deployment-console ${!canAdmin ? 'permission-locked' : ''}`}><div><span>FINAL COLLECTION DEPLOYMENT · ADMIN WALLET</span><h2>Put The Panic Archive on-chain.</h2><p>Backstage builds the exact reviewed transaction. Your wallet is the only thing that can approve it. The new collection starts paused and stays unable to mint until its address and live state are independently verified.</p></div>{deployment ? <div className="deployment-review"><b>REVIEW BEFORE SIGNING</b><dl><div><dt>OWNER</dt><dd>{deployment.owner}</dd></div><div><dt>VOUCHER SIGNER</dt><dd>{deployment.parameters.mintSigner}</dd></div><div><dt>TREASURY</dt><dd>{deployment.parameters.payoutReceiver}</dd></div><div><dt>PAYMENT</dt><dd>{deployment.parameters.paymentToken}</dd></div><div><dt>ROYALTY</dt><dd>{deployment.parameters.artistRoyaltyPercent}% to original artist</dd></div><div><dt>LAUNCH STATE</dt><dd>PAUSED · minting locked</dd></div><div><dt>BYTECODE</dt><dd>{deployment.artifact.deployedBytes.toLocaleString()} bytes · {deployment.artifact.sourceSha256.slice(0, 12)}…</dd></div></dl></div> : <div className="deployment-seal"><b>NO PRIVATE KEY UPLOAD</b><span>Only wallet 0xA9E8…9E4e is accepted.</span><span>Unlimited collection · unlimited token-denominated safety cap · 5% artist royalty.</span></div>}<button className="primary" disabled={!canAdmin || deploymentBusy} onClick={() => void deployCollection()}>{deploymentBusy ? 'WAITING…' : deployment ? 'DEPLOY PAUSED COLLECTION WITH OWNER WALLET →' : 'LOAD EXACT DEPLOYMENT FOR REVIEW →'}</button>{deploymentMessage && <div className="contract-access-message">{deploymentMessage}</div>}</section>}
      <section className={`backstage-panel promotion-studio ${!canAdmin ? 'permission-locked' : ''}`}><div className="panel-title"><div><span>PROMOTIONS · ADMIN</span><h2>Make generosity scalable.</h2><p>Create capped, expiring codes for free mints or percentage discounts. Full codes are shown once; only their hash and safe hint are stored.</p></div><div className="promotion-count"><b>{overview?.promotions.active ?? 0}</b><small>ACTIVE OF {overview?.promotions.total ?? 0}</small></div></div><div className="promotion-grid"><div className="promotion-builder">{!canAdmin && <div className="permission-note">ADMIN ACCESS — campaign creation and pause controls are read-only.</div>}<label>CAMPAIGN NAME<input disabled={!canAdmin} value={promoName} maxLength={80} onChange={(event) => setPromoName(event.target.value)}/></label><div className="grant-fields"><label>REWARD<select disabled={!canAdmin} value={promoKind} onChange={(event) => setPromoKind(event.target.value as 'free-mint' | 'mint-discount')}><option value="free-mint">Free mint</option><option value="mint-discount">Percentage off</option></select></label><label>USES PER PLAYER<input disabled={!canAdmin} type="number" min="1" max="10" value={promoUses} onChange={(event) => setPromoUses(Math.max(1, Number(event.target.value)))}/></label></div>{promoKind === 'mint-discount' && <label>DISCOUNT <b>{promoDiscount}%</b><input disabled={!canAdmin} type="range" min="1" max="100" value={promoDiscount} onChange={(event) => setPromoDiscount(Number(event.target.value))}/></label>}<div className="grant-fields"><label>TOTAL REDEMPTION CAP<input disabled={!canAdmin} type="number" min="1" max="1000000" value={promoCap} onChange={(event) => setPromoCap(Math.max(1, Number(event.target.value)))}/></label><label>EXPIRES IN DAYS<input disabled={!canAdmin} type="number" min="1" max="365" value={promoDays} onChange={(event) => setPromoDays(Math.max(1, Number(event.target.value)))}/></label></div><label>PLAYER-FACING REASON<input disabled={!canAdmin} value={promoReason} maxLength={240} onChange={(event) => setPromoReason(event.target.value)}/></label><label>OPTIONAL CUSTOM CODE<input disabled={!canAdmin} value={promoCustomCode} maxLength={48} onChange={(event) => setPromoCustomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ''))} placeholder="Leave blank for a secure random code"/></label><button className="primary" disabled={!canAdmin || promoName.trim().length < 3 || promoReason.trim().length < 3} onClick={() => void createPromotion()}>CREATE PROMO & REVEAL CODE →</button>{issuedCode && <div className="issued-code"><small>COPY THIS NOW · SHOWN ONCE</small><b>{issuedCode}</b><button onClick={() => void navigator.clipboard.writeText(issuedCode)}>COPY CODE</button></div>}</div><div className="promotion-ledger">{overview?.promotions.campaigns.length ? overview.promotions.campaigns.map((promo) => <article key={promo.id}><header><span className={`promo-status ${promo.status}`}>{promo.status}</span><small>{promo.codeHint}</small></header><h3>{promo.name}</h3><p>{promo.kind === 'free-mint' ? `${promo.usesPerPlayer} free mint${promo.usesPerPlayer === 1 ? '' : 's'} per player` : `${(promo.discountBps ?? 0) / 100}% off · ${promo.usesPerPlayer} use${promo.usesPerPlayer === 1 ? '' : 's'}`}</p><div><b>{promo.redemptions.length}/{promo.maxRedemptions}<small>REDEEMED</small></b><b>{new Date(promo.expiresAt).toLocaleDateString()}<small>EXPIRES</small></b></div>{promo.status !== 'ended' && <button disabled={!canAdmin} onClick={() => void setPromotionPaused(promo, promo.status === 'active')}>{promo.status === 'active' ? 'PAUSE CAMPAIGN' : 'RESUME CAMPAIGN'}</button>}</article>) : <div className="ops-empty">No promo campaigns yet. Generate one when you are ready to cause joy.</div>}</div></div></section>
      <section className={`backstage-panel contract-access ${!canAdmin || !overview?.minting.contractControlsEnabled ? 'permission-locked' : ''}`}><div><span>CONTRACT ACCESS POLICY · OWNER WALLET</span><h2>Who may enter the Archive?</h2><p>Prepare allowlist, blocklist and emergency pause changes here, then sign them with the collection owner wallet. Sketch Arena never stores the owner key and never claims a policy changed merely because a button was clicked.</p></div><div className="contract-access-form"><label>ACTION<select disabled={!canAdmin || !overview?.minting.contractControlsEnabled} value={accessChoice} onChange={(event) => { setAccessChoice(event.target.value as ContractAccessChoice); setAccessMessage(''); }}><option value="approve">Approve wallet for allowlist</option><option value="remove-approval">Remove wallet approval</option><option value="block">Block wallet from minting</option><option value="unblock">Unblock wallet</option><option value="require-allowlist">Require allowlist globally</option><option value="open-vouchers">Allow any valid signed voucher</option><option value="pause-minting">Emergency pause all minting</option><option value="unpause-minting">Unpause reviewed minting</option></select></label>{!['require-allowlist','open-vouchers','pause-minting','unpause-minting'].includes(accessChoice) && <label>PLAYER WALLET<input disabled={!canAdmin || !overview?.minting.contractControlsEnabled} value={accessAddress} onChange={(event) => setAccessAddress(event.target.value)} placeholder="0x…"/></label>}<button className="primary" disabled={!canAdmin || !overview?.minting.contractControlsEnabled || (!['require-allowlist','open-vouchers','pause-minting','unpause-minting'].includes(accessChoice) && !/^0x[0-9a-f]{40}$/i.test(accessAddress))} onClick={() => void submitContractAccess()}>PREPARE & SIGN WITH OWNER WALLET →</button>{accessMessage && <div className="contract-access-message">{accessMessage}</div>}</div><footer><b>{overview?.minting.contractControlsEnabled ? 'OWNER SIGNATURE REQUIRED' : 'AVAILABLE AFTER REVIEWED DEPLOYMENT'}</b><span>Access and pause controls call the Panic Archive contract directly. Server staff credentials alone can never change on-chain policy.</span></footer></section>
    </>}
  </motion.main>;
}

function ModerationQueue({ reports, canOperate, update }: { reports: ModerationReport[]; canOperate: boolean; update: (reportId: string, status: ModerationReport['status'], note: string) => Promise<void> }) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const active = reports.filter((report) => report.status === 'open' || report.status === 'reviewing');
  return <section className={`backstage-panel moderation-queue ${!canOperate ? 'permission-locked' : ''}`}><div className="panel-title"><div><span>PLAYER SAFETY · OPERATOR+</span><h2>Human eyes on the chaos.</h2><p>Reports are private. Account identifiers and staff decisions stay in this control room and its protected audit store.</p></div><div className="moderation-count"><b>{active.length}</b><small>OPEN / REVIEWING</small></div></div>{!canOperate && <div className="permission-note">VIEWER ACCESS — reports are visible but decisions require operator permission.</div>}<div className="report-ledger">{active.length ? active.map((report) => <article key={report.id}><header><strong className={`report-status ${report.status}`}>{report.status}</strong><time>{new Date(report.createdAt).toLocaleString()}</time><small>{report.category.replaceAll('-', ' ')}</small></header><h3>{report.reporterName} reported {report.targetName}</h3><p>{report.detail}</p><div className="report-context"><span>ROOM <b>{report.roomName}</b></span><span>REPORTER <b>{report.reporterSessionId.slice(0,8)}…</b></span><span>SUBJECT <b>{report.targetSessionId.slice(0,8)}…</b></span></div>{report.handledBy && <em>{report.handledBy} · {report.resolutionNote}</em>}<label>STAFF NOTE<input disabled={!canOperate} value={notes[report.id] ?? ''} maxLength={500} onChange={(event) => setNotes((values) => ({ ...values, [report.id]: event.target.value }))} placeholder="What was reviewed or decided?"/></label><footer><button disabled={!canOperate} onClick={() => void update(report.id, 'reviewing', notes[report.id]?.trim() || 'Operator review started.')}>MARK REVIEWING</button><button disabled={!canOperate || (notes[report.id]?.trim().length ?? 0) < 3} className="resolve" onClick={() => void update(report.id, 'resolved', notes[report.id]!.trim())}>RESOLVE</button><button disabled={!canOperate || (notes[report.id]?.trim().length ?? 0) < 3} className="dismiss" onClick={() => void update(report.id, 'dismissed', notes[report.id]!.trim())}>DISMISS</button></footer></article>) : <div className="ops-empty">No reports waiting. The weirdos are behaving—for now.</div>}</div>{reports.some((report) => report.status === 'resolved' || report.status === 'dismissed') && <details className="closed-reports"><summary>CLOSED REPORTS · {reports.filter((report) => report.status === 'resolved' || report.status === 'dismissed').length}</summary>{reports.filter((report) => report.status === 'resolved' || report.status === 'dismissed').slice(0,20).map((report) => <div key={report.id}><b>{report.status.toUpperCase()} · {report.targetName}</b><span>{report.handledBy} · {report.resolutionNote}</span></div>)}</details>}</section>;
}

function ProgressDock({ progression, acknowledgeReward, equipItem, redeemPromotion }: { progression: PlayerProgress; acknowledgeReward: (rewardId: string) => void; equipItem: (itemId: string) => Promise<void>; redeemPromotion: (code: string) => Promise<string> }) {
  const [open, setOpen] = useState(false);
  const [seasonOpen, setSeasonOpen] = useState(false);
  const [promoOpen, setPromoOpen] = useState(false);
  const [renderedAt] = useState(() => Date.now());
  const [catalog, setCatalog] = useState<SeasonItemDefinition[]>([]);
  useEffect(() => { void fetch('/api/season/items').then((response) => response.ok ? response.json() as Promise<SeasonItemDefinition[]> : []).then(setCatalog); }, []);
  const activeRewards = progression.rewards.filter((reward) => (reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0)) < reward.amount && (!reward.expiresAt || reward.expiresAt > renderedAt));
  const newRewards = activeRewards.filter((reward) => !reward.acknowledgedAt);
  const mintCredits = activeRewards.filter((reward) => reward.kind === 'mint-credit').reduce((total, reward) => total + Math.max(0, reward.amount - (reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0))), 0);
  const xpIntoLevel = progression.xp % 1_000;
  return <><section className="progress-dock" aria-label="Season progression"><button className="season-stamp season-trigger" onClick={() => setSeasonOpen(true)} aria-label="Open Season 0 progress"><small>SEASON 0</small><b>THE FIRST MESS</b></button><button className="pass-progress pass-trigger" onClick={() => setSeasonOpen(true)} aria-label={`Level ${progression.level}, ${xpIntoLevel} of 1000 XP to next level`}><span><b>LEVEL {progression.level}</b><small>{progression.battlePass === 'premium' ? 'PANIC PASS' : 'FREE PASS'}</small></span><i><b style={{ width: `${xpIntoLevel / 10}%` }}/></i><em>{xpIntoLevel} / 1000 XP</em></button><div className="reward-wallet"><span><small>MINT CREDITS</small><b>{mintCredits}</b></span><span><small>COLLECTED</small><b>{progression.items.length + progression.achievements.length}</b></span></div><button className="promo-trigger" onClick={() => setPromoOpen(true)}><span>⌁</span><b>PROMO CODE</b></button><button className={`rewards-trigger ${newRewards.length ? 'has-loot' : ''}`} onClick={() => setOpen(true)}><span>{newRewards.length ? '✦' : '☰'}</span><b>{newRewards.length ? `NEW REWARD ×${newRewards.length}` : 'REWARD INBOX'}</b></button></section><AnimatePresence>{seasonOpen && <SeasonBook progression={progression} catalog={catalog} equipItem={equipItem} close={() => setSeasonOpen(false)}/>}</AnimatePresence><AnimatePresence>{open && <RewardInbox rewards={activeRewards} close={() => setOpen(false)} acknowledge={acknowledgeReward}/>}</AnimatePresence><AnimatePresence>{promoOpen && <PromoCodeModal close={() => setPromoOpen(false)} redeem={redeemPromotion}/>}</AnimatePresence></>;
}

function PromoCodeModal({ close, redeem }: { close: () => void; redeem: (code: string) => Promise<string> }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close); const [code, setCode] = useState(''); const [status, setStatus] = useState<'idle' | 'loading' | 'success'>('idle'); const [message, setMessage] = useState('');
  const submit = async () => { if (code.trim().length < 8) return; setStatus('loading'); setMessage(''); try { setMessage(await redeem(code.trim())); setStatus('success'); gameAudio.play('mint-success'); } catch (error) { setStatus('idle'); setMessage(error instanceof Error ? error.message : 'That promo did not work'); } };
  return <motion.div className="loot-overlay promo-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.div ref={dialogRef} tabIndex={-1} className="promo-sheet" role="dialog" aria-modal="true" aria-labelledby="promo-title" initial={{ y: 35, scale: .94, rotate: -1 }} animate={{ y: 0, scale: 1, rotate: 0 }} exit={{ y: 25, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close promo code">×</button><div className="loot-weirdos" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><small>FOUND SOMETHING WEIRD?</small><h2 id="promo-title">FEED THE<br/>PROMO GOBLIN.</h2><p>Codes can unlock free mints or a percentage off. They never ask for your wallet or spend gas.</p>{status !== 'success' ? <div className="promo-entry"><input autoFocus value={code} maxLength={64} onChange={(event) => setCode(event.target.value.toUpperCase())} onKeyDown={(event) => event.key === 'Enter' && void submit()} placeholder="PANIC-XXXX-XXXX" aria-label="Promo code"/><button disabled={status === 'loading' || code.trim().length < 8} onClick={() => void submit()}>{status === 'loading' ? 'CHECKING…' : 'REDEEM →'}</button></div> : <div className="promo-win"><b>✦ IT WORKED</b><span>{message}</span></div>}{message && status !== 'success' && <b className="promo-error">{message}</b>}<button className="text-button" onClick={close}>{status === 'success' ? 'BACK TO THE ARENA' : 'NEVER MIND'}</button></motion.div></motion.div>;
}

const SEASON_TRACK = [
  { level: 1, icon: '✦', name: 'FIRST MINT ON US', detail: '1 Panic Archive Mint Credit', campaignId: 'first-panic-archive-mint' },
  { level: 2, icon: '●', name: 'YELLOW WEIRDO', detail: 'Player avatar cosmetic', campaignId: 'season-0-level-2' },
  { level: 3, icon: '✦', name: 'PANIC ARCHIVE CREDIT', detail: '1 free mint', campaignId: 'season-0-level-3' },
  { level: 5, icon: '✎', name: 'PANIC PENCIL', detail: 'Studio cosmetic', campaignId: 'season-0-level-5' },
  { level: 10, icon: '✦✦', name: 'DOUBLE DROP', detail: '2 free mints', campaignId: 'season-0-level-10' },
  { level: 20, icon: '♛', name: 'FIRST MESS FINISHER', detail: 'Season achievement', campaignId: 'season-0-level-20' },
];

function SeasonBook({ progression, catalog, equipItem, close }: { progression: PlayerProgress; catalog: SeasonItemDefinition[]; equipItem: (itemId: string) => Promise<void>; close: () => void }) {
  const dialogRef = useDialogFocus(true, close);
  const xpIntoLevel = progression.xp % 1_000;
  const achievementNames: Record<string, string> = { 'first-mess': 'Entered the First Mess', 'crowned-chaos': 'Crowned Chaos', 'panic-button': 'Panic Button', 'certified-mess': 'Certified Mess', 'first-mess-finisher': 'First Mess Finisher' };
  return <motion.div className="loot-overlay season-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.section ref={dialogRef} tabIndex={-1} className="season-book" role="dialog" aria-modal="true" aria-labelledby="season-title" initial={{ y: 45, scale: .94, rotate: 1 }} animate={{ y: 0, scale: 1, rotate: 0 }} exit={{ y: 30, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close Season progress">×</button><header><div className="loot-weirdos" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><small>SEASON 0 · THE FIRST MESS</small><h2 id="season-title">YOUR PANIC<br/>PROGRESS.</h2><p>Finish matches, guess quickly and make a respectable mess. The good stuff falls out along the way.</p></header><div className="season-level-card"><span><small>CURRENT LEVEL</small><b>{progression.level}</b></span><div><strong>{progression.battlePass === 'premium' ? '♛ PREMIUM PANIC PASS' : 'FREE PANIC PASS'}</strong><i><b style={{ width: `${xpIntoLevel / 10}%` }}/></i><em>{xpIntoLevel} / 1000 XP TO LEVEL {progression.level + 1}</em></div></div><section className="season-track" aria-label="Season rewards">{SEASON_TRACK.map((tier) => { const earned = progression.rewards.some((reward) => reward.campaignId === tier.campaignId); return <article className={earned ? 'earned' : progression.level >= tier.level ? 'incoming' : 'locked'} key={tier.level}><span>{tier.icon}</span><small>LEVEL {tier.level}</small><b>{tier.name}</b><p>{tier.detail}</p><em>{earned ? '✓ EARNED' : progression.level >= tier.level ? 'DELIVERING' : 'LOCKED'}</em></article>; })}</section><div className="collection-ledger"><section><small>ACHIEVEMENTS</small><h3>{progression.achievements.length} COLLECTED</h3>{progression.achievements.length ? <div>{progression.achievements.map((id) => <span key={id}>★ {achievementNames[id] ?? id.replaceAll('-', ' ')}</span>)}</div> : <p>Your trophy shelf is suspiciously tidy.</p>}</section><section><small>ITEMS & COSMETICS</small><h3>{progression.items.length} COLLECTED</h3>{progression.items.length ? <div className="cosmetic-grid">{progression.items.map((id) => { const item = catalog.find((entry) => entry.id === id); const equipped = item ? progression.equipped[item.slot] === id : false; return <button className={equipped ? 'equipped' : ''} onClick={() => void equipItem(id)} key={id}><i style={{ background: item?.previewColor }}/><span><b>{item?.name ?? id.replaceAll('-', ' ')}</b><small>{item?.slot ?? 'cosmetic'} · {item?.rarity ?? 'earned'}</small></span><em>{equipped ? '✓ EQUIPPED' : 'EQUIP'}</em></button>; })}</div> : <p>Level up to make this pile weirder.</p>}</section></div></motion.section></motion.div>;
}

function RewardInbox({ rewards, close, acknowledge }: { rewards: RewardEntitlement[]; close: () => void; acknowledge: (rewardId: string) => void }) {
  const dialogRef = useDialogFocus(true, close);
  return <motion.div className="loot-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.section ref={dialogRef} tabIndex={-1} className="loot-sheet" role="dialog" aria-modal="true" aria-labelledby="loot-title" initial={{ y: 45, scale: .92, rotate: -2 }} animate={{ y: 0, scale: 1, rotate: 0 }} exit={{ y: 30, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close rewards">×</button><div className="loot-weirdos" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><small>EVERYTHING YOU EARNED · NOTHING FAKE TO CLAIM</small><h2 id="loot-title">REWARD<br/>INBOX.</h2><p className="loot-explainer">Rewards are active the moment you earn them. Marking one seen only clears the notification.</p>{!rewards.length && <div className="loot-empty"><b>Nothing rattling around in here.</b><span>Play matches and complete achievements to earn the good stuff.</span></div>}<div className="loot-list">{rewards.map((reward) => <article className={reward.acknowledgedAt ? 'claimed' : ''} key={reward.id}><span>{reward.kind === 'mint-credit' ? '✦' : reward.kind === 'mint-discount' ? '%' : reward.kind === 'xp' ? '⚡' : reward.kind === 'achievement' ? '★' : reward.kind === 'battle-pass' ? '♛' : '◉'}</span><div><small>{reward.kind.replace('-', ' ')}</small><b>{reward.itemId ? reward.itemId.replaceAll('-', ' ') : reward.kind === 'mint-credit' ? `${reward.amount} FREE MINT${reward.amount > 1 ? 'S' : ''}` : reward.kind === 'mint-discount' ? `${(reward.discountBps ?? 0) / 100}% OFF · ${reward.amount} USE${reward.amount > 1 ? 'S' : ''}` : `${reward.amount} XP`}</b><p>{reward.reason}</p></div>{reward.acknowledgedAt ? <em>SEEN</em> : <button onClick={() => acknowledge(reward.id)}>GOT IT</button>}</article>)}</div></motion.section></motion.div>;
}

function RulePicker({ label, values, value, setValue }: { label: string; values: number[]; value: number; setValue: (value: number) => void }) {
  return <fieldset><legend>{label}</legend><div>{values.map((option) => <button type="button" className={value === option ? 'selected' : ''} onClick={() => setValue(option)} key={option}>{option}</button>)}</div></fieldset>;
}

function Arena({ connected, room, prompt, feed, inviteCode, reveal, setReveal, savedRounds, keepRound, reportError, leave }: { connected: boolean; room: RoomView; prompt: string; feed: FeedItem[]; inviteCode: string; reveal: RoundResult | null; setReveal: (value: RoundResult | null) => void; savedRounds: string[]; keepRound: (roundId: string) => Promise<ArtworkDocument>; reportError: (message: string) => void; leave: () => void }) {
  const me = room.players.find((player) => player.sessionId === sessionId); const drawer = room.players.find((player) => player.id === room.drawerId);
  const isDrawer = me?.isDrawer ?? false; const [text, setText] = useState('');
  const [displayStrokes, setDisplayStrokes] = useState(room.strokes);
  const [copied, setCopied] = useState(false);
  const [muted, setMuted] = useState(gameAudio.isMuted());
  const [volume, setVolume] = useState(gameAudio.getVolume());
  const [mobilePanel, setMobilePanel] = useState<'none' | 'players' | 'chat'>('none');
  const [reporting, setReporting] = useState<PlayerView | null>(null);
  const lastTick = useRef<number | null>(null);
  useEffect(() => { const frame = requestAnimationFrame(() => setDisplayStrokes(room.strokes)); return () => cancelAnimationFrame(frame); }, [room.strokes]);
  useEffect(() => { if (!reveal) return; const frame = requestAnimationFrame(() => setMobilePanel('none')); return () => cancelAnimationFrame(frame); }, [reveal]);
  const seconds = useCountdown(room.deadline);
  useEffect(() => {
    if (room.phase === 'drawing' && seconds <= 10 && seconds > 0 && seconds !== lastTick.current) gameAudio.play('tick');
    lastTick.current = seconds;
  }, [room.phase, seconds]);
  const drawerChatLocked = room.phase === 'drawing' && isDrawer;
  const submit = () => {
    if (!connected) return reportError('Reconnecting—your message has not been sent yet');
    if (!text.trim() || drawerChatLocked) return;
    const event = room.phase === 'drawing' && !me?.hasGuessed ? 'guess:submit' : 'chat:send';
    socket.emit(event, { text }, (ack) => { if (!ack.ok) return reportError(ack.error ?? 'Could not send that'); setText(''); });
  };
  const stroke = (value: Stroke) => {
    setDisplayStrokes((items) => [...items.filter((item) => item.id !== value.id), value]);
    socket.emit('draw:stroke', value, (ack) => {
      if (ack.ok) return;
      setDisplayStrokes((items) => items.filter((item) => item.id !== value.id));
      reportError(ack.error ?? 'That mark could not be saved. Please draw it again.');
    });
  };
  const kick = (playerId: string, playerName: string) => {
    if (!window.confirm(`Remove ${playerName} from this arena? They will not be able to rejoin this room.`)) return;
    socket.emit('player:kick', { playerId }, (ack) => !ack.ok && reportError(ack.error ?? 'Could not remove that player'));
  };
  const submitReport = (category: ModerationReportCategory, detail: string) => new Promise<string>((resolve, reject) => {
    if (!reporting) return reject(new Error('Choose a player to report'));
    socket.emit('player:report', { playerId: reporting.id, category, detail }, (ack) => ack.ok && ack.data ? resolve(`Report ${ack.data.reportId.slice(0, 8)} received. Staff can now review it.`) : reject(new Error(ack.error ?? 'Could not send the report')));
  });

  const tension = room.phase !== 'drawing' ? 'calm' : seconds <= 3 ? 'critical' : seconds <= 10 ? 'panic' : seconds <= 15 ? 'urgent' : seconds <= 30 ? 'pressure' : 'calm';
  return <motion.main className={`arena arena-screen screen tension-${tension}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <header className="arena-bar"><button onClick={leave}>← LEAVE</button><div><small><i className="live-dot"/> ARENA BROADCAST • ROUND {room.round || '—'} / {room.totalRounds || '—'}</small><b>{room.name}</b></div><div className="arena-actions"><div className="sound-control"><button className="sound-toggle" aria-label={muted ? 'Turn game sounds on' : 'Mute game sounds'} aria-pressed={muted} onClick={() => { const next = !muted; gameAudio.setMuted(next); setMuted(next); if (!next) gameAudio.play('ui'); }}>{muted ? 'SOUND OFF' : 'SOUND ON'}</button><label className="sound-volume"><span>GAME VOLUME</span><b>{Math.round(volume * 100)}%</b><input aria-label="Game sound volume" type="range" min="0" max="100" value={Math.round(volume * 100)} onChange={(event) => { const next = Number(event.target.value) / 100; gameAudio.setVolume(next); setVolume(next); }}/></label></div><div className={`clock ${seconds <= 10 && room.phase === 'drawing' ? 'danger' : ''}`} aria-label={room.phase === 'drawing' ? `${seconds} seconds remaining` : room.phase} style={{ '--clock-progress': `${Math.max(0, Math.min(1, seconds / room.roundSeconds)) * 360}deg` } as React.CSSProperties}><span>{room.phase === 'lobby' ? 'WAITING' : room.phase === 'paused' ? 'HOLD' : room.phase === 'countdown' ? seconds : room.phase === 'reveal' ? 'REVEAL' : seconds}</span>{room.phase === 'drawing' && <i>SEC</i>}</div></div></header>
    <div className="game-grid">
      <aside className={`scoreboard ${mobilePanel === 'players' ? 'mobile-open' : ''}`}><div className="drawer-heading"><h3>THE LINEUP</h3><button onClick={() => setMobilePanel('none')} aria-label="Close players">×</button></div>{room.players.map((player, index) => <motion.div layout className={`score-player ${player.isDrawer ? 'drawing' : ''} ${player.hasGuessed ? 'scored' : ''} ${player.ready ? 'ready' : ''} ${!player.connected ? 'offline' : ''} ${player.id !== me?.id ? 'moderatable' : ''}`} key={player.id}><span className="rank">{index === 0 && player.score > 0 ? '♛' : index + 1}</span><Avatar seed={player.avatarSeed}/><div><b>{player.name}</b><small>{player.isDrawer ? 'DRAWING' : player.hasGuessed ? 'GOT IT' : room.phase === 'lobby' && player.ready ? 'READY' : player.isHost ? 'HOST' : room.phase === 'lobby' ? 'GETTING READY' : 'GUESSING'}</small></div><motion.strong key={`${player.score}-${player.ready}`} initial={{ scale: 1.45, color: '#ffd447' }} animate={{ scale: 1, color: '#f8f5ea' }}>{room.phase === 'lobby' && player.ready ? '✓' : player.score}</motion.strong>{player.id !== me?.id && <button className="player-report" aria-label={`Report ${player.name}`} title={`Report ${player.name}`} onClick={() => setReporting(player)}>!</button>}{me?.isHost && !player.isHost && <button className="player-kick" aria-label={`Remove ${player.name} from the arena`} title={`Remove ${player.name}`} onClick={() => kick(player.id, player.name)}>×</button>}</motion.div>)}</aside>
      <section className="stage">
        <div className="stage-hardware" aria-hidden="true"><i/><i/><i/><i/></div>
          {room.phase === 'lobby' ? <div className="waiting-stage"><div className="waiting-mascots" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><span>THE CALM BEFORE THE CHAOS</span><h2>{room.playerCount < 2 ? 'Round up the weirdos.' : 'Everybody’s here.'}</h2><p>{room.playerCount < 2 ? 'You need at least one willing victim before the show can start.' : me?.isHost ? 'You control the big red button.' : `Waiting for ${room.players.find((p) => p.isHost)?.name} to start.`}</p><div className="room-rules"><span>{room.roundSeconds}s per drawing</span><span>{room.matchRounds} drawings total</span><span>fair rotating turns</span></div>{inviteCode && <button className="invite-card" onClick={() => { void navigator.clipboard.writeText(`${location.origin}${location.pathname}?join=${inviteCode}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><small>PRIVATE INVITE LINK</small><b>{inviteCode}</b><span>{copied ? 'LINK COPIED!' : 'CLICK TO COPY & SHARE'}</span></button>}{!inviteCode && room.playerCount < 2 && <div className="waiting-tip"><b>TIP</b> Open this page on another device or invite a friend to join your public room.</div>}{me && !me.isHost && <button className={`ready-button ${me.ready ? 'is-ready' : ''}`} onClick={() => socket.emit('player:ready', { ready: !me.ready }, (ack) => !ack.ok && reportError(ack.error ?? 'Could not update ready state'))}>{me.ready ? '✓ READY TO PANIC' : 'I’M READY'}</button>}{me?.isHost && <button className="start-button" disabled={room.playerCount < 2} onClick={() => socket.emit('game:start', (ack) => !ack.ok && reportError(ack.error ?? 'Could not start the match'))}>START THE SHOW</button>}</div> : <>
          <div className="prompt-strip">{isDrawer ? <><small>YOUR PROMPT</small><b>{prompt || 'Stand by…'}</b></> : <><small>{drawer?.name ?? 'Someone'} IS DRAWING</small><b className="hint">{room.hints.join('')}</b></>}</div>
          <Canvas strokes={displayStrokes} active={connected && room.phase === 'drawing' && isDrawer} transportPointLimit={DRAW_LIMITS.maxPointsPerStroke} onPreview={(value) => socket.emit('draw:preview', value)} onStroke={stroke} onClear={() => { if (!connected) return; setDisplayStrokes([]); socket.emit('draw:clear'); }} onUndo={() => { if (!connected) return; setDisplayStrokes((items) => items.slice(0, -1)); socket.emit('draw:undo'); }}/>
          {room.phase === 'countdown' && <div className="countdown-cover"><small>NEXT ROUND</small><strong>{seconds || 'GO'}</strong><span>{me?.isDrawer ? 'YOUR HANDS ARE ABOUT TO SWEAT' : 'GET YOUR BAD GUESSES READY'}</span></div>}
          {room.phase === 'paused' && <div className="countdown-cover"><small>SEAT HELD</small><strong>HOLD</strong><span>Somebody dropped. We’ll resume the moment they’re back.</span></div>}
        </>}
      </section>
      <aside className={`guess-panel ${mobilePanel === 'chat' ? 'mobile-open' : ''}`}><div className="guess-title"><span>LIVE CHAOS</span><i>{feed.length}</i><button onClick={() => setMobilePanel('none')} aria-label="Close live chaos">×</button></div><div className="feed" aria-live="polite">{feed.slice(-30).map((item) => <motion.div className={`feed-item ${item.kind}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} key={item.id}>{item.playerName && <b>{item.playerName}</b>}<span>{item.text}</span>{item.points && <strong>+{item.points}</strong>}</motion.div>)}</div><div className="reactions">{['😂','🔥','💀','👏','🤯','❤️'].map((emoji) => <button disabled={!connected} aria-label={`React ${emoji}`} onClick={() => socket.emit('reaction:send', { emoji }, (ack) => !ack.ok && reportError(ack.error ?? 'Could not react'))} key={emoji}>{emoji}</button>)}</div><div className="guess-box"><input aria-label={!connected ? 'Reconnecting to the arena' : drawerChatLocked ? 'Chat locked while drawing' : 'Guess or chat'} value={text} disabled={!connected || drawerChatLocked} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} placeholder={!connected ? 'RECONNECTING…' : drawerChatLocked ? 'CHAT LOCKED WHILE YOU DRAW' : room.phase === 'drawing' && !me?.hasGuessed ? 'SHOUT YOUR GUESS…' : 'Say something…'}/><button aria-label="Send" disabled={!connected || drawerChatLocked} onClick={submit}>↑</button></div></aside>
    </div>
    {mobilePanel !== 'none' && <button className="mobile-scrim" onClick={() => setMobilePanel('none')} aria-label="Close game panel"/>}
    <nav className="mobile-game-dock" aria-label="Game panels"><button className={mobilePanel === 'players' ? 'active' : ''} onClick={() => setMobilePanel((value) => value === 'players' ? 'none' : 'players')}><span>♟</span><b>PLAYERS</b><i>{room.playerCount}</i></button><button className={mobilePanel === 'none' ? 'active canvas-tab' : 'canvas-tab'} onClick={() => setMobilePanel('none')}><span>✎</span><b>CANVAS</b></button><button className={mobilePanel === 'chat' ? 'active' : ''} onClick={() => setMobilePanel((value) => value === 'chat' ? 'none' : 'chat')}><span>!</span><b>CHAOS</b>{feed.length > 0 && <i>{Math.min(feed.length, 99)}</i>}</button></nav>
    {!connected && <div className="arena-reconnect" role="alert" aria-live="assertive"><div className="arena-reconnect-face"><ChaosFace variant={1}/></div><span>CONNECTION WOBBLE</span><b>HOLD THAT THOUGHT.</b><p>Your seat is reserved and live input is paused while we reconnect. Don’t refresh—the arena will resume automatically.</p><i aria-hidden="true"/></div>}
    <div className="reaction-bursts" aria-hidden="true">{feed.filter((item) => item.kind === 'reaction').slice(-4).map((item, index) => <motion.span key={item.id} initial={{ y: 80, opacity: 0, rotate: -12 }} animate={{ y: -40 - index * 42, opacity: [0, 1, 1, 0], rotate: 8 }} transition={{ duration: 2.2 }}>{item.text}</motion.span>)}</div>
    <AnimatePresence>{reveal && <Reveal result={reveal} mine={reveal.drawerId === me?.id} saved={savedRounds.includes(reveal.roundId)} keepRound={keepRound} reportError={reportError} close={() => setReveal(null)}/>}</AnimatePresence>
    <AnimatePresence>{reporting && <ReportPlayerModal player={reporting} close={() => setReporting(null)} submit={submitReport}/>}</AnimatePresence>
  </motion.main>;
}

function ReportPlayerModal({ player, close, submit }: { player: PlayerView; close: () => void; submit: (category: ModerationReportCategory, detail: string) => Promise<string> }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close); const [category, setCategory] = useState<ModerationReportCategory>('harassment'); const [detail, setDetail] = useState(''); const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle'); const [message, setMessage] = useState('');
  const send = async () => { if (detail.trim().length < 10) return; setStatus('sending'); setMessage(''); try { setMessage(await submit(category, detail)); setStatus('sent'); } catch (error) { setStatus('idle'); setMessage(error instanceof Error ? error.message : 'Could not send the report'); } };
  return <motion.div className="report-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.section ref={dialogRef} tabIndex={-1} className="report-sheet" role="dialog" aria-modal="true" aria-labelledby="report-title" initial={{ y: 30, scale: .94 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close report form">×</button><small>PRIVATE MESSAGE TO THE MOD TEAM</small><h2 id="report-title">REPORT {player.name.toUpperCase()}.</h2><p>This does not announce anything in the room. Tell us what happened; staff can see the room and both account IDs.</p>{status !== 'sent' ? <><label>WHAT HAPPENED?<select value={category} onChange={(event) => setCategory(event.target.value as ModerationReportCategory)}><option value="harassment">Harassment</option><option value="hate-or-threats">Hate or threats</option><option value="spam">Spam</option><option value="cheating">Cheating</option><option value="unsafe-art">Unsafe drawing</option><option value="other">Something else</option></select></label><label>DETAILS<textarea autoFocus value={detail} maxLength={500} onChange={(event) => setDetail(event.target.value)} placeholder="What did they do? Include enough detail for a human to review it."/></label><button className="primary" disabled={status === 'sending' || detail.trim().length < 10} onClick={() => void send()}>{status === 'sending' ? 'SENDING PRIVATELY…' : 'SEND REPORT →'}</button></> : <div className="report-sent"><b>✓ REPORT RECEIVED</b><p>{message}</p><span>Use the host remove control as well if somebody needs to leave immediately.</span></div>}{message && status !== 'sent' && <b className="promo-error">{message}</b>}<button className="text-button" onClick={close}>{status === 'sent' ? 'BACK TO THE GAME' : 'CANCEL'}</button></motion.section></motion.div>;
}

function useCountdown(deadline: number | null): number {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil(((deadline ?? Date.now()) - Date.now()) / 1000)));
  useEffect(() => {
    const calculate = () => Math.max(0, Math.ceil(((deadline ?? Date.now()) - Date.now()) / 1000));
    const update = () => setSeconds((previous) => { const next = calculate(); return next === previous ? previous : next; });
    update(); const timer = setInterval(update, 200);
    return () => clearInterval(timer);
  }, [deadline]);
  return seconds;
}

function useDialogFocus<T extends HTMLElement = HTMLElement>(open: boolean, close: () => void) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(close);
  useEffect(() => { closeRef.current = close; }, [close]);
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const priorOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = requestAnimationFrame(() => {
      const first = dialogRef.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
      (first ?? dialogRef.current)?.focus();
    });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])')].filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true');
      if (!focusable.length) { event.preventDefault(); dialogRef.current.focus(); return; }
      const first = focusable[0]!; const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      cancelAnimationFrame(focusTimer); document.removeEventListener('keydown', handleKey); document.body.style.overflow = priorOverflow;
      previousFocus?.focus();
    };
  }, [open]);
  return dialogRef;
}

function Reveal({ result, mine, saved, keepRound, reportError, close }: { result: RoundResult; mine: boolean; saved: boolean; keepRound: (roundId: string) => Promise<ArtworkDocument>; reportError: (message: string) => void; close: () => void }) {
  const fastest = [...result.correct].sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close);
  const [saving, setSaving] = useState(false);
  const wrongGuesses = result.funniestCandidates.filter((item) => item.kind === 'guess' || item.kind === 'close').slice(-3).reverse();
  const react = (emoji: '😂' | '🔥' | '💀' | '👏' | '🤯' | '❤️') => socket.emit('reaction:send', { emoji }, (ack) => !ack.ok && reportError(ack.error ?? 'Could not react'));
  const save = async () => {
    if (saved || saving) return;
    setSaving(true);
    try { await keepRound(result.roundId); }
    catch (error) { reportError(error instanceof Error ? error.message : 'Could not save this round'); }
    finally { setSaving(false); }
  };
  return <motion.div className="reveal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><div className="reveal-rays" aria-hidden="true"/><motion.div ref={dialogRef} tabIndex={-1} className="reveal-card reveal-card-v2" role="dialog" aria-modal="true" aria-labelledby="round-answer" initial={{ scale: .65, rotate: -3, y: 60 }} animate={{ scale: 1, rotate: 0, y: 0 }} transition={{ type: 'spring', damping: 15 }}><div className="reveal-copy"><span>THE WORD WAS</span><h2 className={result.prompt.length > 13 ? 'long-answer' : ''} id="round-answer">{result.prompt}</h2><p>Drawn under pressure by <b>{result.drawerName}</b></p><div className="round-awards"><div><small>FASTEST BRAIN</small><strong>{fastest?.playerName ?? 'Nobody'}</strong><em>{fastest ? `${(fastest.elapsedMs / 1000).toFixed(1)} seconds` : 'The drawing won'}</em></div><div><small>SUCCESS RATE</small><strong>{result.correct.length} got it</strong><em>{result.reason === 'all-guessed' ? 'Clean sweep' : 'Before the buzzer'}</em></div></div>{result.correct.length > 0 && <div className="round-solvers"><small>THEY CRACKED IT</small>{result.correct.map((solver, index) => <span key={solver.playerId}><i>{index + 1}</i><b>{solver.playerName}</b><strong>+{solver.points}</strong></span>)}</div>}{wrongGuesses.length > 0 && <div className="wrong-guess-reel"><small>THE ROOM ALSO SAID…</small>{wrongGuesses.map((guess) => <span key={guess.id}><b>{guess.playerName}</b> “{guess.text}”{guess.kind === 'close' && <em>SO CLOSE</em>}</span>)}</div>}<div className="reveal-reactions" aria-label="React to this drawing">{(['😂','🔥','💀','👏','🤯','❤️'] as const).map((emoji) => <button aria-label={`React ${emoji}`} onClick={() => react(emoji)} key={emoji}>{emoji}</button>)}</div>{mine && <><button className="keep-button" disabled={saved || saving} onClick={() => void save()}>{saving ? 'SAVING THE DISASTER…' : saved ? '✓ SAVED TO YOUR VAULT' : '★ KEEP THIS DISASTER'}</button>{saved && <div className="keep-confirmation" role="status">Safe. It will be waiting in your Vault after the match.</div>}</>}<button className="text-button" onClick={close}>WATCH THE CHAOS <small>NEXT ROUND SOON</small></button></div><div className="reveal-art"><span className="tape tape-a"/><span className="tape tape-b"/><Canvas strokes={result.strokes} active={false}/><small>AN ORIGINAL PANIC MASTERPIECE</small></div></motion.div></motion.div>;
}

function Afterparty({ match, savedRounds, keepRound, reportError, replay, vault, home }: { match: MatchResult; savedRounds: string[]; keepRound: (roundId: string) => Promise<ArtworkDocument>; reportError: (message: string) => void; replay: () => void; vault: () => void; home: () => void }) {
  const me = match.standings.find((player) => player.sessionId === sessionId);
  const [selectedRound, setSelectedRound] = useState<RoundResult | null>(null);
  const fastest = match.rounds.flatMap((round) => round.correct.map((guess) => ({ ...guess, prompt: round.prompt }))).sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  const hardest = [...match.rounds].sort((a, b) => a.correct.length - b.correct.length)[0];
  const wildGuess = match.rounds.flatMap((round) => round.funniestCandidates).filter((item) => item.kind === 'guess').at(-1);
  const championNames = match.winners.length ? match.winners.map((player) => player.name).join(' + ') : 'THE CHAOS';
  const championIds = new Set(match.winners.map((player) => player.id));
  const keep = (roundId: string, after?: () => void) => { void keepRound(roundId).then(() => after?.()).catch((error) => reportError(error instanceof Error ? error.message : 'Could not save that masterpiece')); };
  return <motion.main className="screen afterparty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="topbar"><Brand/><span>THE AFTERPARTY</span></header><section className="winner"><div className="winner-burst" aria-hidden="true">✦</div><small>{match.winners.length > 1 ? 'TONIGHT’S CO-CHAMPIONS' : 'TONIGHT’S CHAMPION'}</small><h1>{championNames}</h1><strong>{match.winner?.score ?? 0} POINTS</strong><em className="winner-rule">{match.tieBreak.label}</em></section><section className="podium" aria-label="Final standings">{match.standings.slice(0,3).map((player, index) => <motion.article className={`podium-place place-${index + 1}`} initial={{ y: 70, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: .15 + index * .1, type: 'spring' }} key={player.id}><span>{championIds.has(player.id) ? '♛' : index + 1}</span><Avatar seed={player.avatarSeed}/><b>{player.name}</b><strong>{player.score}</strong><small>POINTS</small></motion.article>)}</section><section className="match-recap" aria-label="Match highlights"><article><small>FASTEST BRAIN</small><b>{fastest?.playerName ?? 'Nobody'}</b><span>{fastest ? `${(fastest.elapsedMs / 1000).toFixed(1)}s on “${fastest.prompt}”` : 'The prompts won.'}</span></article><article><small>HARDEST WORD</small><b>{hardest?.prompt ?? 'Pure chaos'}</b><span>{hardest ? `${hardest.correct.length} solved it` : 'No rounds recorded'}</span></article><article><small>LAST WILD GUESS</small><b>{wildGuess?.text ?? 'Speechless'}</b><span>{wildGuess?.playerName ?? 'The room'}</span></article></section><div className="gallery-heading"><span>THE NIGHT’S MASTERPIECES</span><small>Every terrible line. Preserved forever.</small></div><section className="match-gallery">{match.rounds.map((round, index) => <motion.article initial={{ opacity: 0, y: 30, rotate: index % 2 ? 1.5 : -1.5 }} whileInView={{ opacity: 1, y: 0 }} key={round.roundId}><button className="gallery-open" onClick={() => setSelectedRound(round)} aria-label={`Open ${round.prompt} by ${round.drawerName}`}><Canvas strokes={round.strokes} active={false}/><span>OPEN MASTERPIECE ↗</span></button><small>{round.drawerName} tried to draw</small><h2>{round.prompt}</h2><span>{round.correct.length} guessed it</span>{round.drawerId === me?.id && <button className="gallery-save" disabled={savedRounds.includes(round.roundId)} onClick={() => keep(round.roundId)}>{savedRounds.includes(round.roundId) ? '✓ IN YOUR VAULT' : '★ KEEP THIS MOMENT'}</button>}</motion.article>)}</section><div className="after-actions">{me?.isHost ? <button className="primary" onClick={replay}>RUN IT BACK</button> : <span className="rematch-note">The host can bring this crew back for another round.</span>}<button onClick={home}>BACK TO LOBBY</button></div><AnimatePresence>{selectedRound && <MatchTrophy round={selectedRound} mine={selectedRound.drawerId === me?.id} saved={savedRounds.includes(selectedRound.roundId)} close={() => setSelectedRound(null)} keep={(after) => keep(selectedRound.roundId, after)} vault={vault} reportError={reportError}/>}</AnimatePresence></motion.main>;
}

function MatchTrophy({ round, mine, saved, close, keep, vault, reportError }: { round: RoundResult; mine: boolean; saved: boolean; close: () => void; keep: (after?: () => void) => void; vault: () => void; reportError: (message: string) => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close);
  const fastest = [...round.correct].sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  const download = () => { const url = URL.createObjectURL(new Blob([artworkSvg(round.prompt, round.strokes)], { type: 'image/svg+xml' })); const link = document.createElement('a'); link.href = url; link.download = `${round.prompt.replace(/[^a-z0-9]+/gi, '-') || 'panic-masterpiece'}.svg`; link.click(); URL.revokeObjectURL(url); };
  const react = (emoji: '😂' | '🔥' | '💀' | '👏' | '🤯' | '❤️') => socket.emit('reaction:send', { emoji }, (ack) => !ack.ok && reportError(ack.error ?? 'Could not react'));
  const openVault = () => saved ? vault() : keep(vault);
  return <motion.div className="trophy-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.div ref={dialogRef} tabIndex={-1} className="trophy-sheet" role="dialog" aria-modal="true" aria-labelledby="trophy-title" initial={{ y: 45, scale: .94, rotate: -1 }} animate={{ y: 0, scale: 1, rotate: 0 }} exit={{ y: 25, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close masterpiece">×</button><div className="trophy-art"><Canvas strokes={round.strokes} active={false}/><span>AN ORIGINAL PANIC MASTERPIECE</span></div><section><small>THE NIGHT’S MASTERPIECES</small><h2 id="trophy-title">{round.prompt}</h2><p><b>{round.drawerName}</b> drew this under pressure. {round.correct.length ? `${round.correct.length} player${round.correct.length === 1 ? '' : 's'} solved it${fastest ? `; ${fastest.playerName} was fastest at ${(fastest.elapsedMs / 1000).toFixed(1)} seconds` : ''}.` : 'The drawing defeated everybody.'}</p><div className="trophy-reactions" aria-label="React to this masterpiece">{(['😂','🔥','💀','👏','🤯','❤️'] as const).map((emoji) => <button aria-label={`React ${emoji}`} onClick={() => react(emoji)} key={emoji}>{emoji}</button>)}</div><div className="trophy-actions"><button onClick={download}>↓ DOWNLOAD SVG</button>{mine && <button className="primary" onClick={openVault}>{saved ? 'OPEN MINT VAULT →' : '★ SAVE & OPEN MINT VAULT →'}</button>}</div>{!mine && <div className="trophy-owner-note">Only the original drawer can save and mint this trophy. Everyone can download and react to the memory.</div>}</section></motion.div></motion.div>;
}

interface CanvasPreset { id: string; label: string; width: number; height: number; note: string; }
const CANVAS_PRESET_GROUPS: Array<{ label: string; presets: CanvasPreset[] }> = [
  { label: 'NFT + COLLECTIBLES', presets: [
    { id: 'studio-square', label: 'Studio square', width: 2400, height: 2400, note: 'Original format' },
    { id: 'nft-square', label: 'Square collectible', width: 3000, height: 3000, note: 'Universal NFT' },
    { id: 'nft-portrait', label: 'Portrait artwork', width: 3000, height: 4000, note: '3:4 edition' },
    { id: 'nft-landscape', label: 'Landscape artwork', width: 4000, height: 3000, note: '4:3 edition' },
    { id: 'nft-banner', label: 'Collection banner', width: 1400, height: 350, note: 'OpenSea header' },
    { id: 'nft-featured', label: 'Featured artwork', width: 1200, height: 800, note: 'Marketplace card' },
  ] },
  { label: 'DRAWING + SOCIAL', presets: [
    { id: 'social-square', label: 'Social square', width: 1080, height: 1080, note: 'Post + avatar' },
    { id: 'social-portrait', label: 'Portrait post', width: 1080, height: 1350, note: 'Instagram 4:5' },
    { id: 'social-story', label: 'Story / Reel', width: 1080, height: 1920, note: 'Vertical 9:16' },
    { id: 'social-wide', label: 'Wide social post', width: 1600, height: 900, note: 'X / LinkedIn' },
    { id: 'video-thumb', label: 'Video thumbnail', width: 1280, height: 720, note: 'YouTube 16:9' },
    { id: 'print-a4', label: 'A4 sketch', width: 2480, height: 3508, note: '300 DPI print' },
  ] },
];
const ALL_CANVAS_PRESETS = CANVAS_PRESET_GROUPS.flatMap((group) => group.presets);

function Studio({ back, vault }: { back: () => void; vault: () => void }) {
  const draft = useMemo(() => loadStudioDraft(), []);
  const [layers, setLayers] = useState<CanvasLayer[]>(draft.layers);
  const [activeLayerId, setActiveLayerId] = useState(draft.layers.at(-1)!.id);
  const [presetId, setPresetId] = useState(draft.presetId);
  const [title, setTitle] = useState(draft.title);
  const [status, setStatus] = useState('SAVED LOCALLY');
  const [darkUi, setDarkUi] = useState(() => localStorage.getItem('sketch-arena-studio-theme') === 'dark');
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'formats' | 'tools' | 'layers'>('none');
  const [confirmingNew, setConfirmingNew] = useState(false);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);
  const statusLockUntil = useRef(0);
  const preset = ALL_CANVAS_PRESETS.find((item) => item.id === presetId) ?? ALL_CANVAS_PRESETS[0]!;
  const activeLayer = layers.find((layer) => layer.id === activeLayerId) ?? layers[0]!;
  const visibleStrokes = layers.filter((layer) => layer.visible).flatMap((layer) => layer.strokes.map((stroke) => ({ ...stroke, opacity: (stroke.opacity ?? 1) * layer.opacity })));
  const strokeCount = layers.reduce((count, layer) => count + layer.strokes.length, 0);
  const canvasRatio: CanvasRatio = preset.width === preset.height ? 'square' : preset.width > preset.height ? 'landscape' : 'portrait';

  useEffect(() => {
    const savingFrame = requestAnimationFrame(() => { if (Date.now() >= statusLockUntil.current) setStatus('SAVING…'); });
    const timer = setTimeout(() => {
      localStorage.setItem('sketch-arena-studio-draft', JSON.stringify({ version: 2, title, layers, presetId, updatedAt: Date.now() }));
      if (Date.now() >= statusLockUntil.current) setStatus('SAVED LOCALLY');
    }, 250);
    return () => { cancelAnimationFrame(savingFrame); clearTimeout(timer); };
  }, [layers, presetId, title]);
  useEffect(() => { localStorage.setItem('sketch-arena-studio-theme', darkUi ? 'dark' : 'light'); }, [darkUi]);
  useEffect(() => {
    if (mobilePanel === 'none') return;
    const closePanel = (event: KeyboardEvent) => { if (event.key === 'Escape') setMobilePanel('none'); };
    document.addEventListener('keydown', closePanel);
    return () => document.removeEventListener('keydown', closePanel);
  }, [mobilePanel]);

  const updateActiveLayer = (change: (layer: CanvasLayer) => CanvasLayer) => setLayers((items) => items.map((layer) => layer.id === activeLayerId ? change(layer) : layer));
  const addLayer = () => {
    if (layers.length >= 12) return setStatus('12 LAYER LIMIT');
    const layer = { id: crypto.randomUUID(), name: `Layer ${layers.length + 1}`, strokes: [], visible: true, opacity: 1, locked: false, blendMode: 'normal' } satisfies CanvasLayer;
    setLayers((items) => [...items, layer]); setActiveLayerId(layer.id); setStatus('LAYER ADDED');
  };
  const deleteLayer = (id: string) => {
    if (layers.length === 1) return setStatus('KEEP AT LEAST ONE LAYER');
    const remaining = layers.filter((layer) => layer.id !== id); setLayers(remaining);
    if (activeLayerId === id) setActiveLayerId(remaining.at(-1)!.id);
  };
  const moveLayer = (id: string, direction: -1 | 1) => setLayers((items) => {
    const index = items.findIndex((layer) => layer.id === id); const target = index + direction;
    if (index < 0 || target < 0 || target >= items.length) return items;
    const next = [...items]; [next[index], next[target]] = [next[target]!, next[index]!]; return next;
  });
  const duplicateLayer = (id: string) => {
    if (layers.length >= 12) return setStatus('12 LAYER LIMIT');
    const source = layers.find((layer) => layer.id === id); if (!source) return;
    const copy = { ...source, id: crypto.randomUUID(), name: `${source.name} copy`, strokes: source.strokes.map((stroke) => ({ ...stroke, id: crypto.randomUUID() })) };
    const index = layers.indexOf(source); setLayers((items) => [...items.slice(0, index + 1), copy, ...items.slice(index + 1)]); setActiveLayerId(copy.id);
  };
  const translateActiveLayer = (x: number, y: number) => updateActiveLayer((layer) => ({ ...layer, strokes: layer.strokes.map((stroke) => ({ ...stroke, points: stroke.points.map((point) => ({ ...point, x: Math.max(0, Math.min(1, point.x + x)), y: Math.max(0, Math.min(1, point.y + y)) })) })) }));
  const renameLayer = (id: string, name: string) => setLayers((items) => items.map((layer) => layer.id === id ? { ...layer, name: name.slice(0, 28) } : layer));
  const isolateLayer = () => setLayers((items) => items.map((layer) => ({ ...layer, visible: layer.id === activeLayerId })));
  const showAllLayers = () => setLayers((items) => items.map((layer) => ({ ...layer, visible: true })));
  const choosePreset = (id: string) => { setPresetId(id); setStatus('CANVAS RESIZED • ART PRESERVED'); };
  const startFresh = () => {
    const layer = { id: crypto.randomUUID(), name: 'Ink layer', strokes: [], visible: true, opacity: 1, locked: false, blendMode: 'normal' } satisfies CanvasLayer;
    statusLockUntil.current = Date.now() + 1_500;
    setLayers([layer]); setActiveLayerId(layer.id); setTitle('Untitled chaos'); setRenamingLayerId(null); setMobilePanel('none');
    setConfirmingNew(false); setSavedNotice(null); setStatus('NEW CANVAS • READY');
    localStorage.removeItem('sketch-arena-storefront-package');
  };
  const requestNew = () => { if (strokeCount > 0) setConfirmingNew(true); else startFresh(); };

  const exportArtwork = () => {
    const blob = new Blob([artworkSvg(title, visibleStrokes, preset.width, preset.height)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${title.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sketch-arena-artwork'}-${preset.width}x${preset.height}.svg`;
    link.click(); URL.revokeObjectURL(url); setStatus('ARTWORK EXPORTED');
  };
  const prepare = async () => {
    statusLockUntil.current = Date.now() + 3_000;
    const vaultStrokes = normalizeArtworkStrokes(visibleStrokes, DRAW_LIMITS.maxPointsPerStroke);
    const packageData = { version: 2, ownerSessionId: sessionId, origin: 'studio', title, canvasRatio, width: preset.width, height: preset.height, strokes: vaultStrokes, layers, preparedAt: Date.now() };
    localStorage.setItem('sketch-arena-storefront-package', JSON.stringify(packageData)); setStatus('SAVING TO YOUR VAULT…');
    try {
      const response = await fetch('/api/artworks', { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionCredential}` }, body: JSON.stringify({ origin: 'studio', status: 'mint-ready', title: title.trim() || 'Untitled chaos', canvasRatio, width: preset.width, height: preset.height, strokes: vaultStrokes }) });
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Vault save failed');
      setStatus('VAULTED • STOREFRONT READY'); setSavedNotice(title.trim() || 'Untitled chaos');
    } catch { setStatus('VAULT SAVE FAILED • LOCAL COPY SAFE'); }
  };

  return <motion.main className={`screen studio studio-pro ${darkUi ? 'is-dark-ui' : ''} mobile-studio-${mobilePanel}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="studio-bar"><button onClick={back}>← EXIT STUDIO</button><input aria-label="Artwork title" value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)}/><div><button className="theme-toggle" onClick={() => setDarkUi((value) => !value)} title="Toggle studio panel theme">{darkUi ? '☀ LIGHT UI' : '◐ DARK UI'}</button><span>{status}</span><button className="studio-new" onClick={requestNew}>＋ NEW</button><button onClick={vault}>VAULT</button><button onClick={exportArtwork}>EXPORT SVG</button><button className="primary" onClick={prepare} title="Save a canonical artwork package to your local Vault">SAVE TO VAULT</button></div></header><div className="studio-workspace">
    <aside id="studio-format-panel" className="preset-sidebar" aria-label="Canvas formats"><span>CANVAS LIBRARY</span><h2>Pick your<br/>destination.</h2><p>Switch format anytime. Normalized strokes keep your artwork intact.</p>{CANVAS_PRESET_GROUPS.map((group) => <section className="preset-group" key={group.label}><h3>{group.label}</h3>{group.presets.map((item) => <button className={item.id === preset.id ? 'active' : ''} onClick={() => { choosePreset(item.id); setMobilePanel('none'); }} key={item.id}><span><b>{item.label}</b><small>{item.note}</small></span><em>{item.width} × {item.height}</em></button>)}</section>)}<div className="studio-stat"><small>STROKES</small><b>{strokeCount}</b></div><div className="studio-stat"><small>ACTIVE CANVAS</small><b>{preset.width} × {preset.height}</b></div></aside>
    <Canvas expert active strokes={visibleStrokes} layers={layers} activeLayerId={activeLayerId} activeLayerLocked={activeLayer.locked} width={preset.width} height={preset.height} onLayerTranslate={translateActiveLayer} onStroke={(stroke) => updateActiveLayer((layer) => ({ ...layer, strokes: [...layer.strokes, stroke] }))} onClear={() => updateActiveLayer((layer) => ({ ...layer, strokes: [] }))} onUndo={() => updateActiveLayer((layer) => ({ ...layer, strokes: layer.strokes.slice(0, -1) }))}/>
    <aside id="studio-layers-panel" className="layers pro-layers" aria-label="Artwork layers"><header><div><span>PRO LAYERS</span><b>{layers.length}/12</b></div><small>NON-DESTRUCTIVE STACK</small></header><div className="layer-list">{[...layers].reverse().map((layer) => <div className={`layer-row ${layer.id === activeLayerId ? 'active' : ''} ${layer.locked ? 'locked' : ''}`} key={layer.id}><button className="layer-visibility" onClick={() => setLayers((items) => items.map((item) => item.id === layer.id ? { ...item, visible: !item.visible } : item))} aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}>{layer.visible ? '◉' : '○'}</button><span className="layer-thumb" aria-hidden="true"/><div className="layer-name-cell">{renamingLayerId === layer.id ? <input autoFocus value={layer.name} maxLength={28} onChange={(event) => renameLayer(layer.id, event.target.value)} onBlur={() => setRenamingLayerId(null)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === 'Escape') setRenamingLayerId(null); }} aria-label={`Rename ${layer.name}`}/> : <button className="layer-select" onClick={() => setActiveLayerId(layer.id)} onDoubleClick={() => setRenamingLayerId(layer.id)}><b>{layer.name}</b><small>{layer.strokes.length} marks • {layer.blendMode}</small></button>}</div><button className="layer-rename" onClick={() => { setActiveLayerId(layer.id); setRenamingLayerId(layer.id); }} aria-label={`Rename ${layer.name}`} title="Rename layer">✎</button><button className={`layer-lock ${layer.locked ? 'active' : ''}`} onClick={() => setLayers((items) => items.map((item) => item.id === layer.id ? { ...item, locked: !item.locked } : item))} aria-label={`${layer.locked ? 'Unlock' : 'Lock'} ${layer.name}`}>{layer.locked ? '▣' : '□'}</button></div>)}</div><button className="add-layer" onClick={addLayer}>＋ Add layer</button>
    <div className="layer-quick-actions"><button onClick={isolateLayer}>SOLO</button><button onClick={showAllLayers}>SHOW ALL</button></div>
    <div className="layer-actions"><button onClick={() => moveLayer(activeLayerId, 1)} title="Move layer up">↑</button><button onClick={() => moveLayer(activeLayerId, -1)} title="Move layer down">↓</button><button onClick={() => duplicateLayer(activeLayerId)} title="Duplicate layer">⧉</button><button className={activeLayer.locked ? 'active' : ''} onClick={() => updateActiveLayer((layer) => ({ ...layer, locked: !layer.locked }))} title="Lock layer">▣</button><button className="trash-action" onClick={() => deleteLayer(activeLayerId)} title="Delete layer" aria-label="Delete active layer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5"/></svg></button></div>
    <label className="layer-blend">BLEND MODE<select value={activeLayer.blendMode} onChange={(event) => updateActiveLayer((layer) => ({ ...layer, blendMode: event.target.value as CanvasLayer['blendMode'] }))}><option value="normal">Normal</option><option value="multiply">Multiply</option><option value="screen">Screen</option><option value="overlay">Overlay</option><option value="darken">Darken</option><option value="lighten">Lighten</option></select></label>
    <label className="layer-opacity">ACTIVE LAYER OPACITY <b>{Math.round(activeLayer.opacity * 100)}%</b><input type="range" min="5" max="100" value={activeLayer.opacity * 100} onChange={(event) => updateActiveLayer((layer) => ({ ...layer, opacity: Number(event.target.value) / 100 }))}/></label>
    <div className="layer-readout"><span>{activeLayer.locked ? '▣ LOCKED' : '□ EDITABLE'}</span><span>{activeLayer.visible ? '◉ VISIBLE' : '○ HIDDEN'}</span></div><hr/><small>POWER MOVES</small><p>Double-click a name to rename</p><p>Blend modes + independent opacity</p><p>Move tool transforms the active layer</p><p>{preset.label} export ready</p></aside>
  </div>{savedNotice && <motion.aside className="studio-saved-notice" role="status" initial={{ opacity: 0, y: 18 }} animate={{ opacity: 1, y: 0 }}><button className="studio-notice-close" onClick={() => setSavedNotice(null)} aria-label="Dismiss saved artwork message">×</button><span>✓ SAFE IN YOUR VAULT</span><b>“{savedNotice}” is saved.</b><p>Keep polishing this one, or roll out a clean canvas.</p><div><button className="primary" onClick={startFresh}>＋ START FRESH</button><button onClick={vault}>OPEN VAULT</button></div></motion.aside>}{confirmingNew && <motion.div className="studio-new-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} onMouseDown={(event) => event.target === event.currentTarget && setConfirmingNew(false)}><motion.section role="dialog" aria-modal="true" aria-labelledby="studio-new-title" initial={{ scale: .9, y: 20 }} animate={{ scale: 1, y: 0 }}><span>FRESH SHEET, SAME CHAOS</span><h2 id="studio-new-title">Start a new artwork?</h2><p>Your current draft has {strokeCount} mark{strokeCount === 1 ? '' : 's'}. Save it to the Vault first if you want to keep it.</p><div><button onClick={() => setConfirmingNew(false)}>KEEP DRAWING</button><button className="danger" onClick={startFresh}>CLEAR & START NEW</button></div></motion.section></motion.div>}{mobilePanel !== 'none' && <button className="mobile-studio-scrim" onClick={() => setMobilePanel('none')} aria-label="Close Studio panel"/>}<nav className="mobile-studio-dock" aria-label="Studio panels"><button className={mobilePanel === 'formats' ? 'active' : ''} aria-expanded={mobilePanel === 'formats'} aria-controls="studio-format-panel" onClick={() => setMobilePanel((value) => value === 'formats' ? 'none' : 'formats')}><span>▣</span><b>FORMAT</b></button><button className={mobilePanel === 'tools' ? 'active' : ''} aria-expanded={mobilePanel === 'tools'} aria-controls="studio-expert-panel" onClick={() => setMobilePanel((value) => value === 'tools' ? 'none' : 'tools')}><span>✎</span><b>BRUSH</b></button><button className={mobilePanel === 'none' ? 'active' : ''} onClick={() => setMobilePanel('none')}><span>◉</span><b>CANVAS</b></button><button className={mobilePanel === 'layers' ? 'active' : ''} aria-expanded={mobilePanel === 'layers'} aria-controls="studio-layers-panel" onClick={() => setMobilePanel((value) => value === 'layers' ? 'none' : 'layers')}><span>⧉</span><b>LAYERS</b><i>{layers.length}</i></button></nav></motion.main>;
}

function Vault({ back, studio }: { back: () => void; studio: () => void }) {
  const [items, setItems] = useState<ArtworkDocument[]>([]); const [loading, setLoading] = useState(true); const [mintItem, setMintItem] = useState<ArtworkDocument | null>(null); const [recoveryOpen, setRecoveryOpen] = useState(false);
  useEffect(() => { fetch('/api/artworks', { headers: { authorization: `Bearer ${sessionCredential}` } }).then((response) => response.ok ? response.json() : Promise.reject()).then(setItems).catch(() => setItems([])).finally(() => setLoading(false)); }, []);
  const download = (item: ArtworkDocument) => { const url = URL.createObjectURL(new Blob([artworkSvg(item.title, item.strokes)], { type: 'image/svg+xml' })); const link = document.createElement('a'); link.href = url; link.download = `${item.title.replace(/[^a-z0-9]+/gi, '-') || 'artwork'}.svg`; link.click(); URL.revokeObjectURL(url); };
  return <motion.main className="screen vault" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="topbar"><Brand/><button onClick={back}>← BACK TO LOBBY</button></header><section className="vault-hero"><span>YOUR SAVED MASTERPIECES</span><h1>ARTWORK<br/><em>VAULT.</em></h1><p>Keep the rounds worth remembering. When one becomes legendary, archive it forever inside Sketch Arena: The Panic Archive.</p><div className="vault-hero-actions"><button className="primary" onClick={studio}>＋ CREATE IN STUDIO</button><button className="vault-recovery-button" onClick={() => setRecoveryOpen(true)}>▣ BACK UP / RESTORE VAULT</button><span>FIRST MINT FREE · THEN THE SET ARENA FEE + GAS</span></div></section><section className="vault-grid">{loading && <div className="vault-empty">OPENING THE VAULT…</div>}{!loading && !items.length && <div className="vault-empty"><ChaosFace variant={1}/><h2>Beautifully empty.</h2><p>Keep a round drawing or save a Studio piece and it will appear here.</p><button onClick={studio}>MAKE THE FIRST ONE →</button></div>}{items.map((item) => <article className={`vault-card ${item.status === 'minted' ? 'is-minted' : ''}`} key={item.id}><div className="vault-art"><Canvas strokes={item.strokes} active={false}/><span>{item.status === 'minted' ? `PANIC #${item.mint?.tokenId ?? '?'}` : item.origin === 'arena' ? 'PANIC ORIGINAL' : 'STUDIO ORIGINAL'}</span></div><small>{new Date(item.createdAt).toLocaleDateString()} • {item.status.replace('-', ' ')}</small><h2>{item.title}</h2><div><button onClick={() => download(item)}>EXPORT SVG</button>{item.status === 'minted' && item.mint?.marketplaceUrl ? <a href={item.mint.marketplaceUrl} target="_blank" rel="noreferrer">VIEW TROPHY ↗</a> : <button className="mint-moment" onClick={() => setMintItem(item)}>✦ MINT THIS MOMENT</button>}</div></article>)}</section><AnimatePresence>{mintItem && <MintMoment item={mintItem} close={() => setMintItem(null)} confirmed={(mint) => setItems((current) => current.map((item) => item.id === mintItem.id ? { ...item, status: 'minted', mint: { network: 'shido', status: 'confirmed', walletAddress: mint.walletAddress, contractAddress: mint.contractAddress, tokenURI: mint.tokenURI, tokenId: mint.tokenId, transactionHash: mint.transactionHash, marketplaceUrl: mint.marketplaceUrl } } : item))}/>} {recoveryOpen && <VaultRecovery close={() => setRecoveryOpen(false)}/>}</AnimatePresence></motion.main>;
}

function VaultRecovery({ close }: { close: () => void }) {
  const [revealed, setRevealed] = useState(false); const [restoreKey, setRestoreKey] = useState(''); const [armed, setArmed] = useState(false); const [message, setMessage] = useState('');
  const [account, setAccount] = useState<PlayerAccountInfo | null>(null); const [securing, setSecuring] = useState(false);
  const [devices, setDevices] = useState<DeviceSessionInfo[]>([]);
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close);
  useEffect(() => { void Promise.all([accountStatus(), listDeviceSessions().catch(() => [])]).then(([current, sessions]) => { setAccount(current); setDevices(sessions); }); }, []);
  const recoveryCode = `SKETCH-VAULT-V1-${sessionCredential.toUpperCase()}`;
  const copy = async () => { try { await navigator.clipboard.writeText(recoveryCode); setMessage('Recovery key copied. Store it somewhere private.'); } catch { setMessage('Clipboard access failed. Reveal the key and copy it manually.'); } };
  const download = () => { const url = URL.createObjectURL(new Blob([`Sketch Arena Vault Recovery\n\n${recoveryCode}\n\nKeep this private. Anyone with this key can open this local player Vault.\n`], { type: 'text/plain' })); const link = document.createElement('a'); link.href = url; link.download = 'sketch-arena-vault-recovery.txt'; link.click(); URL.revokeObjectURL(url); setMessage('Recovery file downloaded. Keep it private.'); };
  const parsedRestoreKey = restoreKey.trim().replace(/^SKETCH-VAULT-V1-/i, '').toLowerCase();
  const validRestore = /^[0-9a-f]{64}$/.test(parsedRestoreKey);
  const secure = async () => { setSecuring(true); setMessage(''); try { const secured = await secureAccountWithPasskey('Sketch Arena passkey'); setAccount(secured); setMessage('Passkey added. This Vault can now follow you to another device.'); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Passkey setup failed'); } finally { setSecuring(false); } };
  const revokeDevice = async (device: DeviceSessionInfo) => { try { await revokeDeviceSession(device.id); setDevices((current) => current.filter((item) => item.id !== device.id)); setMessage(`${device.label} has been signed out.`); } catch (reason) { setMessage(reason instanceof Error ? reason.message : 'Could not sign that device out'); } };
  const restore = async () => { if (!validRestore) return setMessage('That recovery key is not valid.'); if (!armed) { setArmed(true); setMessage('One more click will replace this browser’s current Vault identity. Back it up first if you need it.'); return; } await fetch('/api/account/logout', { method: 'POST', credentials: 'include' }).catch(() => undefined); sessionCredential = parsedRestoreKey; localStorage.setItem('arena-credential', sessionCredential); localStorage.removeItem('arena-session'); location.reload(); };
  return <motion.div className="recovery-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.div ref={dialogRef} tabIndex={-1} className="recovery-sheet" role="dialog" aria-modal="true" aria-labelledby="recovery-title" initial={{ y: 35, scale: .95 }} animate={{ y: 0, scale: 1 }} exit={{ y: 20, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close Vault recovery">×</button><div className="recovery-weirdo"><ChaosFace variant={1}/><span>KEEP THIS ONE SAFE.</span></div><small>PRIVATE PLAYER IDENTITY</small><h2 id="recovery-title">YOUR VAULT<br/>RECOVERY KEY.</h2><p>Your artwork, rewards, Battle Pass and wallet binding are attached to this account. A passkey is the easiest safe way to bring it to another device.</p><section className={`passkey-security ${account?.secured ? 'is-secured' : ''}`}><b>{account?.secured ? '✓ ACCOUNT SECURED' : 'SECURE THIS ACCOUNT'}</b><p>{account?.secured ? `${account.passkeyCount ?? 1} passkey${(account.passkeyCount ?? 1) === 1 ? '' : 's'} connected. Your private recovery key still works as an emergency backup.` : 'Use Face ID, Touch ID, Windows Hello or your phone. No password and no wallet pop-up.'}</p><button disabled={securing} onClick={() => void secure()}>{securing ? 'ASKING YOUR DEVICE…' : account?.secured ? '＋ ADD ANOTHER PASSKEY' : 'ADD A PASSKEY →'}</button>{devices.length > 0 && <div className="device-sessions"><small>SIGNED-IN DEVICES</small>{devices.map((device) => <div key={device.id}><span><b>{device.label}</b><small>{device.current ? 'THIS DEVICE' : `SEEN ${new Date(device.lastSeenAt).toLocaleDateString()}`}</small></span>{!device.current && <button onClick={() => void revokeDevice(device)}>SIGN OUT</button>}</div>)}</div>}</section><section className="recovery-backup"><b>EMERGENCY RECOVERY KEY</b><code>{revealed ? recoveryCode : `SKETCH-VAULT-V1-${'•'.repeat(32)}`}</code><div><button onClick={() => setRevealed((value) => !value)}>{revealed ? 'HIDE KEY' : 'REVEAL KEY'}</button><button onClick={() => void copy()}>COPY KEY</button><button onClick={download}>DOWNLOAD FILE</button></div></section><section className="recovery-restore"><b>RESTORE WITH A RECOVERY KEY</b><p>This signs this browser out of its current Vault, then opens the recovered one. It does not delete either account.</p><textarea value={restoreKey} onChange={(event) => { setRestoreKey(event.target.value); setArmed(false); setMessage(''); }} placeholder="Paste SKETCH-VAULT-V1-…"/><button className={armed ? 'danger' : ''} disabled={!validRestore} onClick={() => void restore()}>{armed ? 'CONFIRM: OPEN THAT VAULT' : 'CHECK RECOVERY KEY →'}</button></section>{message && <div className="recovery-message" role="status">{message}</div>}<small className="recovery-warning">NEVER SHARE THIS KEY IN CHAT. SKETCH ARENA STAFF WILL NEVER ASK FOR IT.</small></motion.div></motion.div>;
}

function PanicArchive({ back }: { back: () => void }) {
  const [items, setItems] = useState<PanicArchiveItem[]>([]);
  const [mintStatus, setMintStatus] = useState<MintStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<'all' | 'arena' | 'studio'>('all');
  const [selected, setSelected] = useState<PanicArchiveItem | null>(null);
  const [shareLabel, setShareLabel] = useState('COPY ARCHIVE LINK');
  const detailRef = useDialogFocus(Boolean(selected), () => setSelected(null));
  useEffect(() => {
    Promise.all([fetch('/api/archive?limit=100').then((response) => response.ok ? response.json() as Promise<{ items: PanicArchiveItem[] }> : Promise.reject()), fetch('/api/mint/status').then((response) => response.ok ? response.json() as Promise<MintStatusResponse> : Promise.reject())])
      .then(([archive, status]) => { setItems(archive.items); setMintStatus(status); const requested = new URLSearchParams(location.search).get('panic'); if (requested) setSelected(archive.items.find((item) => item.tokenId === requested) ?? null); })
      .catch(() => setFailed(true)).finally(() => setLoading(false));
  }, []);
  const visible = useMemo(() => filter === 'all' ? items : items.filter((item) => item.origin === filter), [filter, items]);
  const inspect = (item: PanicArchiveItem) => { setSelected(item); setShareLabel('COPY ARCHIVE LINK'); history.replaceState({}, '', `/archive?panic=${encodeURIComponent(item.tokenId)}`); };
  const closeDetail = () => { setSelected(null); history.replaceState({}, '', '/archive'); };
  const copyLink = async () => { if (!selected) return; await navigator.clipboard.writeText(`${location.origin}/archive?panic=${encodeURIComponent(selected.tokenId)}`); setShareLabel('✓ LINK COPIED'); };
  const explorerUrl = selected && mintStatus?.blockExplorerUrl ? `${mintStatus.blockExplorerUrl.replace(/\/$/, '')}/tx/${selected.transactionHash}` : undefined;
  return <motion.main className="screen panic-archive" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <header className="archive-nav"><Brand/><button onClick={back}>← BACK TO THE ARENA</button></header>
    <section className="archive-hero"><div className="archive-weirdos" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><span>SKETCH ARENA PRESENTS</span><h1>THE PANIC<br/><em>ARCHIVE.</em></h1><p>One permanent collection of glorious bad decisions. Every piece here survived the arena, reached the chain, and earned a place in Season 0: The First Mess.</p><div className="archive-ledger"><span><b>{items.length}</b> CONFIRMED TROPHIES</span><span><b>01</b> PERMANENT COLLECTION</span><span><b>∞</b> QUESTIONABLE LINES</span></div></section>
    <section className="archive-controls"><div><span>SEASON 0</span><b>THE FIRST MESS</b></div><div role="group" aria-label="Filter archive"><button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>ALL</button><button className={filter === 'arena' ? 'active' : ''} onClick={() => setFilter('arena')}>ARENA</button><button className={filter === 'studio' ? 'active' : ''} onClick={() => setFilter('studio')}>STUDIO</button></div></section>
    <section className="archive-grid" aria-live="polite">{loading && <div className="archive-empty"><b>OPENING THE ARCHIVE…</b><span>Dusting off the permanent record.</span></div>}{failed && <div className="archive-empty"><ChaosFace variant={1}/><b>THE ARCHIVIST FAINTED.</b><span>The public ledger could not be loaded. Try again in a moment.</span></div>}{!loading && !failed && !visible.length && <div className="archive-empty"><div className="archive-empty-faces"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><b>{items.length ? 'NO TROPHIES IN THIS WING YET.' : 'THE FIRST PLINTH IS WAITING.'}</b><span>{items.length ? 'Try another collection filter.' : 'Only confirmed on-chain mints appear here. No placeholders. No fake activity.'}</span></div>}{visible.map((item, index) => <motion.article className="archive-card" key={item.id} initial={{ opacity: 0, y: 24, rotate: index % 2 ? .5 : -.5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: Math.min(index * .035, .35) }}><button className="archive-art" onClick={() => inspect(item)} aria-label={`Inspect Panic ${item.tokenId}: ${item.title}`}><Canvas strokes={item.strokes} active={false}/><span>PANIC #{item.tokenId}</span><i>{item.origin === 'arena' ? 'LIVE ARENA' : 'SOLO STUDIO'}</i></button><div><small>SEASON 0 · MINTED {new Date(item.mintedAt).toLocaleDateString()}</small><h2>{item.title}</h2><button onClick={() => inspect(item)}>OPEN THE RECEIPT →</button></div></motion.article>)}</section>
    <AnimatePresence>{selected && <motion.div className="archive-detail-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && closeDetail()}><motion.article ref={detailRef} tabIndex={-1} className="archive-detail" role="dialog" aria-modal="true" aria-labelledby="archive-detail-title" initial={{ y: 35, scale: .96 }} animate={{ y: 0, scale: 1 }} exit={{ y: 25, opacity: 0 }}><button className="archive-detail-close" onClick={closeDetail} aria-label="Close artwork receipt">×</button><div className="archive-detail-art"><Canvas strokes={selected.strokes} active={false}/><span>CHAIN CONFIRMED</span></div><section><small>SKETCH ARENA: THE PANIC ARCHIVE</small><h2 id="archive-detail-title">{selected.title}</h2><div className="archive-token">PANIC #{selected.tokenId}</div>{selected.description && <p>{selected.description}</p>}<dl><div><dt>SEASON</dt><dd>0 · {selected.seasonName}</dd></div><div><dt>ORIGIN</dt><dd>{selected.origin === 'arena' ? 'Live Arena round' : 'Solo Studio'}</dd></div><div><dt>CANVAS</dt><dd>{selected.width} × {selected.height}</dd></div><div><dt>CONTRACT</dt><dd>{selected.contractAddress.slice(0, 8)}…{selected.contractAddress.slice(-6)}</dd></div><div><dt>TRANSACTION</dt><dd>{selected.transactionHash.slice(0, 10)}…{selected.transactionHash.slice(-8)}</dd></div><div><dt>METADATA</dt><dd>Permanent IPFS record</dd></div></dl><div className="archive-proof-actions">{selected.marketplaceUrl && <a href={selected.marketplaceUrl} target="_blank" rel="noreferrer">VIEW ON MARKETPLACE ↗</a>}{explorerUrl && <a href={explorerUrl} target="_blank" rel="noreferrer">VERIFY ON CHAIN ↗</a>}<button onClick={() => void copyLink()}>{shareLabel}</button></div><p className="archive-proof-note">This gallery lists confirmed contract events only. Marketplace availability is shown only when an exact approved token URL is configured.</p></section></motion.article></motion.div>}</AnimatePresence>
  </motion.main>;
}

type EthereumProvider = { request(input: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown> };
type MintStatusResponse = { enabled: boolean; contractControlsEnabled: boolean; collection: string; season: string; chainId?: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; blockExplorerUrl?: string; standardPriceUsd: string; paymentToken?: { address: `0x${string}`; name: string; symbol: string; decimals: number }; firstMintFree: boolean };

function injectedWallet(): EthereumProvider | null { return (window as Window & { ethereum?: EthereumProvider }).ethereum ?? null; }
async function ensureWalletChain(provider: EthereumProvider, chain: { chainId: number; chainName: string; nativeCurrency: { name: string; symbol: string; decimals: number }; rpcUrls: string[]; blockExplorerUrl?: string }): Promise<void> {
  const chainHex = `0x${chain.chainId.toString(16)}`;
  try { await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainHex }] }); }
  catch (error) {
    const code = typeof error === 'object' && error && 'code' in error ? Number((error as { code: unknown }).code) : 0; if (code !== 4902) throw error;
    await provider.request({ method: 'wallet_addEthereumChain', params: [{ chainId: chainHex, chainName: chain.chainName, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls, blockExplorerUrls: chain.blockExplorerUrl ? [chain.blockExplorerUrl] : undefined }] });
  }
}
function allowanceCall(owner: string, spender: string): `0x${string}` { return `0xdd62ed3e${owner.slice(2).padStart(64, '0')}${spender.slice(2).padStart(64, '0')}` as `0x${string}`; }
async function waitForWalletReceipt(provider: EthereumProvider, hash: string, action = 'WSHIDO approval'): Promise<{ status?: string; contractAddress?: string }> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const receipt = await provider.request({ method: 'eth_getTransactionReceipt', params: [hash] }) as { status?: string; contractAddress?: string } | null;
    if (receipt) { if (receipt.status && BigInt(receipt.status) === 0n) throw new Error(`${action} was rejected by the network.`); return receipt; }
    await new Promise((resolve) => window.setTimeout(resolve, 1_500));
  }
  throw new Error(`${action} is still pending. Check your wallet or the block explorer before trying again.`);
}
async function responseJson<T>(response: Response): Promise<T> { const body = await response.json() as T & { error?: string }; if (!response.ok) throw new Error(body.error || 'The request could not be completed'); return body; }
function MintMoment({ item, close, confirmed }: { item: ArtworkDocument; close: () => void; confirmed: (mint: MintPreparation) => void }) {
  const dialogRef = useDialogFocus<HTMLDivElement>(true, close); const [service, setService] = useState<MintStatusResponse | null>(null); const [phase, setPhase] = useState<'checking' | 'ready' | 'connecting' | 'prepared' | 'approving' | 'sending' | 'pending' | 'failed' | 'success' | 'unavailable'>('checking');
  const [mint, setMint] = useState<MintPreparation | null>(null); const [message, setMessage] = useState('Checking the archive machinery…');
  const activeRef = useRef(true); const confirmationTimerRef = useRef<number | null>(null); const preparingRef = useRef(false); const submittingRef = useRef(false);
  useEffect(() => () => { activeRef.current = false; if (confirmationTimerRef.current !== null) window.clearTimeout(confirmationTimerRef.current); }, []);
  const pollConfirmation = useCallback(async function poll(prepared: MintPreparation, transactionHash: string, attempt: number): Promise<void> {
    if (!activeRef.current) return;
    try {
      const result = await responseJson<{ mint: MintPreparation; pending: boolean }>(await fetch(`/api/mints/${prepared.id}/confirm`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${sessionCredential}` }, body: JSON.stringify({ transactionHash }) }));
      if (!activeRef.current) return;
      setMint(result.mint);
      if (!result.pending && result.mint.status === 'confirmed') { setPhase('success'); setMessage(`Panic #${result.mint.tokenId} is permanently yours.`); confirmed(result.mint); gameAudio.play('mint-success'); return; }
      if (!result.pending) { submittingRef.current = false; setPhase('failed'); setMessage(result.mint.error || 'The chain rejected this mint. Your Mint Credit was not spent.'); return; }
      if (attempt < 60) confirmationTimerRef.current = window.setTimeout(() => void poll(result.mint, transactionHash, attempt + 1), 3_000); else setMessage('Still pending on Shido. It is safe to close this—your Vault will keep tracking the transaction.');
    } catch (error) { if (!activeRef.current) return; if (attempt < 60) confirmationTimerRef.current = window.setTimeout(() => void poll(prepared, transactionHash, attempt + 1), 4_000); else { submittingRef.current = false; setMessage(walletError(error)); } }
  }, [confirmed]);
  useEffect(() => { Promise.all([fetch('/api/mint/status').then((response) => responseJson<MintStatusResponse>(response)), fetch(`/api/artworks/${item.id}/mint`, { headers: { authorization: `Bearer ${sessionCredential}` } }).then((response) => response.ok ? response.json() as Promise<MintPreparation> : null)])
    .then(([status, existing]) => { setService(status); if (!status.enabled) { setPhase('unavailable'); setMessage('The Panic Archive is built, but minting stays locked until the reviewed contract is deployed and connected.'); return; }
      if (existing?.status === 'confirmed') { setMint(existing); setPhase('success'); setMessage(`Panic #${existing.tokenId} is permanently yours.`); return; }
      if (existing?.status === 'submitted' && existing.transactionHash) { setMint(existing); setPhase('pending'); setMessage('Your transaction is still being confirmed on Shido.'); void pollConfirmation(existing, existing.transactionHash, 0); return; }
      if (existing?.status === 'prepared' && existing.expiresAt > Date.now()) { setMint(existing); setPhase('prepared'); setMessage(existing.usesMintCredit ? 'Mint Credit reserved. The Sketch Arena fee is $0; only network gas remains.' : existing.discountBps ? `${existing.discountBps / 100}% promo discount applied. Your signed voucher contains the reduced price.` : 'Your signed voucher is ready for your wallet.'); return; }
      setPhase('ready'); setMessage('Your wallet stays out of the game until this moment.'); })
    .catch(() => { setPhase('unavailable'); setMessage('The archive machinery is not reachable right now. Your artwork is still safe.'); }); }, [item.id, pollConfirmation]);
  const connectAndPrepare = async () => {
    if (preparingRef.current) return;
    const provider = injectedWallet(); if (!provider) return setMessage('Install or open an EVM wallet to mint. You can keep playing without one.');
    preparingRef.current = true;
    setPhase('connecting'); setMessage('Ask your wallet to prove this Vault belongs to you. No gas. No transaction.');
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' }) as string[]; const address = accounts[0]; if (!address) throw new Error('No wallet account was selected');
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${sessionCredential}` };
      const wallet = await responseJson<{ binding: { address: string } | null }>(await fetch('/api/wallet', { headers: { authorization: `Bearer ${sessionCredential}` } }));
      if (wallet.binding?.address.toLowerCase() !== address.toLowerCase()) {
        const challenge = await responseJson<{ challengeId: string; message: string }>(await fetch('/api/wallet/challenge', { method: 'POST', headers, body: JSON.stringify({ address }) }));
        const signature = await provider.request({ method: 'personal_sign', params: [challenge.message, address] });
        await responseJson(await fetch('/api/wallet/verify', { method: 'POST', headers, body: JSON.stringify({ challengeId: challenge.challengeId, address, signature }) }));
      }
      const prepared = await responseJson<MintPreparation>(await fetch(`/api/artworks/${item.id}/mint/prepare`, { method: 'POST', headers }));
      setMint(prepared); setPhase('prepared'); setMessage(prepared.usesMintCredit ? 'Mint Credit found. The Sketch Arena fee is $0; only network gas remains.' : prepared.discountBps ? `${prepared.discountBps / 100}% promo discount applied. Your wallet will show the reduced fee and network gas.` : 'Voucher ready. Your wallet will show the exact Arena fee and network gas before anything happens.');
    } catch (error) { setPhase('ready'); setMessage(walletError(error)); }
    finally { preparingRef.current = false; }
  };
  const submit = async () => {
    if (submittingRef.current) return;
    const provider = injectedWallet(); if (!provider || !mint || !service?.chainId) return;
    submittingRef.current = true;
    setPhase('sending'); setMessage('Opening your wallet with the exact signed voucher…');
    try {
      await ensureWalletChain(provider, mint);
      if (BigInt(mint.voucher.price) > 0n && mint.approvalRequest) {
        const allowanceHex = await provider.request({ method: 'eth_call', params: [{ to: mint.paymentToken.address, data: allowanceCall(mint.walletAddress, mint.contractAddress) }, 'latest'] }) as string;
        if (BigInt(allowanceHex) < BigInt(mint.voucher.price)) {
          setPhase('approving'); setMessage('Approve this exact WSHIDO amount first. This does not mint or charge you yet.');
          const approvalHash = await provider.request({ method: 'eth_sendTransaction', params: [mint.approvalRequest] }) as string;
          await waitForWalletReceipt(provider, approvalHash);
          setPhase('sending'); setMessage('WSHIDO approved. Now confirm the mint itself…');
        }
      }
      const transactionHash = await provider.request({ method: 'eth_sendTransaction', params: [mint.transactionRequest] }) as string;
      const submitted = { ...mint, status: 'submitted' as const, transactionHash: transactionHash as `0x${string}` }; setMint(submitted); setPhase('pending'); setMessage('The network has it. You can leave this open while Shido confirms the trophy.');
      void pollConfirmation(submitted, transactionHash, 0);
    } catch (error) { submittingRef.current = false; setPhase('prepared'); setMessage(walletError(error)); }
  };
  const payableUsd = mint?.priceQuote ? mint.priceQuote.usdCents * (10_000 - (mint.discountBps ?? 0)) / 1_000_000 : 0;
  const priceLabel = mint ? mint.usesMintCredit ? 'FREE WITH MINT CREDIT' : `${formatNative(mint.voucher.price, mint.paymentToken.decimals)} ${mint.paymentToken.symbol} · ≈ $${payableUsd.toFixed(2)}` : '';
  return <motion.div className="mint-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && close()}><motion.div ref={dialogRef} tabIndex={-1} className="mint-sheet" role="dialog" aria-modal="true" aria-labelledby="mint-title" initial={{ y: 45, scale: .93, rotate: -1 }} animate={{ y: 0, scale: 1, rotate: 0 }} exit={{ y: 30, opacity: 0 }}><button className="setup-close" onClick={close} aria-label="Close minting">×</button><div className="mint-preview"><Canvas strokes={item.strokes} active={false}/><span>SEASON 0 · THE FIRST MESS</span></div><section><div className="loot-weirdos" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><small>SKETCH ARENA: THE PANIC ARCHIVE</small><h2 id="mint-title">MINT THIS<br/>MOMENT.</h2><h3>{item.title}</h3><p>{message}</p>{mint && <div className="mint-receipt"><span><small>ARENA FEE</small><b>{priceLabel}</b></span><span><small>WALLET</small><b>{mint.walletAddress.slice(0, 6)}…{mint.walletAddress.slice(-4)}</b></span><span><small>STORAGE</small><b>PINNED TO IPFS</b></span></div>}{phase === 'unavailable' && <div className="mint-safety"><b>YOUR DRAWING IS SAFE</b><span>No fake mint button, no mystery transaction and no temporary URL. This unlocks only when the real infrastructure is ready.</span></div>}{phase === 'ready' && <button className="primary mint-cta" onClick={() => void connectAndPrepare()}>CONNECT WALLET & PREPARE →</button>}{phase === 'connecting' && <button className="primary mint-cta" disabled>CHECK YOUR WALLET…</button>}{phase === 'prepared' && <button className="primary mint-cta" onClick={() => void submit()}>CONFIRM IN WALLET →</button>}{phase === 'failed' && <button className="primary mint-cta" onClick={() => void connectAndPrepare()}>PREPARE A FRESH VOUCHER →</button>}{(phase === 'approving' || phase === 'sending' || phase === 'pending') && <button className="primary mint-cta" disabled>{phase === 'approving' ? 'APPROVING WSHIDO…' : phase === 'sending' ? 'OPENING WALLET…' : 'CONFIRMING ON SHIDO…'}</button>}{phase === 'success' && <div className="mint-success"><b>✦ PANIC #{mint?.tokenId} ARCHIVED</b>{mint?.marketplaceUrl && <a href={mint.marketplaceUrl} target="_blank" rel="noreferrer">SEE IT IN THE STOREFRONT ↗</a>}</div>}<button className="text-button" onClick={close}>{phase === 'success' ? 'BACK TO YOUR VAULT' : 'NOT NOW — KEEP PLAYING'}</button></section></motion.div></motion.div>;
}

function formatNative(value: string, decimals: number): string { const padded = value.padStart(decimals + 1, '0'); const whole = padded.slice(0, -decimals) || '0'; const fraction = padded.slice(-decimals).replace(/0+$/, '').slice(0, 6); return fraction ? `${whole}.${fraction}` : whole; }

function loadStudioDraft(): { title: string; layers: CanvasLayer[]; presetId: string } {
  const fallback = (): CanvasLayer => ({ id: crypto.randomUUID(), name: 'Ink layer', strokes: [], visible: true, opacity: 1, locked: false, blendMode: 'normal' });
  try {
    const value = JSON.parse(localStorage.getItem('sketch-arena-studio-draft') ?? '{}') as { title?: unknown; strokes?: unknown; layers?: unknown; presetId?: unknown };
    const layers = Array.isArray(value.layers) ? value.layers.filter((layer) => Boolean(layer && typeof layer === 'object' && 'id' in layer && 'strokes' in layer && Array.isArray((layer as CanvasLayer).strokes))).map((layer) => {
      const item = layer as Partial<CanvasLayer>; return { id: String(item.id), name: typeof item.name === 'string' ? item.name : 'Untitled layer', strokes: item.strokes as Stroke[], visible: item.visible !== false, opacity: typeof item.opacity === 'number' ? item.opacity : 1, locked: item.locked === true, blendMode: ['multiply', 'screen', 'overlay', 'darken', 'lighten'].includes(item.blendMode ?? '') ? item.blendMode! : 'normal' } satisfies CanvasLayer;
    }) : [];
    if (!layers.length) layers.push({ ...fallback(), strokes: Array.isArray(value.strokes) ? value.strokes as Stroke[] : [] });
    return { title: typeof value.title === 'string' ? value.title : 'Untitled chaos', layers, presetId: typeof value.presetId === 'string' && ALL_CANVAS_PRESETS.some((preset) => preset.id === value.presetId) ? value.presetId : 'studio-square' };
  } catch { return { title: 'Untitled chaos', layers: [fallback()], presetId: 'studio-square' }; }
}

function artworkSvg(title: string, strokes: Stroke[], width = 2400, height = 2400): string {
  const safeTitle = title.replace(/[<>&"']/g, (value) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[value]!));
  const marks = strokes.map((stroke) => {
    const opacity = stroke.tool === 'eraser' ? 1 : stroke.opacity ?? 1;
    if (stroke.tool === 'fill') return `<rect width="${width}" height="${height}" fill="${stroke.color}" fill-opacity="${opacity}"/>`;
    const first = stroke.points[0]!; const last = stroke.points.at(-1)!; const color = stroke.tool === 'eraser' ? '#f4f0e8' : stroke.color;
    const style = `fill="none" stroke="${color}" stroke-opacity="${opacity}" stroke-width="${stroke.size * 2}" stroke-linecap="round" stroke-linejoin="round"`;
    if (stroke.shape === 'line') return `<line x1="${first.x * width}" y1="${first.y * height}" x2="${last.x * width}" y2="${last.y * height}" ${style}/>`;
    if (stroke.shape === 'rectangle') return `<rect x="${Math.min(first.x, last.x) * width}" y="${Math.min(first.y, last.y) * height}" width="${Math.abs(last.x - first.x) * width}" height="${Math.abs(last.y - first.y) * height}" ${style}/>`;
    if (stroke.shape === 'ellipse') return `<ellipse cx="${(first.x + last.x) * width / 2}" cy="${(first.y + last.y) * height / 2}" rx="${Math.abs(last.x - first.x) * width / 2}" ry="${Math.abs(last.y - first.y) * height / 2}" ${style}/>`;
    if (stroke.shape === 'triangle') return `<polygon points="${(first.x + last.x) * width / 2},${first.y * height} ${last.x * width},${last.y * height} ${first.x * width},${last.y * height}" ${style}/>`;
    if (stroke.shape === 'arrow') { const x1 = first.x * width; const y1 = first.y * height; const x2 = last.x * width; const y2 = last.y * height; const angle = Math.atan2(y2 - y1, x2 - x1); const head = Math.max(18, stroke.size * 3); return `<path d="M${x1} ${y1}L${x2} ${y2}M${x2} ${y2}L${x2 - head * Math.cos(angle - Math.PI / 6)} ${y2 - head * Math.sin(angle - Math.PI / 6)}M${x2} ${y2}L${x2 - head * Math.cos(angle + Math.PI / 6)} ${y2 - head * Math.sin(angle + Math.PI / 6)}" ${style}/>`; }
    const points = stroke.points.map((point) => `${Math.round(point.x * width)},${Math.round(point.y * height)}`).join(' ');
    return `<polyline points="${points}" ${style}/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><title>${safeTitle}</title><rect width="${width}" height="${height}" fill="#f4f0e8"/>${marks}</svg>`;
}

type MainNavProps = { active: 'play' | 'studio' | 'vault' | 'archive'; play: () => void; studio: () => void; vault: () => void; archive: () => void };

function MainNav({ active, play, studio, vault, archive }: MainNavProps) {
  const [open, setOpen] = useState(false);
  const visit = (action: () => void) => { setOpen(false); action(); };
  return <div className={`main-nav ${open ? 'is-open' : ''}`} onKeyDown={(event) => { if (event.key === 'Escape') setOpen(false); }}>
    <button className="nav-toggle" aria-label="Open navigation" aria-expanded={open} onClick={() => setOpen((value) => !value)}><span/><span/><span/><b>MENU</b></button>
    <nav aria-label="Main navigation">
      <button aria-current={active === 'play' ? 'page' : undefined} onClick={() => visit(play)}><i>01</i><span>PLAY</span><small>ROUND UP THE WEIRDOS</small></button>
      <button aria-current={active === 'studio' ? 'page' : undefined} onClick={() => visit(studio)}><i>02</i><span>STUDIO</span><small>MAKE A BEAUTIFUL MESS</small></button>
      <button aria-current={active === 'vault' ? 'page' : undefined} onClick={() => visit(vault)}><i>03</i><span>VAULT</span><small>KEEP THE GOOD BAD ONES</small></button>
      <button aria-current={active === 'archive' ? 'page' : undefined} onClick={() => visit(archive)}><i>04</i><span>ARCHIVE</span><small>IMMORTALIZE THE CHAOS</small></button>
    </nav>
  </div>;
}

function Brand() { return <div className="brand"><img src="/brand/sketch-arena-mark.svg" alt=""/><span className="brand-type"><b>SKETCH</b><strong>ARENA</strong><small>DRAW BADLY. GUESS LOUDLY.</small></span></div>; }
function Avatar({ seed, item }: { seed: number; item?: string }) { const colors = ['#ef476f','#ffb703','#27ae8a','#2878ff','#8b5cf6']; const itemColors: Record<string,string> = { 'yellow-weirdo-avatar': '#ffb703', 'green-chaos-avatar': '#27ae8a', 'golden-chaos-avatar': '#f2c94c' }; return <span className={`avatar ${item ? 'cosmetic-avatar' : ''}`} title={item?.replaceAll('-', ' ')} style={{ '--avatar': itemColors[item ?? ''] ?? colors[Math.abs(seed) % colors.length] } as React.CSSProperties}><i/><b/>{item === 'golden-chaos-avatar' && <em>♛</em>}</span>; }

function ChaosFace({ variant = 0 }: { variant?: number }) {
  const paths = [
    'M15 51C8 25 24 8 51 10c27 1 45 18 39 47-5 26-24 39-50 32C19 84 19 69 15 51Z',
    'M10 47C12 21 28 9 53 14c25 5 41 24 34 49-7 24-32 30-55 24C9 81 7 66 10 47Z',
    'M13 41C18 14 42 7 65 17c22 10 31 35 17 56-14 22-38 22-58 7C7 68 9 55 13 41Z',
  ];
  return <svg className={`chaos-face face-${variant}`} viewBox="0 0 100 100" role="presentation"><path className="face-body" d={paths[variant % paths.length]}/><ellipse className="face-eye" cx={variant === 1 ? 37 : 35} cy="42" rx="8" ry={variant === 2 ? 11 : 8}/><ellipse className="face-eye" cx="68" cy={variant === 1 ? 38 : 43} rx={variant === 0 ? 7 : 9} ry="8"/><circle cx="37" cy="43" r="3"/><circle cx="67" cy="43" r="3"/><path className="face-mouth" d={variant === 0 ? 'M35 67c11 8 24 7 32-3' : variant === 1 ? 'M37 69c8-10 19-11 29-2' : 'M34 63c10 13 22 14 33 0'}/></svg>;
}

function SparkField() {
  return <div className="ambient-sparks" aria-hidden="true">{Array.from({ length: 14 }, (_, index) => <i key={index} style={{ '--spark': index } as React.CSSProperties}/>)}</div>;
}
