import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

export type PasskeyTransport = 'ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb';

export interface PlayerAccount {
  id: string;
  name: string;
  legacyCredentialHash?: string;
  securedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlayerDeviceSession {
  id: string;
  accountId: string;
  tokenHash: string;
  label: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface PlayerPasskey {
  id: string;
  accountId: string;
  webauthnUserId: string;
  publicKey: string;
  counter: number;
  deviceType: 'singleDevice' | 'multiDevice';
  backedUp: boolean;
  transports?: PasskeyTransport[];
  label: string;
  createdAt: number;
  lastUsedAt?: number;
}

export interface AccountChallenge {
  id: string;
  kind: 'registration' | 'authentication';
  challenge: string;
  accountId?: string;
  createdAt: number;
  expiresAt: number;
}

interface AccountState {
  version: 1;
  accounts: PlayerAccount[];
  sessions: PlayerDeviceSession[];
  passkeys: PlayerPasskey[];
  challenges: AccountChallenge[];
}

export interface AccountRepository {
  findAccount(id: string): Promise<PlayerAccount | null>;
  findByNameKey(nameKey: string): Promise<PlayerAccount | null>;
  findByLegacyCredentialHash(hash: string): Promise<PlayerAccount | null>;
  findByPasskeyId(id: string): Promise<{ account: PlayerAccount; passkey: PlayerPasskey } | null>;
  saveAccount(account: PlayerAccount): Promise<void>;
  saveSession(session: PlayerDeviceSession): Promise<void>;
  findSessionByTokenHash(hash: string, now: number): Promise<{ account: PlayerAccount; session: PlayerDeviceSession } | null>;
  revokeSession(id: string, accountId: string, now: number): Promise<boolean>;
  listSessions(accountId: string, now: number): Promise<PlayerDeviceSession[]>;
  savePasskey(passkey: PlayerPasskey): Promise<void>;
  listPasskeys(accountId: string): Promise<PlayerPasskey[]>;
  updatePasskeyCounter(id: string, counter: number, usedAt: number): Promise<void>;
  saveChallenge(challenge: AccountChallenge): Promise<void>;
  consumeChallenge(id: string, kind: AccountChallenge['kind'], now: number): Promise<AccountChallenge | null>;
}

const emptyState = (): AccountState => ({ version: 1, accounts: [], sessions: [], passkeys: [], challenges: [] });

abstract class StatefulAccountRepository implements AccountRepository {
  protected abstract readState(): Promise<AccountState>;
  protected abstract commit(state: AccountState): Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation); this.queue = result.then(() => undefined, () => undefined); return result;
  }
  async findAccount(id: string): Promise<PlayerAccount | null> { return structuredClone((await this.readState()).accounts.find((item) => item.id === id) ?? null); }
  async findByNameKey(nameKey: string): Promise<PlayerAccount | null> { return structuredClone((await this.readState()).accounts.find((item) => playerNameKey(item.name) === nameKey) ?? null); }
  async findByLegacyCredentialHash(hash: string): Promise<PlayerAccount | null> { return structuredClone((await this.readState()).accounts.find((item) => item.legacyCredentialHash === hash) ?? null); }
  async findByPasskeyId(id: string): Promise<{ account: PlayerAccount; passkey: PlayerPasskey } | null> {
    const state = await this.readState(); const passkey = state.passkeys.find((item) => item.id === id); if (!passkey) return null;
    const account = state.accounts.find((item) => item.id === passkey.accountId); return account ? structuredClone({ account, passkey }) : null;
  }
  saveAccount(account: PlayerAccount): Promise<void> { return this.serial(async () => { const state = await this.readState(); const at = state.accounts.findIndex((item) => item.id === account.id); if (at >= 0) state.accounts[at] = structuredClone(account); else state.accounts.push(structuredClone(account)); await this.commit(state); }); }
  saveSession(session: PlayerDeviceSession): Promise<void> { return this.serial(async () => { const state = await this.readState(); const at = state.sessions.findIndex((item) => item.id === session.id); if (at >= 0) state.sessions[at] = structuredClone(session); else state.sessions.push(structuredClone(session)); await this.commit(state); }); }
  findSessionByTokenHash(hash: string, now: number): Promise<{ account: PlayerAccount; session: PlayerDeviceSession } | null> { return this.serial(async () => {
    const state = await this.readState(); const session = state.sessions.find((item) => item.tokenHash === hash && !item.revokedAt && item.expiresAt > now); if (!session) return null;
    const account = state.accounts.find((item) => item.id === session.accountId); if (!account) return null;
    session.lastSeenAt = now; await this.commit(state); return structuredClone({ account, session });
  }); }
  revokeSession(id: string, accountId: string, now: number): Promise<boolean> { return this.serial(async () => { const state = await this.readState(); const session = state.sessions.find((item) => item.id === id && item.accountId === accountId); if (!session || session.revokedAt) return false; session.revokedAt = now; await this.commit(state); return true; }); }
  async listSessions(accountId: string, now: number): Promise<PlayerDeviceSession[]> { return structuredClone((await this.readState()).sessions.filter((item) => item.accountId === accountId && !item.revokedAt && item.expiresAt > now).sort((a, b) => b.lastSeenAt - a.lastSeenAt)); }
  savePasskey(passkey: PlayerPasskey): Promise<void> { return this.serial(async () => { const state = await this.readState(); if (state.passkeys.some((item) => item.id === passkey.id && item.accountId !== passkey.accountId)) throw new Error('Passkey is already registered'); const at = state.passkeys.findIndex((item) => item.id === passkey.id); if (at >= 0) state.passkeys[at] = structuredClone(passkey); else state.passkeys.push(structuredClone(passkey)); await this.commit(state); }); }
  async listPasskeys(accountId: string): Promise<PlayerPasskey[]> { return structuredClone((await this.readState()).passkeys.filter((item) => item.accountId === accountId)); }
  updatePasskeyCounter(id: string, counter: number, usedAt: number): Promise<void> { return this.serial(async () => { const state = await this.readState(); const passkey = state.passkeys.find((item) => item.id === id); if (!passkey) throw new Error('Passkey not found'); passkey.counter = counter; passkey.lastUsedAt = usedAt; await this.commit(state); }); }
  saveChallenge(challenge: AccountChallenge): Promise<void> { return this.serial(async () => { const state = await this.readState(); state.challenges = state.challenges.filter((item) => item.expiresAt > challenge.createdAt && !(challenge.accountId && item.kind === challenge.kind && item.accountId === challenge.accountId)); state.challenges.push(structuredClone(challenge)); await this.commit(state); }); }
  consumeChallenge(id: string, kind: AccountChallenge['kind'], now: number): Promise<AccountChallenge | null> { return this.serial(async () => { const state = await this.readState(); const at = state.challenges.findIndex((item) => item.id === id && item.kind === kind && item.expiresAt > now); if (at < 0) return null; const [challenge] = state.challenges.splice(at, 1); await this.commit(state); return structuredClone(challenge ?? null); }); }
}

