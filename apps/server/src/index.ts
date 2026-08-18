import { createServer } from 'node:http';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { z } from 'zod';
import type { ClientToServerEvents, MatchResult, ServerToClientEvents, Stroke } from '@sketch-arena/protocol';
import { FileArtworkRepository, MemoryArtworkRepository, toPanicArchiveItem } from './artwork/ArtworkRepository.js';
import { GAME, GameRoom } from './game/GameRoom.js';
import { FileProgressionRepository, MemoryProgressionRepository, SEASON_ITEMS, type PlayerProgress } from './progression/ProgressionRepository.js';
import { FileMintRepository, MemoryMintRepository } from './mint/MintRepository.js';
import { MintService, MintServiceError, loadMintConfiguration } from './mint/MintService.js';
import { SlidingLimit } from './rateLimit.js';
import { BackstageAuth, type BackstageRole } from './backstageAuth.js';
import { FilePromotionRepository, MemoryPromotionRepository, PromotionService } from './promotion/PromotionRepository.js';
import { errorFields, log } from './logger.js';
import { OperationalState } from './operations.js';
import { FileReportRepository, MemoryReportRepository } from './moderation/ReportRepository.js';
import { AccountService, FileAccountRepository, MemoryAccountRepository } from './account/AccountRepository.js';
import { loadPasskeyConfiguration, PasskeyService } from './account/PasskeyService.js';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { PostgresAccountRepository } from './account/PostgresAccountRepository.js';
import { loadPersistenceConfiguration } from './persistenceConfig.js';
import { Pool } from 'pg';
import { PostgresArtworkRepository } from './artwork/PostgresArtworkRepository.js';
import { PostgresMintRepository } from './mint/PostgresMintRepository.js';
import { PostgresProgressionRepository } from './progression/PostgresProgressionRepository.js';
import { PostgresPromotionRepository } from './promotion/PostgresPromotionRepository.js';
import { PostgresReportRepository } from './moderation/PostgresReportRepository.js';
import { preparePanicArchiveDeployment } from './mint/PanicArchiveDeployment.js';

const PORT = Number(process.env.PORT ?? 4100);
const BIND_HOST = process.env.BIND_HOST ?? '127.0.0.1';
const RELEASE_SHA = process.env.RELEASE_SHA?.trim() || 'development';
const METRICS_TOKEN_HASH = process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length >= 32 ? createHash('sha256').update(process.env.METRICS_TOKEN).digest() : null;
const WEB_ORIGINS = (process.env.WEB_ORIGIN ?? 'http://localhost:5173').split(',').map((value) => value.trim());
const operations = new OperationalState();
const app = express();
const server = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(server, {
  cors: { origin: WEB_ORIGINS, methods: ['GET', 'POST'], credentials: true }, maxHttpBufferSize: 256_000,
  pingInterval: 20_000, pingTimeout: 15_000,
});

app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY?.trim() || 'loopback');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'same-site' } }));
app.use(cors({ origin: WEB_ORIGINS, credentials: true }));
app.use(express.json({ limit: '256kb' }));
app.use((request, response, next) => {
  const requestId = randomUUID(); const requestStarted = performance.now();
  response.setHeader('x-request-id', requestId);
  response.once('finish', () => {
    if (request.path.startsWith('/health')) return;
    metricCounters.httpTotal += 1;
    if (response.statusCode >= 500) metricCounters.http5xx += 1;
    else if (response.statusCode >= 400) metricCounters.http4xx += 1;
    log(response.statusCode >= 500 ? 'error' : response.statusCode >= 400 ? 'warn' : 'info', 'http.request', {
      requestId, method: request.method, path: request.path, status: response.statusCode, durationMs: Math.round(performance.now() - requestStarted),
    });
  });
  next();
});

const rooms = new Map<string, GameRoom>();
const roomBindings = new Set<string>();
const persistence = loadPersistenceConfiguration();
const databasePool = persistence.databaseUrl ? new Pool({ connectionString: persistence.databaseUrl, max: Number(process.env.DATABASE_POOL_MAX ?? 10), idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000, application_name: 'sketch-arena' }) : null;
if (databasePool) await databasePool.query('select 1');
const artwork = databasePool
  ? new PostgresArtworkRepository(databasePool)
  : persistence.artworkFile === ':memory:'
  ? new MemoryArtworkRepository()
  : new FileArtworkRepository(persistence.artworkFile);
const progression = databasePool
  ? new PostgresProgressionRepository(databasePool)
  : persistence.progressionFile === ':memory:'
  ? new MemoryProgressionRepository()
  : new FileProgressionRepository(persistence.progressionFile);
const mintRepository = databasePool
  ? new PostgresMintRepository(databasePool)
  : persistence.mintFile === ':memory:'
  ? new MemoryMintRepository()
  : new FileMintRepository(persistence.mintFile);
const minting = new MintService(artwork, progression, mintRepository, loadMintConfiguration());
const initialMintStatus = await minting.verifyInfrastructure(true);
if (minting.config.enabled && !initialMintStatus.enabled) log('warn', 'mint.infrastructure_not_ready', { checks: initialMintStatus.missing.join(',') });
const promotionRepository = databasePool ? new PostgresPromotionRepository(databasePool) : persistence.promotionFile === ':memory:' ? new MemoryPromotionRepository() : new FilePromotionRepository(persistence.promotionFile);
const promotions = new PromotionService(promotionRepository, progression);
const reports = databasePool ? new PostgresReportRepository(databasePool) : persistence.reportFile === ':memory:' ? new MemoryReportRepository() : new FileReportRepository(persistence.reportFile);
const accountRepository = databasePool ? new PostgresAccountRepository(databasePool)
  : persistence.accountFile === ':memory:' ? new MemoryAccountRepository()
    : new FileAccountRepository(persistence.accountFile);
const accounts = new AccountService(accountRepository);
const passkeys = new PasskeyService(accountRepository, accounts, loadPasskeyConfiguration());
const SESSION_COOKIE = 'sketch_session';
const COOKIE_SECURE = loadPasskeyConfiguration().origin.startsWith('https://');
const actionLimit = new SlidingLimit(35, 10_000);
const guessLimit = new SlidingLimit(8, 5_000);
const drawLimit = new SlidingLimit(180, 5_000);
const previewLimit = new SlidingLimit(150, 5_000);
const apiLimit = new SlidingLimit(90, 60_000);
const adminLimit = new SlidingLimit(40, 60_000);
const walletLimit = new SlidingLimit(12, 60_000);
const promotionLimit = new SlidingLimit(10, 60_000);
const reportLimit = new SlidingLimit(3, 3_600_000);
const metricCounters = { httpTotal: 0, http4xx: 0, http5xx: 0, socketRejected: 0, rateLimited: 0 };

