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
    expect(again.account).toMatchObject({ id: first.account.id, name: 'Dru' });
    expect(await service.fromSessionToken(first.token, 10_999)).toMatchObject({ account: { id: first.account.id }, session: { label: 'Chrome · Windows' } });
    expect(await service.fromSessionToken(first.token, 11_001)).toBeNull();
  });

  it('claims names case-insensitively and never lets login payloads rename an account', async () => {
    const repository = new MemoryAccountRepository(); const service = new AccountService(repository);
    const owner = await service.migrateLegacy('1'.repeat(64), '  Bodhi  ', 'Owner browser', 50_000);
    await expect(service.migrateLegacy('2'.repeat(64), 'bodhi', 'Impostor browser', 50_001)).rejects.toThrow('already claimed');
    const resumed = await service.migrateLegacy('1'.repeat(64), 'Not Bodhi', 'Second owner device', 50_002);
    expect(owner.account.name).toBe('Bodhi'); expect(resumed.account.name).toBe('Bodhi');
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

  it('creates password accounts, signs them in on another device and rejects the wrong password', async () => {
    const repository = new MemoryAccountRepository(); const service = new AccountService(repository);
    const created = await service.startWithPassword('3'.repeat(64), 'Password Weirdo', 'correct horse', 'Laptop', 25_000);
    expect(created).toMatchObject({ created: true, account: { name: 'Password Weirdo', securedAt: 25_000 }, session: { label: 'Laptop' } });
    expect(created.account.passwordHash).toMatch(/^scrypt\$16384\$8\$1\$/); expect(created.account.passwordHash).not.toContain('correct horse');
    const signedIn = await service.startWithPassword('4'.repeat(64), 'password weirdo', 'correct horse', 'Tablet', 25_100);
    expect(signedIn).toMatchObject({ created: false, account: { id: created.account.id }, session: { label: 'Tablet' } });
    await expect(service.startWithPassword('5'.repeat(64), 'Password Weirdo', 'wrong password', 'Impostor', 25_200)).rejects.toThrow('incorrect');
  });

  it('lets the matching recovery credential add the first password to a beta account', async () => {
    const repository = new MemoryAccountRepository(); const service = new AccountService(repository);
    const beta = await service.migrateLegacy(credential, 'Beta Bodhi', 'Old browser', 26_000);
    const upgraded = await service.startWithPassword(credential, 'Beta Bodhi', 'new password', 'Old browser', 26_100);
    expect(upgraded.account).toMatchObject({ id: beta.account.id, securedAt: 26_100 }); expect(upgraded.account.passwordHash).toBeTruthy();
    await expect(service.startWithPassword('6'.repeat(64), 'Beta Bodhi', 'new password', 'Tablet', 26_200)).resolves.toMatchObject({ account: { id: beta.account.id } });
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