export class MemoryAccountRepository extends StatefulAccountRepository {
  private readonly state = emptyState();
  protected async readState(): Promise<AccountState> { return this.state; }
  protected async commit(): Promise<void> {}
}

export class FileAccountRepository extends StatefulAccountRepository {
  private state: AccountState | null = null; private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), '.data', 'accounts.json')) { super(); }
  protected async readState(): Promise<AccountState> {
    if (this.state) return this.state;
    try { const parsed = JSON.parse(await readFile(this.file, 'utf8')) as Partial<AccountState>; this.state = { version: 1, accounts: parsed.accounts ?? [], sessions: parsed.sessions ?? [], passkeys: parsed.passkeys ?? [], challenges: parsed.challenges ?? [] }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = emptyState(); }
    return this.state;
  }
  protected async commit(state: AccountState): Promise<void> { this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 }); await rename(temporary, this.file); }); return this.writeQueue; }
}

export const hashSecret = (value: string): string => createHash('sha256').update(value).digest('hex');
export const createSecret = (): string => randomBytes(32).toString('base64url');
export const safeSecretEqual = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex'); return a.length === b.length && timingSafeEqual(a, b);
};

export class AccountService {
  constructor(private readonly repository: AccountRepository, private readonly sessionTtlMs = 30 * 24 * 60 * 60 * 1000) {}
  async migrateLegacy(credential: string, name: string, label: string, now = Date.now()): Promise<{ account: PlayerAccount; token: string; session: PlayerDeviceSession }> {
    const legacyCredentialHash = hashSecret(credential.toLowerCase());
    const existing = await this.repository.findByLegacyCredentialHash(legacyCredentialHash);
    const canonicalName = canonicalPlayerName(name);
    const claimed = await this.repository.findByNameKey(playerNameKey(canonicalName));
    if (!existing && claimed) throw new Error('That name is already claimed. Sign in to its account or choose another.');
    const account: PlayerAccount = existing ?? { id: legacyAccountId(credential), name: canonicalName, legacyCredentialHash, createdAt: now, updatedAt: now };
    await this.repository.saveAccount(account);
    const token = createSecret(); const session: PlayerDeviceSession = { id: randomUUID(), accountId: account.id, tokenHash: hashSecret(token), label: label.slice(0, 80), createdAt: now, lastSeenAt: now, expiresAt: now + this.sessionTtlMs };
    await this.repository.saveSession(session); return { account, token, session };
  }
  async fromSessionToken(token: string | undefined, now = Date.now()): Promise<{ account: PlayerAccount; session: PlayerDeviceSession } | null> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null; return this.repository.findSessionByTokenHash(hashSecret(token), now);
  }
  async fromLegacyCredential(credential: string | undefined): Promise<PlayerAccount | null> {
    if (!credential || !/^[0-9a-f]{64}$/i.test(credential)) return null; return this.repository.findByLegacyCredentialHash(hashSecret(credential.toLowerCase()));
  }
  async createChallenge(kind: AccountChallenge['kind'], challenge: string, accountId: string | undefined, now = Date.now()): Promise<AccountChallenge> {
    const value: AccountChallenge = { id: randomUUID(), kind, challenge, accountId, createdAt: now, expiresAt: now + 5 * 60_000 }; await this.repository.saveChallenge(value); return value;
  }
  consumeChallenge(id: string, kind: AccountChallenge['kind'], now = Date.now()): Promise<AccountChallenge | null> { return this.repository.consumeChallenge(id, kind, now); }
}

export function canonicalPlayerName(value: string): string { return value.normalize('NFKC').trim().replace(/\s+/g, ' '); }
export function playerNameKey(value: string): string { return canonicalPlayerName(value).toLocaleLowerCase('en-US'); }

function legacyAccountId(credential: string): string {
  const hex = createHash('sha256').update(credential).digest('hex').slice(0, 32).split(''); hex[12] = '4'; hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16); const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