const backstageAuth = new BackstageAuth();
if (!backstageAuth.valid) {
  log('error', 'backstage.configuration_invalid', { errors: backstageAuth.configurationErrors.join('; ') });
  throw new Error('Backstage configuration is invalid; refusing to start');
}

const nameSchema = z.string().trim().min(2).max(20).regex(/^[\p{L}\p{N}_. -]+$/u);
const credentialSchema = z.string().regex(/^[0-9a-f]{64}$/i);
const sessionSchema = z.object({ credential: credentialSchema.optional(), name: nameSchema });
const accountMigrationSchema = z.object({ name: nameSchema, deviceLabel: z.string().trim().min(2).max(80).default('This browser') });
const passkeyRegistrationSchema = z.object({ challengeId: z.string().uuid(), label: z.string().trim().min(2).max(80).default('My passkey'), response: z.object({ id: z.string().min(1) }).passthrough() });
const passkeyAuthenticationSchema = z.object({ challengeId: z.string().uuid(), deviceLabel: z.string().trim().min(2).max(80).default('Passkey device'), response: z.object({ id: z.string().min(1) }).passthrough() });
const roomCreateSchema = z.object({
  name: z.string().trim().min(2).max(36), category: z.enum(['chaos', 'classic', 'crypto', 'animals', 'food', 'screen', 'music', 'places', 'legends']).default('chaos'),
  isPrivate: z.boolean().optional().default(false), maxPlayers: z.number().int().min(2).max(GAME.maxPlayers).optional().default(8),
  roundSeconds: z.union([z.literal(30), z.literal(45), z.literal(60)]).optional().default(45),
});
const roomJoinSchema = z.object({ roomId: z.string().min(1).optional(), inviteCode: z.string().min(4).max(12).optional() }).refine((value) => value.roomId || value.inviteCode);
const textSchema = z.object({ text: z.string().trim().min(1).max(160) });
const keepRoundSchema = z.object({ roundId: z.string().uuid() });
const kickPlayerSchema = z.object({ playerId: z.string().min(1).max(24) });
const reportPlayerSchema = z.object({ playerId: z.string().min(1).max(24), category: z.enum(['harassment', 'hate-or-threats', 'spam', 'cheating', 'unsafe-art', 'other']), detail: z.string().trim().min(10).max(500) });
const reportStatusSchema = z.enum(['open', 'reviewing', 'resolved', 'dismissed']);
const reportUpdateSchema = z.object({ status: reportStatusSchema, resolutionNote: z.string().trim().min(3).max(500) });
const equipItemSchema = z.object({ itemId: z.string().trim().min(2).max(80) });
const leaderboardPeriodSchema = z.enum(['weekly', 'monthly', 'season', 'all-time']);
const strokeSchema: z.ZodType<Stroke> = z.object({
  id: z.string().min(1).max(64), tool: z.enum(['pencil', 'eraser', 'fill']), color: z.string().regex(/^#[0-9a-f]{6}$/i),
  size: z.number().min(1).max(160), points: z.array(z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), pressure: z.number().min(0).max(1).optional() })).min(1).max(GAME.maxPointsPerStroke),
  at: z.number().nonnegative(), brush: z.enum(['pencil', 'ink', 'marker', 'airbrush', 'charcoal', 'technical', 'watercolor', 'pastel', 'pixel', 'calligraphy', 'neon']).optional(),
  shape: z.enum(['freehand', 'line', 'rectangle', 'ellipse', 'arrow', 'triangle']).optional(), opacity: z.number().min(.01).max(1).optional(), smoothing: z.number().min(0).max(1).optional(),
});
const artworkSchema = z.object({
  id: z.string().uuid().optional(), ownerSessionId: z.string().uuid().optional(), origin: z.enum(['arena', 'studio']),
  status: z.enum(['draft', 'gallery', 'mint-ready']).optional(), title: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(), canvasRatio: z.enum(['square', 'portrait', 'landscape']),
  width: z.number().int().min(256).max(8000), height: z.number().int().min(256).max(8000),
  strokes: z.array(strokeSchema).max(GAME.maxStrokes), sourceRoundId: z.string().uuid().optional(),
});

