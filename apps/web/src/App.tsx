import { AnimatePresence, motion } from 'framer-motion';
import { useEffect, useMemo, useState } from 'react';
import type { Ack, ArtworkDocument, FeedItem, MatchResult, RoomSummary, RoomView, RoundResult, Stroke } from '@sketch-arena/protocol';
import { Canvas } from './Canvas';
import { socket } from './socket';

type Screen = 'landing' | 'lobby' | 'arena' | 'studio' | 'vault' | 'afterparty';
interface CreateRoomOptions { name: string; category: 'chaos' | 'classic' | 'crypto'; isPrivate: boolean; maxPlayers: number; }
const sessionId = localStorage.getItem('arena-session') ?? crypto.randomUUID();
localStorage.setItem('arena-session', sessionId);

export function App() {
  const [screen, setScreen] = useState<Screen>('landing');
  const [name, setName] = useState(localStorage.getItem('arena-name') ?? '');
  const [connected, setConnected] = useState(false);
  const [rooms, setRooms] = useState<RoomSummary[]>([]);
  const [room, setRoom] = useState<RoomView | null>(null);
  const [feed, setFeed] = useState<FeedItem[]>([]);
  const [prompt, setPrompt] = useState('');
  const [reveal, setReveal] = useState<RoundResult | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [error, setError] = useState('');
  const [inviteCode, setInviteCode] = useState('');

  useEffect(() => {
    const connect = () => setConnected(true); const disconnect = () => setConnected(false);
    const state = (value: RoomView) => {
      if (!value.players.some((player) => player.sessionId === sessionId)) return;
      setRoom(value);
      if (value.phase !== 'reveal') setReveal(null);
      if (value.phase !== 'drawing') setPrompt('');
      setScreen(value.phase === 'afterparty' ? 'afterparty' : 'arena');
    };
    const item = (value: FeedItem) => setFeed((items) => [...items.slice(-79), value]);
    const mergeStroke = (value: Stroke) => setRoom((valueRoom) => valueRoom ? { ...valueRoom, strokes: [...valueRoom.strokes.filter((stroke) => stroke.id !== value.id), value] } : valueRoom);
    const clear = () => setRoom((valueRoom) => valueRoom ? { ...valueRoom, strokes: [] } : valueRoom);
    socket.on('connect', connect); socket.on('disconnect', disconnect); socket.on('rooms:list', setRooms); socket.on('room:state', state);
    socket.on('feed:item', item); socket.on('draw:stroke', mergeStroke); socket.on('draw:preview', mergeStroke); socket.on('draw:clear', clear);
    socket.on('round:brief', (value) => setPrompt(value.prompt)); socket.on('round:reveal', (value) => setReveal(value));
    socket.on('match:complete', (value) => { setMatch(value); setScreen('afterparty'); });
    socket.connect();
    return () => { socket.off(); socket.disconnect(); };
  }, []);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), 4_500);
    return () => clearTimeout(timer);
  }, [error]);

  const enter = () => {
    const clean = name.trim(); if (clean.length < 2) return setError('Give the crowd a name to yell.');
    localStorage.setItem('arena-name', clean); setError('');
    socket.emit('session:resume', { sessionId, name: clean }, (ack) => {
      if (!ack.ok) return setError(ack.error ?? 'Could not enter'); socket.emit('rooms:subscribe');
      const invited = new URLSearchParams(location.search).get('join');
      if (invited) socket.emit('room:join', { inviteCode: invited }, (joined) => { handleAck(joined); if (joined.ok) history.replaceState({}, '', location.pathname); });
      else setScreen('lobby');
    });
  };
  const handleAck = <T,>(ack: Ack<T>) => { if (!ack.ok) setError(ack.error ?? 'Something went sideways'); };
  const createRoom = (options: CreateRoomOptions) => socket.emit('room:create', options, (ack) => {
    handleAck(ack);
    if (!ack.ok || !ack.data) return;
    setInviteCode(ack.data.inviteCode ?? ''); setRoom(ack.data.room); setFeed([]); setScreen('arena');
  });
  const joinRoom = (payload: { roomId?: string; inviteCode?: string }) => socket.emit('room:join', payload, (ack) => {
    handleAck(ack);
    if (!ack.ok || !ack.data) return;
    setInviteCode(''); setRoom(ack.data.room); setFeed([]); setScreen('arena');
  });

  return <div className="app">
    <div className="paper-noise"/><div className="cinematic-vignette"/><div className="stage-light stage-light-a"/><div className="stage-light stage-light-b"/><SparkField/>
    <AnimatePresence mode="wait">
      {screen === 'landing' && <Landing key="landing" name={name} setName={setName} enter={enter} studio={() => setScreen('studio')} connected={connected} error={error}/>} 
      {screen === 'lobby' && <Lobby key="lobby" name={name} rooms={rooms} create={createRoom} join={(id) => joinRoom({ roomId: id })} joinCode={(code) => joinRoom({ inviteCode: code })} studio={() => setScreen('studio')} vault={() => setScreen('vault')}/>} 
      {screen === 'arena' && room && <Arena key="arena" room={room} prompt={prompt} feed={feed} inviteCode={inviteCode} reveal={reveal} setReveal={setReveal} leave={() => socket.emit('room:leave', (ack) => { handleAck(ack); setRoom(null); setFeed([]); setInviteCode(''); setScreen('lobby'); socket.emit('rooms:subscribe'); })}/>} 
      {screen === 'studio' && <Studio key="studio" back={() => setScreen(name ? 'lobby' : 'landing')} vault={() => setScreen('vault')}/>} 
      {screen === 'vault' && <Vault key="vault" back={() => setScreen(name ? 'lobby' : 'landing')} studio={() => setScreen('studio')}/>} 
      {screen === 'afterparty' && match && <Afterparty key="afterparty" match={match} replay={() => socket.emit('game:rematch', () => undefined)} home={() => { socket.emit('room:leave', () => undefined); setScreen('lobby'); }}/>} 
    </AnimatePresence>
    <AnimatePresence>{error && screen !== 'landing' && <motion.div className="toast-error" initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 20, opacity: 0 }} role="alert"><b>WHOOPS.</b> {error}</motion.div>}</AnimatePresence>
  </div>;
}

