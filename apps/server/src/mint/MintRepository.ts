import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { MintPreparation } from '@sketch-arena/protocol';

export interface WalletBindingRecord { sessionId: string; address: `0x${string}`; verifiedAt: number; }
export interface WalletChallengeRecord { id: string; sessionId: string; address: `0x${string}`; message: string; expiresAt: number; createdAt: number; usedAt?: number; }
export interface MintRecord extends MintPreparation { ownerSessionId: string; creditRewardId?: string; creditUnit?: number; discountRewardId?: string; discountUnit?: number; createdAt: number; updatedAt: number; }
interface MintState { challenges: WalletChallengeRecord[]; bindings: WalletBindingRecord[]; mints: MintRecord[]; }

export interface MintRepository {
  createChallenge(input: Omit<WalletChallengeRecord, 'id' | 'createdAt'>, now: number): Promise<WalletChallengeRecord>;
  claimChallenge(id: string, sessionId: string, address: `0x${string}`, now: number): Promise<WalletChallengeRecord>;
  bindWallet(sessionId: string, address: `0x${string}`, now: number): Promise<WalletBindingRecord>;
  getBinding(sessionId: string): Promise<WalletBindingRecord | null>;
  getMint(id: string, sessionId: string): Promise<MintRecord | null>;
  getMintByArtwork(artworkId: string, sessionId: string): Promise<MintRecord | null>;
  listMints(sessionId: string): Promise<MintRecord[]>;
  listCreditReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>>;
  listDiscountReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>>;
  saveMint(record: MintRecord): Promise<MintRecord>;
  adminSnapshot(limit?: number): Promise<{ wallets: number; total: number; prepared: number; submitted: number; confirmed: number; failed: number; recent: Array<Pick<MintRecord, 'id' | 'artworkId' | 'ownerSessionId' | 'status' | 'walletAddress' | 'usesMintCredit' | 'discountBps' | 'expiresAt' | 'transactionHash' | 'tokenId' | 'error' | 'createdAt' | 'updatedAt'>> }>;
}

function cleanState(value?: Partial<MintState>): MintState {
  return { challenges: value?.challenges ?? [], bindings: value?.bindings ?? [], mints: value?.mints ?? [] };
}

function createChallengeInState(state: MintState, input: Omit<WalletChallengeRecord, 'id' | 'createdAt'>, now: number): WalletChallengeRecord {
  state.challenges = state.challenges.filter((challenge) => challenge.expiresAt > now - 86_400_000);
  const challenge = { ...input, id: randomUUID(), createdAt: now }; state.challenges.push(challenge); return challenge;
}

function claimChallengeInState(state: MintState, id: string, sessionId: string, address: `0x${string}`, now: number): WalletChallengeRecord {
  const challenge = state.challenges.find((candidate) => candidate.id === id && candidate.sessionId === sessionId && candidate.address.toLowerCase() === address.toLowerCase());
  if (!challenge) throw new Error('Wallet challenge not found');
  if (challenge.usedAt) throw new Error('Wallet challenge already used');
  if (challenge.expiresAt <= now) throw new Error('Wallet challenge expired');
  challenge.usedAt = now; return challenge;
}

function bindWalletInState(state: MintState, sessionId: string, address: `0x${string}`, now: number): WalletBindingRecord {
  const binding = { sessionId, address, verifiedAt: now }; const index = state.bindings.findIndex((candidate) => candidate.sessionId === sessionId);
  if (index >= 0) state.bindings[index] = binding; else state.bindings.push(binding); return binding;
}

function saveMintInState(state: MintState, record: MintRecord): MintRecord {
  const conflict = state.mints.find((candidate) => candidate.artworkId === record.artworkId && candidate.ownerSessionId !== record.ownerSessionId);
  if (conflict) throw new Error('Artwork mint owner mismatch');
  const index = state.mints.findIndex((candidate) => candidate.id === record.id);
  if (index >= 0) state.mints[index] = record; else state.mints.push(record); return record;
}