const health = () => ({ ...operations.snapshot(rooms.size, io.engine.clientsCount), release: RELEASE_SHA });
app.get('/health/live', (_request, response) => response.json({ ok: true, now: Date.now(), release: RELEASE_SHA }));
app.get('/health/ready', (_request, response) => response.status(operations.isReady() ? 200 : 503).json(health()));
app.get('/health', (_request, response) => response.status(operations.isReady() ? 200 : 503).json(health()));
app.get('/metrics', (request, response) => {
  if (!authorizeMetrics(request.headers.authorization)) return response.status(METRICS_TOKEN_HASH ? 401 : 503).type('text/plain').send('Metrics unavailable\n');
  const memory = process.memoryUsage();
  const values = [
    '# HELP sketch_arena_ready Whether the server is accepting traffic.', '# TYPE sketch_arena_ready gauge', `sketch_arena_ready ${operations.isReady() ? 1 : 0}`,
    '# HELP sketch_arena_uptime_seconds Process uptime in seconds.', '# TYPE sketch_arena_uptime_seconds gauge', `sketch_arena_uptime_seconds ${Math.floor(process.uptime())}`,
    '# HELP sketch_arena_rooms Active in-memory rooms.', '# TYPE sketch_arena_rooms gauge', `sketch_arena_rooms ${rooms.size}`,
    '# HELP sketch_arena_connections Active Socket.IO connections.', '# TYPE sketch_arena_connections gauge', `sketch_arena_connections ${io.engine.clientsCount}`,
    '# HELP sketch_arena_http_requests_total Completed non-health HTTP requests.', '# TYPE sketch_arena_http_requests_total counter', `sketch_arena_http_requests_total ${metricCounters.httpTotal}`,
    '# HELP sketch_arena_http_4xx_total Completed HTTP client errors.', '# TYPE sketch_arena_http_4xx_total counter', `sketch_arena_http_4xx_total ${metricCounters.http4xx}`,
    '# HELP sketch_arena_http_5xx_total Completed HTTP server errors.', '# TYPE sketch_arena_http_5xx_total counter', `sketch_arena_http_5xx_total ${metricCounters.http5xx}`,
    '# HELP sketch_arena_socket_rejections_total Rejected or failed acknowledged socket actions.', '# TYPE sketch_arena_socket_rejections_total counter', `sketch_arena_socket_rejections_total ${metricCounters.socketRejected}`,
    '# HELP sketch_arena_rate_limited_total HTTP or acknowledged socket actions rejected by rate limits.', '# TYPE sketch_arena_rate_limited_total counter', `sketch_arena_rate_limited_total ${metricCounters.rateLimited}`,
    '# HELP sketch_arena_process_resident_bytes Resident process memory.', '# TYPE sketch_arena_process_resident_bytes gauge', `sketch_arena_process_resident_bytes ${memory.rss}`,
    '# HELP sketch_arena_process_heap_bytes Used JavaScript heap.', '# TYPE sketch_arena_process_heap_bytes gauge', `sketch_arena_process_heap_bytes ${memory.heapUsed}`,
    '# HELP sketch_arena_release_info Immutable release identifier.', '# TYPE sketch_arena_release_info gauge', `sketch_arena_release_info{release="${prometheusLabel(RELEASE_SHA)}"} 1`, '',
  ];
  return response.type('text/plain; version=0.0.4; charset=utf-8').send(values.join('\n'));
});
app.use('/api', (request, response, next) => {
  if (!apiLimit.take(request.ip ?? 'unknown')) { metricCounters.rateLimited += 1; return response.status(429).json({ error: 'Too many requests—try again shortly' }); }
  next();
});
app.post('/api/account/migrate', async (request, response) => {
  const credential = legacyCredentialFromAuthorization(request.headers.authorization); if (!credential) return response.status(401).json({ error: 'Recovery credential required' });
  const parsed = accountMigrationSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Account migration request is invalid' });
  try {
    const migrated = await accounts.migrateLegacy(credential, parsed.data.name, parsed.data.deviceLabel);
    setPlayerCookie(response, migrated.token, migrated.session.expiresAt);
    log('info', 'account.legacy_migrated', { accountId: migrated.account.id, sessionId: migrated.session.id });
    return response.status(201).json(publicAccount(migrated.account, migrated.session.id));
  } catch (error) {
    const message = error instanceof Error && /name.*claimed/i.test(error.message) ? error.message : 'That name could not be claimed';
    return response.status(409).json({ error: message });
  }
});
app.get('/api/account', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (!authenticated) return response.status(401).json({ error: 'Player authentication required' });
  const passkeyCount = (await accountRepository.listPasskeys(authenticated.account.id)).length;
  return response.json({ ...publicAccount(authenticated.account, authenticated.session.id), passkeyCount });
});
app.get('/api/account/sessions', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (!authenticated) return response.status(401).json({ error: 'Player authentication required' });
  const sessions = await accountRepository.listSessions(authenticated.account.id, Date.now());
  return response.json(sessions.map((session) => ({ id: session.id, label: session.label, createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, expiresAt: session.expiresAt, current: session.id === authenticated.session.id })));
});
app.delete('/api/account/sessions/:sessionId', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (!authenticated) return response.status(401).json({ error: 'Player authentication required' });
  const sessionId = z.string().uuid().safeParse(request.params.sessionId); if (!sessionId.success) return response.status(400).json({ error: 'Device session is invalid' });
  const revoked = await accountRepository.revokeSession(sessionId.data, authenticated.account.id, Date.now()); if (!revoked) return response.status(404).json({ error: 'Device session not found' });
  if (sessionId.data === authenticated.session.id) clearPlayerCookie(response); return response.status(204).send();
});
app.post('/api/account/logout', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (authenticated) await accountRepository.revokeSession(authenticated.session.id, authenticated.account.id, Date.now());
  clearPlayerCookie(response); return response.status(204).send();
});
app.post('/api/account/passkeys/register/options', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (!authenticated) return response.status(401).json({ error: 'A device session is required before adding a passkey' });
  try { return response.json(await passkeys.registrationOptions(authenticated.account)); } catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Passkey setup could not start' }); }
});
app.post('/api/account/passkeys/register/verify', async (request, response) => {
  const authenticated = await playerAccountFromRequest(request); if (!authenticated) return response.status(401).json({ error: 'A device session is required before adding a passkey' });
  const parsed = passkeyRegistrationSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Passkey response is invalid' });
  try { const passkey = await passkeys.verifyRegistration(authenticated.account, parsed.data.challengeId, parsed.data.response as unknown as RegistrationResponseJSON, parsed.data.label); return response.status(201).json({ id: passkey.id, label: passkey.label, backedUp: passkey.backedUp, createdAt: passkey.createdAt }); }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Passkey could not be verified' }); }
});
app.post('/api/account/passkeys/authenticate/options', async (_request, response) => response.json(await passkeys.authenticationOptions()));
app.post('/api/account/passkeys/authenticate/verify', async (request, response) => {
  const parsed = passkeyAuthenticationSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Passkey response is invalid' });
  try { const authenticated = await passkeys.verifyAuthentication(parsed.data.challengeId, parsed.data.response as unknown as AuthenticationResponseJSON, parsed.data.deviceLabel); setPlayerCookie(response, authenticated.token, authenticated.session.expiresAt); return response.json(publicAccount(authenticated.account, authenticated.session.id)); }
  catch (error) { return response.status(401).json({ error: error instanceof Error ? error.message : 'Passkey sign-in failed' }); }
});
const walletAddressSchema = z.string().regex(/^0x[0-9a-f]{40}$/i);
const walletChallengeSchema = z.object({ address: walletAddressSchema });
const walletVerifySchema = z.object({ challengeId: z.string().uuid(), address: walletAddressSchema, signature: z.string().regex(/^0x[0-9a-f]+$/i).max(1_000) });
const transactionHashSchema = z.object({ transactionHash: z.string().regex(/^0x[0-9a-f]{64}$/i) });
const promoRedeemSchema = z.object({ code: z.string().trim().min(8).max(64) });
const promotionSchema = z.object({
  name: z.string().trim().min(3).max(80), kind: z.enum(['free-mint', 'mint-discount']), usesPerPlayer: z.number().int().min(1).max(10), discountBps: z.number().int().min(100).max(10_000).optional(),
  reason: z.string().trim().min(3).max(240), maxRedemptions: z.number().int().min(1).max(1_000_000), startsAt: z.number().int().positive().optional(), expiresInDays: z.number().int().min(1).max(365),
  customCode: z.string().trim().min(12).max(48).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).refine((value) => value.kind !== 'mint-discount' || Boolean(value.discountBps), { message: 'Discount percentage is required' });
const contractAccessSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set-blocked'), address: walletAddressSchema, enabled: z.boolean() }),
  z.object({ action: z.literal('set-approved'), address: walletAddressSchema, enabled: z.boolean() }),
  z.object({ action: z.literal('set-allowlist'), enabled: z.boolean() }),
  z.object({ action: z.literal('set-paused'), enabled: z.boolean() }),
]);
app.get('/api/rooms', (_request, response) => response.json(publicRooms()));
app.get('/api/archive', async (request, response) => {
  const limit = z.coerce.number().int().min(1).max(100).catch(48).parse(request.query.limit);
  const records = await artwork.listMinted(limit);
  const items = records.map(toPanicArchiveItem);
  return response.json({ collection: 'Sketch Arena: The Panic Archive', season: { id: 0, name: 'The First Mess' }, total: items.length, items });
});
app.get('/api/archive/metadata', (_request, response) => {
  const origin = minting.config.publicOrigin;
  response.setHeader('cache-control', 'public, max-age=3600, stale-while-revalidate=86400');
  return response.json({
    name: 'Sketch Arena: The Panic Archive',
    symbol: 'PANIC',
    description: 'Original player-made disasters from Sketch Arena. Drawn under pressure, signed by the artist and archived on Shido.',
    image: `${origin}/brand/app-icon-512.png`,
    banner_image: `${origin}/social/draw-badly-become-legendary.png`,
    external_link: `${origin}/archive`,
  });
});
app.get('/api/mint/status', async (_request, response) => response.json(await minting.verifyInfrastructure()));
app.get('/api/wallet', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  return response.json({ binding: await minting.binding(ownerSessionId) });
});
app.post('/api/promotions/redeem', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  if (!promotionLimit.take(`${request.ip}:${ownerSessionId}`)) return response.status(429).json({ error: 'Too many promo attempts—wait a minute and try again' });
  const parsed = promoRedeemSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Promo code is invalid' });
  try { return response.json(await promotions.redeem(ownerSessionId, parsed.data.code)); } catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : 'Promo could not be redeemed' }); }
});
app.post('/api/wallet/challenge', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  if (!walletLimit.take(`${request.ip}:challenge`)) return response.status(429).json({ error: 'Too many wallet attempts—try again shortly' });
  const parsed = walletChallengeSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Wallet address is invalid' });
  try { return response.status(201).json(await minting.createChallenge(ownerSessionId, parsed.data.address)); } catch (error) { return sendMintError(response, error); }
});
app.post('/api/wallet/verify', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  if (!walletLimit.take(`${request.ip}:verify`)) return response.status(429).json({ error: 'Too many wallet attempts—try again shortly' });
  const parsed = walletVerifySchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Wallet proof is invalid' });
  try { return response.json(await minting.verifyWallet(ownerSessionId, parsed.data.challengeId, parsed.data.address, parsed.data.signature)); } catch (error) { return sendMintError(response, error); }
});
app.get('/api/progression', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request);
  if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  const player = await progression.getPlayer(ownerSessionId);
  return player ? response.json(publicProgression(player)) : response.status(404).json({ error: 'Player profile not found' });
});
app.get('/api/season/items', (_request, response) => response.json(SEASON_ITEMS));
app.get('/api/leaderboards', async (request, response) => {
  const period = leaderboardPeriodSchema.catch('weekly').parse(request.query.period);
  return response.json(await progression.leaderboard(period, Date.now(), 100));
});
app.post('/api/progression/equip', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  const parsed = equipItemSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Cosmetic selection is invalid' });
  try { return response.json(publicProgression(await progression.equipItem(ownerSessionId, parsed.data.itemId))); }
  catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : 'Cosmetic could not be equipped' }); }
});
app.post('/api/progression/rewards/:rewardId/acknowledge', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request);
  if (!ownerSessionId) return response.status(401).json({ error: 'Player authentication required' });
  const rewardId = z.string().uuid().safeParse(request.params.rewardId);
  if (!rewardId.success) return response.status(400).json({ error: 'Reward ID is invalid' });
  try { return response.json(publicProgression(await progression.acknowledge(ownerSessionId, rewardId.data))); }
  catch { return response.status(404).json({ error: 'Reward not found' }); }
});
app.get('/api/artworks', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request);
  if (!ownerSessionId) return response.status(401).json({ error: 'Vault authentication required' });
  return response.json(await artwork.listByOwner(ownerSessionId));
});
const rewardFields = {
  kind: z.enum(['mint-credit', 'mint-discount', 'xp', 'item', 'achievement', 'battle-pass']), amount: z.number().int().min(1).max(100_000),
  discountBps: z.number().int().min(100).max(10_000).optional(),
  itemId: z.string().trim().min(2).max(80).optional(), reason: z.string().trim().min(3).max(240),
  campaignId: z.string().trim().min(2).max(80).optional(), expiresAt: z.number().int().positive().optional(),
} as const;
const grantSchema = z.object({ ...rewardFields, sessionIds: z.array(z.string().uuid()).min(1).max(500), idempotencyKey: z.string().trim().min(8).max(120) })
  .refine((value) => !['item', 'achievement'].includes(value.kind) || Boolean(value.itemId), { message: 'This reward requires an item ID' }).refine((value) => value.kind !== 'mint-discount' || Boolean(value.discountBps), { message: 'This reward requires a discount percentage' });
