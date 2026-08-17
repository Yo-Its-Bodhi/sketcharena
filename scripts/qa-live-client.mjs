import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';

const roomId = process.argv[2];
if (!roomId) throw new Error('Usage: node scripts/qa-live-client.mjs ROOM_ID');
const timeoutMs = Math.min(900_000, Math.max(120_000, Number(process.env.QA_CLIENT_TIMEOUT_MS ?? 360_000)));

const socket = io(process.env.QA_SERVER ?? 'http://127.0.0.1:4100', { transports: ['websocket'], reconnection: false });
const credential = randomBytes(32).toString('hex');
let guessedThisRound = false;

socket.on('connect', () => socket.emit('session:resume', { credential, name: 'Socket Gremlin' }, (session) => {
  if (!session.ok) throw new Error(session.error);
  socket.emit('room:join', { roomId }, (joined) => {
    if (!joined.ok) throw new Error(joined.error);
    socket.emit('player:ready', { ready: true }, (ready) => {
      if (!ready.ok) throw new Error(ready.error);
      console.log('QA_CLIENT_READY');
    });
  });
}));

socket.on('room:state', (room) => {
  if (room.phase !== 'drawing') { guessedThisRound = false; return; }
  const me = room.players.find((player) => player.name === 'Socket Gremlin');
  if (!me?.isDrawer && !guessedThisRound) {
    guessedThisRound = true;
    for (const [index, text] of ['angry potato', 'tax audit with legs', 'a deeply concerned sandwich'].entries()) {
      setTimeout(() => socket.emit('guess:submit', { text }, () => undefined), 350 + index * 450);
    }
  }
});

socket.on('round:brief', ({ prompt }) => console.log(`QA_CLIENT_DRAWING:${prompt}`));
socket.on('round:reveal', (round) => console.log(`QA_REVEAL:${round.prompt}:${round.funniestCandidates.length}`));
socket.on('match:complete', () => { console.log('QA_MATCH_COMPLETE'); socket.close(); });
socket.on('room:error', (message) => console.error(`QA_ROOM_ERROR:${message}`));
setTimeout(() => { console.error('QA_CLIENT_TIMEOUT'); socket.close(); }, timeoutMs).unref();
