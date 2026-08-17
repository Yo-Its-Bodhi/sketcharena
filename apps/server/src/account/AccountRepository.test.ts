import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccountService, FileAccountRepository, MemoryAccountRepository } from './AccountRepository.js';

const credential = 'ab'.repeat(32);

describe('AccountService', () => {
  it('migrates the legacy identity without changing its durable player UUID', async () => {
    const repository = new MemoryAccountRepository(); const service = new AccountService(repository, 1_000);
    const first = await service.migrateLegacy(credential, 'Dru', 'Chrome · Windows', 10_000);
    const again = await service.migrateLegacy(credential, 'Dru Two', 'Phone', 10_100);
    expect(first.account.id).toBe('271a413b-d339-4570-9fdc-eaec41f14f11');
    expect(again.account.id).toBe(first.account.id);
    expect(await service.fromSessionToken(first.token, 10_999)).toMatchObject({ account: { id: first.account.id }, session: { label: 'Chrome · Windows' } });
    expect(await service.fromSessionToken(first.token, 11_001)).toBeNull();
  });

  it('stores only hashes of recovery and device secrets', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sketch-account-')); const file = join(directory, 'accounts.json');
    const service = new AccountService(new FileAccountRepository(file)); const created = await service.migrateLegacy(credential, 'Dru', 'Test device', 20_000);
    const stored = await readFile(file, 'utf8');
    expect(stored).not.toContain(credential);
    expect(stored).not.toContain(created.token);
    expect(stored).toContain('legacyCredentialHash');
    expect(stored).toContain('tokenHash');
  });

  it('consumes short-lived challenges once', async () => {
    const service = new AccountService(new MemoryAccountRepository()); const challenge = await service.createChallenge('registration', 'random-challenge', 'account', 30_000);
    expect(await service.consumeChallenge(challenge.id, 'registration', 30_100)).toEqual(challenge);
    expect(await service.consumeChallenge(challenge.id, 'registration', 30_200)).toBeNull();
  });

  it('keeps concurrent discoverable passkey sign-ins independent', async () => {
    const service = new AccountService(new MemoryAccountRepository());
    const first = await service.createChallenge('authentication', 'first-challenge', undefined, 35_000);
    const second = await service.createChallenge('authentication', 'second-challenge', undefined, 35_001);
    expect(await service.consumeChallenge(first.id, 'authentication', 35_002)).toEqual(first);
    expect(await service.consumeChallenge(second.id, 'authentication', 35_003)).toEqual(second);
  });

  it('revokes one device without affecting another', async () => {
    const repository = new MemoryAccountRepository(); const service = new AccountService(repository);
    const first = await service.migrateLegacy(credential, 'Dru', 'Laptop', 40_000); const second = await service.migrateLegacy(credential, 'Dru', 'Phone', 40_010);
    expect(await repository.revokeSession(first.session.id, first.account.id, 40_020)).toBe(true);
    expect(await service.fromSessionToken(first.token, 40_030)).toBeNull();
    expect(await service.fromSessionToken(second.token, 40_030)).not.toBeNull();
  });
});