const allPlayerCampaignSchema = z.object({ ...rewardFields, idempotencyKey: z.string().trim().min(8).max(120), dryRun: z.boolean().default(true), confirmation: z.string().optional() })
  .refine((value) => !['item', 'achievement'].includes(value.kind) || Boolean(value.itemId), { message: 'This reward requires an item ID' }).refine((value) => value.kind !== 'mint-discount' || Boolean(value.discountBps), { message: 'This reward requires a discount percentage' });
app.post('/api/artworks', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request);
  if (!ownerSessionId) return response.status(401).json({ error: 'Vault authentication required' });
  const parsed = artworkSchema.safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Artwork package is invalid' });
  try { return response.status(201).json(await artwork.save({ ...parsed.data, ownerSessionId })); }
  catch (error) { return response.status(400).json({ error: error instanceof Error ? error.message : 'Could not save artwork' }); }
});
app.post('/api/artworks/:artworkId/mint/prepare', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Vault authentication required' });
  const artworkId = z.string().uuid().safeParse(request.params.artworkId); if (!artworkId.success) return response.status(400).json({ error: 'Artwork ID is invalid' });
  try { return response.status(201).json(await minting.prepare(ownerSessionId, artworkId.data)); } catch (error) { return sendMintError(response, error); }
});
app.get('/api/artworks/:artworkId/mint', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Vault authentication required' });
  const artworkId = z.string().uuid().safeParse(request.params.artworkId); if (!artworkId.success) return response.status(400).json({ error: 'Artwork ID is invalid' });
  const mint = await minting.getForArtwork(ownerSessionId, artworkId.data); return mint ? response.json(mint) : response.status(404).json({ error: 'No mint attempt exists for this artwork' });
});
app.post('/api/mints/:mintId/confirm', async (request, response) => {
  const ownerSessionId = await playerIdFromRequest(request); if (!ownerSessionId) return response.status(401).json({ error: 'Vault authentication required' });
  const mintId = z.string().uuid().safeParse(request.params.mintId); const input = transactionHashSchema.safeParse(request.body);
  if (!mintId.success || !input.success) return response.status(400).json({ error: 'Mint confirmation is invalid' });
  try { const result = await minting.confirm(ownerSessionId, mintId.data, input.data.transactionHash); return response.status(result.pending ? 202 : 200).json(result); } catch (error) { return sendMintError(response, error); }
});

