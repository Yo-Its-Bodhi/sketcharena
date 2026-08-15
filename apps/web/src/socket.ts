import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@sketch-arena/protocol';
export const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io({ autoConnect: false, transports: ['websocket', 'polling'] });