function Landing({ name, setName, enter, studio, connected, error }: { name: string; setName: (value: string) => void; enter: () => void; studio: () => void; connected: boolean; error: string }) {
  return <motion.main className="landing screen" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, scale: .98 }}>
    <header className="topbar"><Brand/><span className={`connection ${connected ? 'online' : ''}`}><i/>{connected ? 'stage online' : 'warming up'}</span></header>
    <section className="hero">
      <div className="hero-doodles" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/><span className="orbit-line"/><span className="pencil-comet">✎</span></div>
      <motion.div className="hero-kicker" initial={{ y: 20, opacity: 0 }} animate={{ y: 0, opacity: 1 }}>LIVE DRAWING. LOUD GUESSING.</motion.div>
      <motion.h1 initial={{ y: 45, rotate: -1, opacity: 0 }} animate={{ y: 0, rotate: 0, opacity: 1 }} transition={{ type: 'spring', stiffness: 120 }}>DRAW BADLY.<br/><em>GUESS LOUDLY.</em></motion.h1>
      <p>The drawing game where panic is a feature and every disaster can become collectible.</p>
      <div className="hero-proof" aria-label="Game features"><span><b>45</b> SEC ROUNDS</span><i/><span><b>∞</b> BAD GUESSES</span><i/><span><b>1</b> GLORIOUS MESS</span></div>
      <div className="entry-card">
        <label>WHAT SHOULD THE CROWD CALL YOU?</label>
        <div><input value={name} maxLength={20} onChange={(event) => setName(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && enter()} placeholder="Your stage name" autoFocus/><button className="primary" onClick={enter}>ENTER THE ARENA <b>→</b></button></div>
        {error && <span className="error">{error}</span>}
      </div>
      <button className="studio-link" onClick={studio}><span>✦</span><b>SOLO STUDIO</b><small>Take your time. Make something beautiful.</small><i>→</i></button>
    </section>
    <div className="ticker"><span>45 SECOND ROUNDS</span><b>✦</b><span>REAL-TIME CHAOS</span><b>✦</b><span>SHIDO NATIVE</span><b>✦</b><span>MINT THE MOMENT</span></div>
  </motion.main>;
}