app.get('/api/admin/overview', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'viewer'); if (!principal) return response.status(adminStatus()).json({ error: adminError() });
  const players = await progression.listPlayers(); const now = Date.now();
  const availableMintCredits = players.reduce((total, player) => total + player.rewards.filter((reward) => reward.kind === 'mint-credit' && (!reward.expiresAt || reward.expiresAt > now)).reduce((sum, reward) => sum + Math.max(0, reward.amount - (reward.redeemedAmount ?? (reward.redeemedAt ? reward.amount : 0))), 0), 0);
  const promotionList = await promotions.list();
  return response.json({ actor: { name: principal.name, role: principal.role }, season: { id: 'season-0', name: 'The First Mess' }, players: players.length, availableMintCredits, rooms: rooms.size, moderation: await reports.counts(), minting: minting.status(), mintOps: await mintRepository.adminSnapshot(12), promotions: { total: promotionList.length, active: promotionList.filter((campaign) => campaign.status === 'active').length, campaigns: promotionList.slice(0, 20), audit: await promotions.audit(12) }, audit: await progression.audit(12) });
});
app.get('/api/admin/players', async (request, response) => {
  if (!authorizeAdmin(request.headers.authorization, request.ip, 'viewer')) return response.status(adminStatus()).json({ error: adminError() });
  const search = z.string().max(80).catch('').parse(request.query.search); return response.json(await progression.listPlayers(search));
});
app.get('/api/admin/leaderboard-prizes/preview', async (request, response) => {
  if (!authorizeAdmin(request.headers.authorization, request.ip, 'viewer')) return response.status(adminStatus()).json({ error: adminError() });
  const period = z.enum(['weekly', 'monthly']).catch('weekly').parse(request.query.period);
  const board = await progression.leaderboard(period, closedPeriodReference(period, Date.now()), 10);
  return response.json({ ...board, label: `Most recently closed ${period === 'weekly' ? 'week' : 'month'} · ${board.periodKey}` });
});
app.post('/api/admin/leaderboard-prizes/award', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  const parsed = z.object({ period: z.enum(['weekly', 'monthly']), periodKey: z.string().min(4).max(16), confirmation: z.literal('AWARD LEADERBOARD PRIZES') }).safeParse(request.body);
  if (!parsed.success) return response.status(400).json({ error: 'Prize confirmation is invalid' });
  const board = await progression.leaderboard(parsed.data.period, closedPeriodReference(parsed.data.period, Date.now()), 10);
  if (board.periodKey !== parsed.data.periodKey) return response.status(409).json({ error: 'That leaderboard period is no longer current. Preview again.' });
  const winners = board.entries.filter((entry) => entry.rank <= 3); const results: Array<{ sessionId: string; name: string; rank: number; granted: number }> = [];
  for (const winner of winners) {
    const prefix = `leaderboard-${board.period}-${board.periodKey}-rank-${winner.rank}`;
    const badge = await progression.grant({ sessionIds: [winner.sessionId], kind: 'achievement', amount: 1, itemId: `${prefix}-badge`, reason: `${board.label} · leaderboard rank #${winner.rank}`, campaignId: `${prefix}-badge`, idempotencyKey: `${prefix}-${winner.sessionId}-badge`, actor: `backstage:${principal.name}` });
    const value = board.period === 'weekly' ? [750, 500, 300][winner.rank - 1]! : [2, 1, 1][winner.rank - 1]!;
    const reward = await progression.grant({ sessionIds: [winner.sessionId], kind: board.period === 'weekly' ? 'xp' : 'mint-credit', amount: value, reason: `${board.label} · leaderboard prize #${winner.rank}`, campaignId: `${prefix}-reward`, idempotencyKey: `${prefix}-${winner.sessionId}-reward`, actor: `backstage:${principal.name}` });
    results.push({ sessionId: winner.sessionId, name: winner.name, rank: winner.rank, granted: badge.granted + reward.granted });
  }
  return response.status(201).json({ period: board.period, periodKey: board.periodKey, winners: results });
});
app.post('/api/admin/grants', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'operator'); if (!principal) return response.status(adminStatus()).json({ error: adminError('operator') });
  const parsed = grantSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Reward grant is invalid' });
  return response.status(201).json(await progression.grant({ ...parsed.data, actor: `backstage:${principal.name}` }));
});
app.post('/api/admin/campaigns/all-players', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  const parsed = allPlayerCampaignSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Campaign is invalid' });
  const players = await progression.listPlayers();
  if (parsed.data.dryRun) return response.json({ dryRun: true, eligiblePlayers: players.length, reward: parsed.data });
  if (parsed.data.confirmation !== 'GRANT TO ALL PLAYERS') return response.status(400).json({ error: 'Bulk campaign confirmation is required' });
  const { kind, amount, discountBps, itemId, reason, campaignId, expiresAt, idempotencyKey } = parsed.data;
  return response.status(201).json(await progression.grant({ kind, amount, discountBps, itemId, reason, campaignId, expiresAt, idempotencyKey, sessionIds: players.map((player) => player.sessionId), actor: `backstage:${principal.name}` }));
});
app.get('/api/admin/promotions', async (request, response) => {
  if (!authorizeAdmin(request.headers.authorization, request.ip, 'viewer')) return response.status(adminStatus()).json({ error: adminError() }); return response.json(await promotions.list());
});
app.post('/api/admin/promotions', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  const parsed = promotionSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Promotion is invalid' });
  try { const { expiresInDays, ...campaign } = parsed.data; return response.status(201).json(await promotions.create({ ...campaign, expiresAt: Date.now() + expiresInDays * 86_400_000 }, `backstage:${principal.name}`)); } catch (error) { return response.status(409).json({ error: error instanceof Error ? error.message : 'Promotion could not be created' }); }
});
app.post('/api/admin/promotions/:promotionId/pause', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  const id = z.string().uuid().safeParse(request.params.promotionId); const input = z.object({ paused: z.boolean() }).safeParse(request.body); if (!id.success || !input.success) return response.status(400).json({ error: 'Promotion update is invalid' });
  try { return response.json(await promotions.setPaused(id.data, input.data.paused, `backstage:${principal.name}`)); } catch (error) { return response.status(404).json({ error: error instanceof Error ? error.message : 'Promotion not found' }); }
});
app.get('/api/admin/reports', async (request, response) => {
  if (!authorizeAdmin(request.headers.authorization, request.ip, 'viewer')) return response.status(adminStatus()).json({ error: adminError() });
  const status = request.query.status === undefined ? undefined : reportStatusSchema.safeParse(request.query.status);
  if (status && !status.success) return response.status(400).json({ error: 'Report status filter is invalid' });
  return response.json(await reports.list(status?.data, 200));
});
app.post('/api/admin/reports/:reportId/status', async (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'operator'); if (!principal) return response.status(adminStatus()).json({ error: adminError('operator') });
  const reportId = z.string().uuid().safeParse(request.params.reportId); const input = reportUpdateSchema.safeParse(request.body);
  if (!reportId.success || !input.success) return response.status(400).json({ error: 'Report review update is invalid' });
  try { return response.json(await reports.update(reportId.data, input.data.status, `backstage:${principal.name}`, input.data.resolutionNote, Date.now())); }
  catch (error) { return response.status(404).json({ error: error instanceof Error ? error.message : 'Report not found' }); }
});
app.post('/api/admin/contract-access/prepare', (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  const parsed = contractAccessSchema.safeParse(request.body); if (!parsed.success) return response.status(400).json({ error: 'Contract access action is invalid' });
  try { return response.json(minting.prepareContractAccessTransaction(parsed.data)); } catch (error) { return sendMintError(response, error); }
});
app.get('/api/admin/contract-deployment/prepare', (request, response) => {
  const principal = authorizeAdmin(request.headers.authorization, request.ip, 'admin'); if (!principal) return response.status(adminStatus()).json({ error: adminError('admin') });
  try { return response.json(preparePanicArchiveDeployment(minting.config)); } catch (error) { return sendMintError(response, error); }
});