abstract class StatefulMintRepository implements MintRepository {
  protected abstract readState(): Promise<MintState>;
  protected abstract commit(state: MintState): Promise<void>;
  private operationQueue: Promise<unknown> = Promise.resolve();

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation); this.operationQueue = result.then(() => undefined, () => undefined); return result;
  }
  createChallenge(input: Omit<WalletChallengeRecord, 'id' | 'createdAt'>, now: number): Promise<WalletChallengeRecord> { return this.serial(async () => { const state = await this.readState(); const result = createChallengeInState(state, input, now); await this.commit(state); return structuredClone(result); }); }
  claimChallenge(id: string, sessionId: string, address: `0x${string}`, now: number): Promise<WalletChallengeRecord> { return this.serial(async () => { const state = await this.readState(); const result = claimChallengeInState(state, id, sessionId, address, now); await this.commit(state); return structuredClone(result); }); }
  bindWallet(sessionId: string, address: `0x${string}`, now: number): Promise<WalletBindingRecord> { return this.serial(async () => { const state = await this.readState(); const result = bindWalletInState(state, sessionId, address, now); await this.commit(state); return structuredClone(result); }); }
  async getBinding(sessionId: string): Promise<WalletBindingRecord | null> { return structuredClone((await this.readState()).bindings.find((binding) => binding.sessionId === sessionId) ?? null); }
  async getMint(id: string, sessionId: string): Promise<MintRecord | null> { return structuredClone((await this.readState()).mints.find((mint) => mint.id === id && mint.ownerSessionId === sessionId) ?? null); }
  async getMintByArtwork(artworkId: string, sessionId: string): Promise<MintRecord | null> { return structuredClone((await this.readState()).mints.find((mint) => mint.artworkId === artworkId && mint.ownerSessionId === sessionId) ?? null); }
  async listMints(sessionId: string): Promise<MintRecord[]> { return structuredClone((await this.readState()).mints.filter((mint) => mint.ownerSessionId === sessionId)); }
  async listCreditReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>> { return (await this.readState()).mints.filter((mint) => Boolean(mint.creditRewardId) && (mint.status === 'submitted' || (mint.status === 'prepared' && mint.expiresAt > now))).map((mint) => ({ rewardId: mint.creditRewardId!, unit: mint.creditUnit ?? 0 })); }
  async listDiscountReservations(now: number): Promise<Array<{ rewardId: string; unit: number }>> { return (await this.readState()).mints.filter((mint) => Boolean(mint.discountRewardId) && (mint.status === 'submitted' || (mint.status === 'prepared' && mint.expiresAt > now))).map((mint) => ({ rewardId: mint.discountRewardId!, unit: mint.discountUnit ?? 0 })); }
  saveMint(record: MintRecord): Promise<MintRecord> { return this.serial(async () => { const state = await this.readState(); const result = saveMintInState(state, record); await this.commit(state); return structuredClone(result); }); }
  async adminSnapshot(limit = 100): Promise<{ wallets: number; total: number; prepared: number; submitted: number; confirmed: number; failed: number; recent: Array<Pick<MintRecord, 'id' | 'artworkId' | 'ownerSessionId' | 'status' | 'walletAddress' | 'usesMintCredit' | 'discountBps' | 'expiresAt' | 'transactionHash' | 'tokenId' | 'error' | 'createdAt' | 'updatedAt'>> }> {
    const state = await this.readState(); const count = (status: MintRecord['status']) => state.mints.filter((mint) => mint.status === status).length;
    return { wallets: state.bindings.length, total: state.mints.length, prepared: count('prepared'), submitted: count('submitted'), confirmed: count('confirmed'), failed: count('failed'),
      recent: structuredClone([...state.mints].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, Math.max(1, Math.min(500, limit))).map(({ id, artworkId, ownerSessionId, status, walletAddress, usesMintCredit, discountBps, expiresAt, transactionHash, tokenId, error, createdAt, updatedAt }) => ({ id, artworkId, ownerSessionId, status, walletAddress, usesMintCredit, discountBps, expiresAt, transactionHash, tokenId, error, createdAt, updatedAt }))) };
  }
}

export class MemoryMintRepository extends StatefulMintRepository {
  private readonly state = cleanState();
  protected async readState(): Promise<MintState> { return this.state; }
  protected async commit(): Promise<void> {}
}

export class FileMintRepository extends StatefulMintRepository {
  private state: MintState | null = null;
  private writeQueue: Promise<void> = Promise.resolve();
  constructor(private readonly file = resolve(process.cwd(), '.data', 'mint-lifecycle.json')) { super(); }
  protected async readState(): Promise<MintState> {
    if (this.state) return this.state;
    try { this.state = cleanState(JSON.parse(await readFile(this.file, 'utf8')) as MintState); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.state = cleanState(); }
    return this.state;
  }
  protected async commit(state: MintState): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => { await mkdir(dirname(this.file), { recursive: true }); const temporary = `${this.file}.${process.pid}.tmp`; await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8'); await rename(temporary, this.file); });
    return this.writeQueue;
  }
}