function Lobby({ name, rooms, create, join, joinCode, studio, vault }: { name: string; rooms: RoomSummary[]; create: (options: CreateRoomOptions) => void; join: (id: string) => void; joinCode: (code: string) => void; studio: () => void; vault: () => void }) {
  const [setupOpen, setSetupOpen] = useState(false);
  const [code, setCode] = useState('');
  const [roomName, setRoomName] = useState(`${name}'s Arena`);
  const [category, setCategory] = useState<CreateRoomOptions['category']>('chaos');
  const [isPrivate, setPrivate] = useState(false);
  const openRoom = rooms.find((value) => value.phase === 'lobby' && value.playerCount < value.maxPlayers);
  const quickPlay = () => openRoom ? join(openRoom.id) : create({ name: 'Open Mic Mayhem', category: 'chaos', isPrivate: false, maxPlayers: 8 });
  const submitCreate = () => { create({ name: roomName.trim() || `${name}'s Arena`, category, isPrivate, maxPlayers: 8 }); setSetupOpen(false); };

  return <motion.main className="screen lobby lobby-v2" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
    <header className="topbar"><Brand/><div className="player-chip"><Avatar seed={name.length * 91}/><span><small>TONIGHT’S TROUBLEMAKER</small><b>{name}</b></span></div></header>
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

    <div className="creative-paths"><button className="studio-banner studio-banner-v2" onClick={studio}><span>OTHER MOOD</span><b><i>SOLO STUDIO</i> — No clock. Serious tools. Your storefront.</b><strong>CREATE IN PEACE →</strong></button><button className="vault-shortcut" onClick={vault}><span>YOUR COLLECTION</span><b>ARTWORK VAULT</b><strong>OPEN →</strong></button></div>

    <AnimatePresence>{setupOpen && <motion.div className="setup-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onMouseDown={(event) => event.target === event.currentTarget && setSetupOpen(false)}><motion.section className="setup-sheet" initial={{ y: 40, rotate: 1, opacity: 0 }} animate={{ y: 0, rotate: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}><button className="setup-close" onClick={() => setSetupOpen(false)} aria-label="Close room setup">×</button><span>ROOM SETUP</span><h2>Build your<br/>little circus.</h2><label>ROOM NAME<input value={roomName} maxLength={36} onChange={(event) => setRoomName(event.target.value)}/></label><fieldset><legend>PROMPT DECK</legend>{(['chaos','classic','crypto'] as const).map((value) => <button type="button" className={category === value ? 'selected' : ''} onClick={() => setCategory(value)} key={value}><b>{value === 'chaos' ? '?!' : value === 'classic' ? '✎' : '₿'}</b><span>{value}<small>{value === 'chaos' ? 'Unhinged & weird' : value === 'classic' ? 'Pictionary energy' : 'Web3 nonsense'}</small></span></button>)}</fieldset><button className={`privacy-toggle ${isPrivate ? 'selected' : ''}`} onClick={() => setPrivate((value) => !value)}><span>{isPrivate ? '●' : '○'}</span><b>{isPrivate ? 'PRIVATE INVITE ROOM' : 'PUBLIC DROP-IN ROOM'}</b><small>{isPrivate ? 'Only people with the code can join' : 'Anyone in the lobby can jump in'}</small></button><button className="primary setup-submit" onClick={submitCreate}>OPEN THE DOORS →</button></motion.section></motion.div>}</AnimatePresence>
  </motion.main>;
}

function Arena({ room, prompt, feed, inviteCode, reveal, setReveal, leave }: { room: RoomView; prompt: string; feed: FeedItem[]; inviteCode: string; reveal: RoundResult | null; setReveal: (value: RoundResult | null) => void; leave: () => void }) {
  const me = room.players.find((player) => player.sessionId === sessionId); const drawer = room.players.find((player) => player.id === room.drawerId);
  const isDrawer = me?.isDrawer ?? false; const [text, setText] = useState(''); const [now, setNow] = useState(Date.now());
  const [displayStrokes, setDisplayStrokes] = useState(room.strokes);
  const [copied, setCopied] = useState(false);
  const [mobilePanel, setMobilePanel] = useState<'none' | 'players' | 'chat'>('none');
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 100); return () => clearInterval(timer); }, []);
  useEffect(() => setDisplayStrokes(room.strokes), [room.strokes]);
  useEffect(() => { if (reveal) setMobilePanel('none'); }, [reveal]);
  const seconds = Math.max(0, Math.ceil(((room.deadline ?? now) - now) / 1000));
  const submit = () => { if (!text.trim()) return; const event = room.phase === 'drawing' && !isDrawer && !me?.hasGuessed ? 'guess:submit' : 'chat:send'; socket.emit(event, { text }, () => undefined); setText(''); };
  const stroke = (value: Stroke) => { setDisplayStrokes((items) => [...items.filter((item) => item.id !== value.id), value]); socket.emit('draw:stroke', value); };

  return <motion.main className={`arena arena-screen screen panic-${seconds <= 10 && room.phase === 'drawing'}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
    <header className="arena-bar"><button onClick={leave}>← LEAVE</button><div><small><i className="live-dot"/> ARENA BROADCAST • ROUND {room.round || '—'} / {room.totalRounds || '—'}</small><b>{room.name}</b></div><div className={`clock ${seconds <= 10 && room.phase === 'drawing' ? 'danger' : ''}`} style={{ '--clock-progress': `${Math.max(0, Math.min(1, seconds / 45)) * 360}deg` } as React.CSSProperties}><span>{room.phase === 'lobby' ? 'WAITING' : room.phase === 'paused' ? 'HOLD' : room.phase === 'countdown' ? seconds : room.phase === 'reveal' ? 'REVEAL' : seconds}</span>{room.phase === 'drawing' && <i>SEC</i>}</div></header>
    <div className="game-grid">
      <aside className={`scoreboard ${mobilePanel === 'players' ? 'mobile-open' : ''}`}><div className="drawer-heading"><h3>THE LINEUP</h3><button onClick={() => setMobilePanel('none')} aria-label="Close players">×</button></div>{room.players.map((player, index) => <motion.div layout className={`score-player ${player.isDrawer ? 'drawing' : ''} ${player.hasGuessed ? 'scored' : ''} ${!player.connected ? 'offline' : ''}`} key={player.id}><span className="rank">{index === 0 && player.score > 0 ? '♛' : index + 1}</span><Avatar seed={player.avatarSeed}/><div><b>{player.name}</b><small>{player.isDrawer ? 'DRAWING' : player.hasGuessed ? 'GOT IT' : player.isHost ? 'HOST' : 'GUESSING'}</small></div><motion.strong key={player.score} initial={{ scale: 1.45, color: '#ffd447' }} animate={{ scale: 1, color: '#f8f5ea' }}>{player.score}</motion.strong></motion.div>)}</aside>
      <section className="stage">
        <div className="stage-hardware" aria-hidden="true"><i/><i/><i/><i/></div>
          {room.phase === 'lobby' ? <div className="waiting-stage"><div className="waiting-mascots" aria-hidden="true"><ChaosFace variant={0}/><ChaosFace variant={1}/><ChaosFace variant={2}/></div><span>THE CALM BEFORE THE CHAOS</span><h2>{room.playerCount < 2 ? 'Round up the weirdos.' : 'Everybody’s here.'}</h2><p>{room.playerCount < 2 ? 'You need at least one willing victim before the show can start.' : me?.isHost ? 'You control the big red button.' : `Waiting for ${room.players.find((p) => p.isHost)?.name} to start.`}</p>{inviteCode && <button className="invite-card" onClick={() => { void navigator.clipboard.writeText(`${location.origin}${location.pathname}?join=${inviteCode}`); setCopied(true); setTimeout(() => setCopied(false), 1500); }}><small>PRIVATE INVITE LINK</small><b>{inviteCode}</b><span>{copied ? 'LINK COPIED!' : 'CLICK TO COPY & SHARE'}</span></button>}{!inviteCode && room.playerCount < 2 && <div className="waiting-tip"><b>TIP</b> Open this page on another device or invite a friend to join your public room.</div>}{me?.isHost && <button className="start-button" disabled={room.playerCount < 2} onClick={() => socket.emit('game:start', (ack) => !ack.ok && undefined)}>START THE SHOW</button>}</div> : <>
          <div className="prompt-strip">{isDrawer ? <><small>YOUR PROMPT</small><b>{prompt || 'Stand by…'}</b></> : <><small>{drawer?.name ?? 'Someone'} IS DRAWING</small><b className="hint">{room.hints.join('')}</b></>}</div>
          <Canvas strokes={displayStrokes} active={room.phase === 'drawing' && isDrawer} onPreview={(value) => socket.emit('draw:preview', value)} onStroke={stroke} onClear={() => { setDisplayStrokes([]); socket.emit('draw:clear'); }} onUndo={() => { setDisplayStrokes((items) => items.slice(0, -1)); socket.emit('draw:undo'); }}/>
          {room.phase === 'countdown' && <div className="countdown-cover"><small>NEXT ROUND</small><strong>{seconds || 'GO'}</strong><span>{me?.isDrawer ? 'YOUR HANDS ARE ABOUT TO SWEAT' : 'GET YOUR BAD GUESSES READY'}</span></div>}
          {room.phase === 'paused' && <div className="countdown-cover"><small>SEAT HELD</small><strong>HOLD</strong><span>Somebody dropped. We’ll resume the moment they’re back.</span></div>}
        </>}
      </section>
      <aside className={`guess-panel ${mobilePanel === 'chat' ? 'mobile-open' : ''}`}><div className="guess-title"><span>LIVE CHAOS</span><i>{feed.length}</i><button onClick={() => setMobilePanel('none')} aria-label="Close live chaos">×</button></div><div className="feed" aria-live="polite">{feed.slice(-30).map((item) => <motion.div className={`feed-item ${item.kind}`} initial={{ opacity: 0, x: 18 }} animate={{ opacity: 1, x: 0 }} key={item.id}>{item.playerName && <b>{item.playerName}</b>}<span>{item.text}</span>{item.points && <strong>+{item.points}</strong>}</motion.div>)}</div><div className="reactions">{['😂','🔥','💀','👏','🤯','❤️'].map((emoji) => <button onClick={() => socket.emit('reaction:send', { emoji }, () => undefined)} key={emoji}>{emoji}</button>)}</div><div className="guess-box"><input value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => event.key === 'Enter' && submit()} placeholder={room.phase === 'drawing' && !isDrawer && !me?.hasGuessed ? 'SHOUT YOUR GUESS…' : 'Say something…'}/><button onClick={submit}>↑</button></div></aside>
    </div>
    {mobilePanel !== 'none' && <button className="mobile-scrim" onClick={() => setMobilePanel('none')} aria-label="Close game panel"/>}
    <nav className="mobile-game-dock" aria-label="Game panels"><button className={mobilePanel === 'players' ? 'active' : ''} onClick={() => setMobilePanel((value) => value === 'players' ? 'none' : 'players')}><span>♟</span><b>PLAYERS</b><i>{room.playerCount}</i></button><button className={mobilePanel === 'none' ? 'active canvas-tab' : 'canvas-tab'} onClick={() => setMobilePanel('none')}><span>✎</span><b>CANVAS</b></button><button className={mobilePanel === 'chat' ? 'active' : ''} onClick={() => setMobilePanel((value) => value === 'chat' ? 'none' : 'chat')}><span>!</span><b>CHAOS</b>{feed.length > 0 && <i>{Math.min(feed.length, 99)}</i>}</button></nav>
    <div className="reaction-bursts" aria-hidden="true">{feed.filter((item) => item.kind === 'reaction').slice(-4).map((item, index) => <motion.span key={item.id} initial={{ y: 80, opacity: 0, rotate: -12 }} animate={{ y: -40 - index * 42, opacity: [0, 1, 1, 0], rotate: 8 }} transition={{ duration: 2.2 }}>{item.text}</motion.span>)}</div>
    <AnimatePresence>{reveal && <Reveal result={reveal} mine={reveal.drawerId === me?.id} close={() => setReveal(null)}/>}</AnimatePresence>
  </motion.main>;
}

function Reveal({ result, mine, close }: { result: RoundResult; mine: boolean; close: () => void }) {
  const fastest = [...result.correct].sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  return <motion.div className="reveal-overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><div className="reveal-rays" aria-hidden="true"/><motion.div className="reveal-card reveal-card-v2" initial={{ scale: .65, rotate: -3, y: 60 }} animate={{ scale: 1, rotate: 0, y: 0 }} transition={{ type: 'spring', damping: 15 }}><div className="reveal-copy"><span>THE WORD WAS</span><h2>{result.prompt}</h2><p>Drawn under pressure by <b>{result.drawerName}</b></p><div className="round-awards"><div><small>FASTEST BRAIN</small><strong>{fastest?.playerName ?? 'Nobody'}</strong></div><div><small>SUCCESS RATE</small><strong>{result.correct.length} got it</strong></div></div>{mine && <button className="keep-button" onClick={() => { socket.emit('round:keep', { roundId: result.roundId }, () => undefined); close(); }}>★ KEEP THIS DISASTER</button>}<button className="text-button" onClick={close}>WATCH THE CHAOS</button></div><div className="reveal-art"><span className="tape tape-a"/><span className="tape tape-b"/><Canvas strokes={result.strokes} active={false}/><small>AN ORIGINAL PANIC MASTERPIECE</small></div></motion.div></motion.div>;
}

function Afterparty({ match, replay, home }: { match: MatchResult; replay: () => void; home: () => void }) {
  const me = match.standings.find((player) => player.sessionId === sessionId);
  return <motion.main className="screen afterparty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="topbar"><Brand/><span>THE AFTERPARTY</span></header><section className="winner"><div className="winner-burst" aria-hidden="true">✦</div><small>TONIGHT’S CHAMPION</small><h1>{match.winner?.name ?? 'THE CHAOS'}</h1><strong>{match.winner?.score ?? 0} POINTS</strong></section><section className="podium" aria-label="Final standings">{match.standings.slice(0,3).map((player, index) => <motion.article className={`podium-place place-${index + 1}`} initial={{ y: 70, opacity: 0 }} animate={{ y: 0, opacity: 1 }} transition={{ delay: .15 + index * .1, type: 'spring' }} key={player.id}><span>{index === 0 ? '♛' : index + 1}</span><Avatar seed={player.avatarSeed}/><b>{player.name}</b><strong>{player.score}</strong><small>POINTS</small></motion.article>)}</section><div className="gallery-heading"><span>THE NIGHT’S MASTERPIECES</span><small>Every terrible line. Preserved forever.</small></div><section className="match-gallery">{match.rounds.map((round, index) => <motion.article initial={{ opacity: 0, y: 30, rotate: index % 2 ? 1.5 : -1.5 }} whileInView={{ opacity: 1, y: 0 }} key={round.roundId}><Canvas strokes={round.strokes} active={false}/><small>{round.drawerName} tried to draw</small><h2>{round.prompt}</h2><span>{round.correct.length} guessed it</span></motion.article>)}</section><div className="after-actions">{me?.isHost ? <button className="primary" onClick={replay}>RUN IT BACK</button> : <span className="rematch-note">The host can bring this crew back for another round.</span>}<button onClick={home}>BACK TO LOBBY</button></div></motion.main>;
}

function Studio({ back, vault }: { back: () => void; vault: () => void }) {
  const draft = useMemo(loadStudioDraft, []);
  const [strokes, setStrokes] = useState<Stroke[]>(draft.strokes);
  const [title, setTitle] = useState(draft.title);
  const [status, setStatus] = useState('SAVED LOCALLY');
  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem('sketch-arena-studio-draft', JSON.stringify({ title, strokes, updatedAt: Date.now() }));
      setStatus('SAVED LOCALLY');
    }, 250);
    setStatus('SAVING…');
    return () => clearTimeout(timer);
  }, [title, strokes]);

  const exportArtwork = () => {
    const blob = new Blob([artworkSvg(title, strokes)], { type: 'image/svg+xml' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `${title.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'sketch-arena-artwork'}.svg`;
    link.click(); URL.revokeObjectURL(url); setStatus('ARTWORK EXPORTED');
  };
  const prepare = async () => {
    localStorage.setItem('sketch-arena-storefront-package', JSON.stringify({ version: 1, ownerSessionId: sessionId, origin: 'studio', title, canvasRatio: 'square', width: 2400, height: 2400, strokes, preparedAt: Date.now() }));
    setStatus('SAVING TO YOUR VAULT…');
    try {
      const response = await fetch('/api/artworks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ownerSessionId: sessionId, origin: 'studio', status: 'mint-ready', title: title.trim() || 'Untitled chaos', canvasRatio: 'square', width: 2400, height: 2400, strokes }) });
      if (!response.ok) throw new Error('Save failed');
      setStatus('VAULTED • STOREFRONT READY');
    } catch { setStatus('SAVED LOCALLY • SERVER OFFLINE'); }
  };

  return <motion.main className="screen studio" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="studio-bar"><button onClick={back}>← EXIT STUDIO</button><input value={title} maxLength={80} onChange={(event) => setTitle(event.target.value)}/><div><span>{status}</span><button onClick={vault}>VAULT</button><button onClick={exportArtwork}>EXPORT</button><button className="primary" onClick={prepare} title="Build the canonical package NFT Studio will receive">PREPARE FOR STOREFRONT</button></div></header><div className="studio-workspace"><aside><span>SOLO STUDIO</span><h2>No clock.<br/>No hecklers.</h2><p>Your draft autosaves. The canvas exports as a scalable 2400 × 2400 artwork and uses the same canonical format as Arena rounds.</p><div className="studio-stat"><small>STROKES</small><b>{strokes.length}</b></div><div className="studio-stat"><small>CANVAS</small><b>2400 × 2400</b></div></aside><Canvas expert active strokes={strokes} onStroke={(stroke) => setStrokes((items) => [...items, stroke])} onClear={() => setStrokes([])} onUndo={() => setStrokes((items) => items.slice(0, -1))}/><aside className="layers"><span>WORKSPACE</span><button className="active">◉ Ink layer</button><button disabled>＋ Add layer</button><hr/><small>STOREFRONT BRIDGE</small><p>Canonical artwork package</p><p>Owner and provenance fields</p><p>Mint adapter boundary</p><p>NFT Studio handoff ready</p></aside></div></motion.main>;
}

function Vault({ back, studio }: { back: () => void; studio: () => void }) {
  const [items, setItems] = useState<ArtworkDocument[]>([]); const [loading, setLoading] = useState(true);
  useEffect(() => { fetch(`/api/artworks?sessionId=${sessionId}`).then((response) => response.ok ? response.json() : Promise.reject()).then(setItems).catch(() => setItems([])).finally(() => setLoading(false)); }, []);
  const download = (item: ArtworkDocument) => { const url = URL.createObjectURL(new Blob([artworkSvg(item.title, item.strokes)], { type: 'image/svg+xml' })); const link = document.createElement('a'); link.href = url; link.download = `${item.title.replace(/[^a-z0-9]+/gi, '-') || 'artwork'}.svg`; link.click(); URL.revokeObjectURL(url); };
  return <motion.main className="screen vault" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><header className="topbar"><Brand/><button onClick={back}>← BACK TO LOBBY</button></header><section className="vault-hero"><span>YOUR PERMANENT PLAYGROUND</span><h1>ARTWORK<br/><em>VAULT.</em></h1><p>Arena disasters and Studio pieces live here, safely packaged for the NFT Studio bridge when the VPS connection goes live.</p><button className="primary" onClick={studio}>＋ CREATE IN STUDIO</button></section><section className="vault-grid">{loading && <div className="vault-empty">OPENING THE VAULT…</div>}{!loading && !items.length && <div className="vault-empty"><ChaosFace variant={1}/><h2>Beautifully empty.</h2><p>Keep a round drawing or prepare a Studio piece and it will appear here.</p><button onClick={studio}>MAKE THE FIRST ONE →</button></div>}{items.map((item) => <article className="vault-card" key={item.id}><div className="vault-art"><Canvas strokes={item.strokes} active={false}/><span>{item.origin === 'arena' ? 'PANIC ORIGINAL' : 'STUDIO ORIGINAL'}</span></div><small>{new Date(item.createdAt).toLocaleDateString()} • {item.status.replace('-', ' ')}</small><h2>{item.title}</h2><div><button onClick={() => download(item)}>EXPORT SVG</button><button disabled title="Enabled when the NFT Studio adapter is connected on the VPS">MINT ON SHIDO • SOON</button></div></article>)}</section></motion.main>;
}

function loadStudioDraft(): { title: string; strokes: Stroke[] } {
  try {
    const value = JSON.parse(localStorage.getItem('sketch-arena-studio-draft') ?? '{}') as { title?: unknown; strokes?: unknown };
    return { title: typeof value.title === 'string' ? value.title : 'Untitled chaos', strokes: Array.isArray(value.strokes) ? value.strokes as Stroke[] : [] };
  } catch { return { title: 'Untitled chaos', strokes: [] }; }
}

function artworkSvg(title: string, strokes: Stroke[]): string {
  const safeTitle = title.replace(/[<>&"']/g, (value) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[value]!));
  const marks = strokes.map((stroke) => {
    if (stroke.tool === 'fill') return `<rect width="2400" height="2400" fill="${stroke.color}"/>`;
    const points = stroke.points.map((point) => `${Math.round(point.x * 2400)},${Math.round(point.y * 2400)}`).join(' ');
    return `<polyline points="${points}" fill="none" stroke="${stroke.tool === 'eraser' ? '#f4f0e8' : stroke.color}" stroke-width="${stroke.size * 2}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="2400" height="2400" viewBox="0 0 2400 2400"><title>${safeTitle}</title><rect width="2400" height="2400" fill="#f4f0e8"/>${marks}</svg>`;
}

function Brand() { return <div className="brand"><i>SA</i><span><b>SKETCH</b> ARENA</span></div>; }
function Avatar({ seed }: { seed: number }) { const colors = ['#ef476f','#ffb703','#27ae8a','#2878ff','#8b5cf6']; return <span className="avatar" style={{ '--avatar': colors[Math.abs(seed) % colors.length] } as React.CSSProperties}><i/><b/></span>; }

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