io.on('connection', (socket) => {
  let sessionId: string | null = null;
  let playerName = '';
  let equipped: { avatar?: string; title?: string; frame?: string; reaction?: string } = {};

  socket.on('session:resume', async (payload, ack) => {
    const parsed = sessionSchema.safeParse(payload);
    if (!parsed.success) return ack({ ok: false, error: 'Choose a name between 2 and 20 characters' });
    const device = await accounts.fromSessionToken(cookieValue(socket.handshake.headers.cookie, SESSION_COOKIE));
    if (device) {
      sessionId = device.account.id;
      playerName = device.account.name;
    } else if (parsed.data.credential) {
      const legacyAccount = await accounts.fromLegacyCredential(parsed.data.credential);
      if (!legacyAccount) return ack({ ok: false, error: 'Your player session expired—restore this Vault or choose a new name' });
      sessionId = legacyAccount.id;
      playerName = legacyAccount.name;
    }
    else return ack({ ok: false, error: 'Your player session expired—sign in again' });
    try { equipped = (await progression.ensurePlayer(sessionId, playerName)).equipped; }
    catch { return ack({ ok: false, error: 'Could not load your player profile' }); }
    ack({ ok: true, data: { sessionId, name: playerName } });
    for (const room of rooms.values()) {
      if (!room.hasSession(sessionId)) continue;
      const replacedSocketId = room.socketIdForSession(sessionId);
      room.join(sessionId, socket.id, playerName, equipped);
      socket.join(room.id);
      if (replacedSocketId && replacedSocketId !== socket.id) {
        const replacedSocket = io.sockets.sockets.get(replacedSocketId);
        replacedSocket?.emit('room:error', 'This player session moved to another tab');
        replacedSocket?.leave(room.id);
      }
      socket.emit('room:state', room.view());
      const brief = room.currentBriefForSession(sessionId); if (brief) socket.emit('round:brief', brief);
      const reveal = room.currentReveal(); if (reveal) socket.emit('round:reveal', reveal);
      const match = room.matchResult(); if (match) socket.emit('match:complete', match);
      break;
    }
  });

  socket.on('rooms:subscribe', () => socket.emit('rooms:list', publicRooms()));

  socket.on('room:create', (payload, ack) => guarded(socket.id, ack, async () => {
    requireSession(sessionId);
    requireCurrentSocketOrNoRoom(sessionId, socket.id);
    const input = roomCreateSchema.parse(payload);
    equipped = (await progression.getPlayer(sessionId!))?.equipped ?? equipped;
    leaveCurrent(sessionId!, socket.id);
    const room = new GameRoom(input.name, input.category, input.isPrivate, input.maxPlayers, input.roundSeconds * 1000);
    rooms.set(room.id, room); bindRoom(room);
    socket.join(room.id); room.join(sessionId!, socket.id, playerName, equipped); socket.emit('room:state', room.view());
    broadcastRooms();
    return { room: room.view(), inviteCode: room.inviteCode ?? undefined };
  }));

  socket.on('room:join', (payload, ack) => guarded(socket.id, ack, async () => {
    requireSession(sessionId);
    requireCurrentSocketOrNoRoom(sessionId, socket.id);
    const input = roomJoinSchema.parse(payload);
    const room = input.inviteCode
      ? [...rooms.values()].find((candidate) => candidate.inviteCode === input.inviteCode?.toUpperCase())
      : rooms.get(input.roomId!);
    if (!room) throw new Error('Arena not found');
    if (room.isPrivate && room.inviteCode !== input.inviteCode?.toUpperCase()) throw new Error('Invite code required');
    equipped = (await progression.getPlayer(sessionId!))?.equipped ?? equipped;
    leaveCurrent(sessionId!, socket.id);
    socket.join(room.id); room.join(sessionId!, socket.id, playerName, equipped); socket.emit('room:state', room.view()); broadcastRooms();
    return { room: room.view() };
  }));

  socket.on('room:leave', (ack) => guarded(socket.id, ack, () => { requireSession(sessionId); currentRoomForSocket(sessionId, socket.id); leaveCurrent(sessionId!, socket.id); return undefined; }));
  socket.on('player:ready', (payload, ack) => guarded(socket.id, ack, () => {
    const ready = z.boolean().parse(payload.ready); currentRoomForSocket(sessionId, socket.id).setReady(sessionId!, ready); return undefined;
  }));
  socket.on('player:kick', (payload, ack) => guarded(socket.id, ack, () => {
    const input = kickPlayerSchema.parse(payload);
    const room = currentRoomForSocket(sessionId, socket.id);
    const removed = room.kick(sessionId!, input.playerId);
    if (removed.socketId) {
      const removedSocket = io.sockets.sockets.get(removed.socketId);
      removedSocket?.emit('room:error', 'The host removed you from this arena');
      removedSocket?.leave(room.id);
    }
    broadcastRooms();
    return undefined;
  }));
  socket.on('player:report', (payload, ack) => guarded(socket.id, ack, async () => {
    const input = reportPlayerSchema.parse(payload); const room = currentRoomForSocket(sessionId, socket.id);
    if (!reportLimit.take(sessionId!)) { metricCounters.rateLimited += 1; throw new Error('You have sent several reports. Staff have them—please wait before sending another.'); }
    const identities = room.reportTarget(sessionId!, input.playerId);
    const report = await reports.create({ roomId: room.id, roomName: room.name, ...identities, category: input.category, detail: input.detail }, Date.now());
    log('warn', 'moderation.report_created', { reportId: report.id, roomId: room.id, category: report.category });
    return { reportId: report.id };
  }));
  socket.on('game:start', (ack) => guarded(socket.id, ack, () => { const room = currentRoomForSocket(sessionId, socket.id); room.start(sessionId!); return undefined; }));
  socket.on('game:rematch', (ack) => guarded(socket.id, ack, () => { const room = currentRoomForSocket(sessionId, socket.id); room.rematch(sessionId!); return undefined; }));
  socket.on('guess:submit', (payload, ack) => guarded(socket.id, ack, () => {
    if (!guessLimit.take(socket.id)) throw new Error('Easy—give the chat a second');
    const input = textSchema.parse(payload); currentRoomForSocket(sessionId, socket.id).submitGuess(sessionId!, input.text); return undefined;
  }));
  socket.on('chat:send', (payload, ack) => guarded(socket.id, ack, () => { const input = textSchema.parse(payload); currentRoomForSocket(sessionId, socket.id).sendChat(sessionId!, input.text); return undefined; }));
  socket.on('reaction:send', (payload, ack) => guarded(socket.id, ack, () => {
    const allowed = ['😂', '🔥', '💀', '👏', '🤯', '❤️', ...(equipped.reaction === 'screaming-pencil-reaction' ? ['✏️'] : []), ...(equipped.reaction === 'tiny-fire-reaction' ? ['🧨'] : [])];
    const emoji = z.string().refine((value) => allowed.includes(value), 'That reaction is not unlocked').parse(payload.emoji); currentRoomForSocket(sessionId, socket.id).react(sessionId!, emoji); return undefined;
  }));
  socket.on('draw:stroke', (stroke, ack) => guarded(socket.id, ack, () => {
    if (!drawLimit.take(socket.id)) throw new Error('Too many marks arrived at once—try that stroke again');
    const input = strokeSchema.parse(stroke); currentRoomForSocket(sessionId, socket.id).addStroke(sessionId!, input); return undefined;
  }));
  socket.on('draw:preview', (stroke) => { if (!previewLimit.take(socket.id)) return; const parsed = strokeSchema.safeParse(stroke); const room = currentRoomForSocketOrNull(sessionId, socket.id); if (parsed.success && sessionId && room) room.previewStroke(sessionId, parsed.data); });
  socket.on('draw:clear', () => { if (!drawLimit.take(socket.id)) return; const room = currentRoomForSocketOrNull(sessionId, socket.id); if (sessionId && room) room.clearCanvas(sessionId); });
  socket.on('draw:undo', () => { if (!drawLimit.take(socket.id)) return; const room = currentRoomForSocketOrNull(sessionId, socket.id); if (sessionId && room) room.undo(sessionId); });
  socket.on('round:keep', (payload, ack) => guarded(socket.id, ack, async () => {
    const input = keepRoundSchema.parse(payload);
    const room = currentRoomForSocket(sessionId, socket.id); room.keepRound(sessionId!, input.roundId);
    const round = room.rounds.find((value) => value.roundId === input.roundId)!;
    return artwork.save({ ownerSessionId: sessionId!, origin: 'arena', status: 'gallery', title: round.prompt, canvasRatio: room.canvasRatio,
      width: 1200, height: 1200, strokes: round.strokes, sourceRoundId: round.roundId });
  }));

  socket.on('disconnect', () => {
    if (!sessionId) return;
    currentRoomOrNull(sessionId)?.disconnect(sessionId, socket.id);
    actionLimit.forget(socket.id); guessLimit.forget(socket.id); drawLimit.forget(socket.id); previewLimit.forget(socket.id); broadcastRooms();
  });
});

function bindRoom(room: GameRoom): void {
  if (roomBindings.has(room.id)) return;
  roomBindings.add(room.id);
  room.on('state', (state) => { io.to(room.id).emit('room:state', state); broadcastRooms(); });
  room.on('feed', (item) => io.to(room.id).emit('feed:item', item));
  room.on('brief', (socketId, payload) => io.to(socketId).emit('round:brief', payload));
  room.on('stroke', (stroke, except) => socketBroadcastExcept(except, room.id, 'draw:stroke', stroke));
  room.on('preview', (stroke, except) => socketBroadcastExcept(except, room.id, 'draw:preview', stroke));
  room.on('clear', () => io.to(room.id).emit('draw:clear'));
  room.on('reveal', (result) => io.to(room.id).emit('round:reveal', result));
  room.on('complete', (result) => {
    io.to(room.id).emit('match:complete', result);
    void awardMatchProgress(result).catch((error) => log('error', 'progression.match_award_failed', { roomId: result.roomId, ...errorFields(error) }));
  });
}

async function awardMatchProgress(result: MatchResult): Promise<void> {
  const fastestGuess = result.rounds.flatMap((round) => round.correct).sort((a, b) => a.elapsedMs - b.elapsedMs)[0];
  await progression.recordMatch({ matchId: result.matchId, endedAt: Math.max(...result.rounds.map((round) => round.endedAt), Date.now()), players: result.standings.map((player) => ({
    sessionId: player.sessionId, gamePoints: player.score, won: result.winners.some((winner) => winner.sessionId === player.sessionId), sharedWin: result.winners.length > 1 && result.winners.some((winner) => winner.sessionId === player.sessionId),
    correctGuesses: result.rounds.reduce((total, round) => total + Number(round.correct.some((guess) => guess.playerId === player.id)), 0), fastestGuesses: fastestGuess && result.rounds.some((round) => round.correct.some((guess) => guess.playerId === player.id && guess.elapsedMs === fastestGuess.elapsedMs)) ? 1 : 0,
    drawings: result.rounds.filter((round) => round.drawerId === player.id && round.reason !== 'drawer-left').length,
  })) });
  for (const player of result.standings) {
    const matchKey = `match-${result.matchId}-${player.sessionId}`;
    const xp = 100 + Math.min(400, Math.floor(player.score / 100) * 25);
    await progression.grant({ sessionIds: [player.sessionId], kind: 'xp', amount: xp, reason: `Finished a match · +${xp} Season XP`, campaignId: `${matchKey}-xp`, idempotencyKey: `${matchKey}-xp`, actor: 'system:match' });
    await progression.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'first-mess', reason: 'Played your first complete Sketch Arena match', campaignId: 'achievement-first-mess', idempotencyKey: `${matchKey}-first-mess`, actor: 'system:match' });
    if (result.winners.some((winner) => winner.sessionId === player.sessionId)) await progression.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'crowned-chaos', reason: result.winners.length > 1 ? 'Shared the Sketch Arena crown' : 'Won a Sketch Arena match', campaignId: 'achievement-crowned-chaos', idempotencyKey: `${matchKey}-winner`, actor: 'system:match' });
    if (fastestGuess && result.rounds.some((round) => round.correct.some((guess) => guess.playerId === player.id && guess.elapsedMs === fastestGuess.elapsedMs))) await progression.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'panic-button', reason: 'Landed the fastest correct guess in a match', campaignId: 'achievement-panic-button', idempotencyKey: `${matchKey}-fastest`, actor: 'system:match' });
    if (result.rounds.some((round) => round.drawerId === player.id && round.strokes.length >= 5)) await progression.grant({ sessionIds: [player.sessionId], kind: 'achievement', amount: 1, itemId: 'certified-mess', reason: 'Finished a drawing with at least five marks', campaignId: 'achievement-certified-mess', idempotencyKey: `${matchKey}-artist`, actor: 'system:match' });
  }
}

function socketBroadcastExcept(socketId: string, roomId: string, event: 'draw:stroke' | 'draw:preview', stroke: Stroke): void {
  io.sockets.sockets.get(socketId)?.to(roomId).emit(event, stroke);
}
function publicRooms() { return [...rooms.values()].filter((room) => !room.isPrivate).map((room) => room.summary()).filter((room) => room.playerCount > 0); }
function broadcastRooms(): void { io.emit('rooms:list', publicRooms()); }
function currentRoom(sessionId: string | null): GameRoom { const room = currentRoomOrNull(sessionId); if (!room) throw new Error('Join an arena first'); return room; }
function currentRoomOrNull(sessionId: string | null): GameRoom | null { if (!sessionId) return null; return [...rooms.values()].find((room) => room.hasSession(sessionId)) ?? null; }
function currentRoomForSocket(sessionId: string | null, socketId: string): GameRoom {
  const room = currentRoom(sessionId);
  if (!sessionId || !room.ownsSocket(sessionId, socketId)) throw new Error('This player session moved to another tab');
  return room;
}
function currentRoomForSocketOrNull(sessionId: string | null, socketId: string): GameRoom | null {
  const room = currentRoomOrNull(sessionId);
  return room && sessionId && room.ownsSocket(sessionId, socketId) ? room : null;
}
function requireCurrentSocketOrNoRoom(sessionId: string, socketId: string): void {
  const room = currentRoomOrNull(sessionId);
  if (room && !room.ownsSocket(sessionId, socketId)) throw new Error('This player session moved to another tab');
}
function leaveCurrent(sessionId: string, socketId?: string): void {
  const room = currentRoomOrNull(sessionId); if (!room) return;
  room.leaveBySession(sessionId);
  if (socketId) io.sockets.sockets.get(socketId)?.leave(room.id);
  if (room.isEmpty()) { room.close(); rooms.delete(room.id); roomBindings.delete(room.id); }
  broadcastRooms();
}
function requireSession(sessionId: string | null): asserts sessionId is string { if (!sessionId) throw new Error('Session not ready'); }
function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) { const [key, ...rest] = part.trim().split('='); if (key === name) return decodeURIComponent(rest.join('=')); }
  return undefined;
}
function legacyCredentialFromAuthorization(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([0-9a-f]{64})$/i); return match?.[1] ?? null;
}
async function playerAccountFromRequest(request: express.Request) {
  return accounts.fromSessionToken(cookieValue(request.headers.cookie, SESSION_COOKIE));
}
async function playerIdFromRequest(request: express.Request): Promise<string | null> {
  const account = await playerAccountFromRequest(request); return account?.account.id ?? null;
}
function setPlayerCookie(response: express.Response, token: string, expiresAt: number): void {
  response.cookie(SESSION_COOKIE, token, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/', expires: new Date(expiresAt), priority: 'high' });
}
function clearPlayerCookie(response: express.Response): void { response.clearCookie(SESSION_COOKIE, { httpOnly: true, secure: COOKIE_SECURE, sameSite: 'lax', path: '/' }); }
function publicAccount(account: { id: string; name: string; securedAt?: number; createdAt: number }, sessionId: string) { return { id: account.id, name: account.name, secured: Boolean(account.securedAt), securedAt: account.securedAt, createdAt: account.createdAt, sessionId }; }
function publicProgression(player: PlayerProgress): PlayerProgress {
  const secretCampaign = 'season-0-founding-weirdos-season-1-premium';
  return { ...player, passEntitlements: player.passEntitlements.filter((value) => value !== 'season-1-premium'), rewards: player.rewards.filter((reward) => reward.campaignId !== secretCampaign) };
}
function authorizeAdmin(authorization: string | undefined, ip: string | undefined, required: BackstageRole) {
  if (!adminLimit.take(ip ?? 'unknown')) return null;
  return backstageAuth.authorize(authorization, required);
}
function adminStatus(): number { return backstageAuth.configured ? 401 : 503; }
function adminError(required?: BackstageRole): string { return backstageAuth.error(required); }
function authorizeMetrics(authorization: string | undefined): boolean {
  const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  if (!METRICS_TOKEN_HASH || supplied.length < 32) return false;
  return timingSafeEqual(METRICS_TOKEN_HASH, createHash('sha256').update(supplied).digest());
}
function prometheusLabel(value: string): string { return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').slice(0, 120); }
function closedPeriodReference(period: 'weekly' | 'monthly', now: number): number { if (period === 'weekly') return now - 7 * 86_400_000; const date = new Date(now); return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 15); }
function sendMintError(response: express.Response, error: unknown): express.Response { return response.status(error instanceof MintServiceError ? error.status : 500).json({ error: error instanceof Error ? error.message : 'Minting could not continue' }); }
function guarded<T>(key: string, ack: (value: { ok: boolean; data?: T; error?: string }) => void, action: () => T | Promise<T>): void {
  if (!actionLimit.take(key)) { metricCounters.rateLimited += 1; metricCounters.socketRejected += 1; return ack({ ok: false, error: 'Slow down for a moment' }); }
  Promise.resolve().then(action).then((data) => ack({ ok: true, data }), (error: unknown) => { metricCounters.socketRejected += 1; ack({ ok: false, error: error instanceof Error ? error.message : 'Something went wrong' }); });
}

setInterval(() => {
  for (const [id, room] of rooms) {
    room.removeExpiredDisconnects();
    if (room.isEmpty()) { room.close(); rooms.delete(id); roomBindings.delete(id); }
  }
  broadcastRooms();
}, 5_000).unref();

server.listen(PORT, BIND_HOST, () => { operations.markReady(); log('info', 'server.ready', { host: BIND_HOST, port: PORT }); });
server.on('error', (error) => { log('error', 'server.listen_failed', errorFields(error)); if (!operations.isDraining()) process.exit(1); });

function shutdown(signal: string): void {
  if (!operations.beginShutdown()) return;
  log('info', 'server.shutdown_started', { signal, rooms: rooms.size, connections: io.engine.clientsCount });
  for (const room of rooms.values()) room.close();
  io.close(() => server.close(async () => { if (databasePool) await databasePool.end().catch((error) => log('error', 'database.shutdown_failed', errorFields(error))); log('info', 'server.shutdown_complete', { signal }); process.exit(0); }));
  setTimeout(() => { log('error', 'server.shutdown_forced', { signal }); process.exit(1); }, 8_000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));
process.once('uncaughtException', (error) => { log('error', 'process.uncaught_exception', errorFields(error)); shutdown('uncaughtException'); });
process.once('unhandledRejection', (error) => { log('error', 'process.unhandled_rejection', errorFields(error)); shutdown('unhandledRejection'); });
