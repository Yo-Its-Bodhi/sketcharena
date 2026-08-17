import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAccountRepository } from './PostgresAccountRepository.js';

const connectionString = process.env.TEST_DATABASE_URL;
const suite = connectionString ? describe : describe.skip;

suite('PostgresAccountRepository integration', () => {
  let repository: PostgresAccountRepository;
  const accountId = randomUUID();
  const tokenHash = createHash('sha256').update(randomUUID()).digest('hex');
  const legacyHash = createHash('sha256').update(randomUUID()).digest('hex');
  const now = Date.now();

  beforeAll(async () => { repository = await PostgresAccountRepository.connect(connectionString!); });
  afterAll(async () => { await repository.close(); });

  it('persists an account, revocable session, passkey counter and one-time challenge', async () => {
    await repository.saveAccount({ id: accountId, name: 'Database Weirdo', legacyCredentialHash: legacyHash, createdAt: now, updatedAt: now });
    expect((await repository.findByLegacyCredentialHash(legacyHash))?.id).toBe(accountId);

    const sessionId = randomUUID();
    await repository.saveSession({ id: sessionId, accountId, tokenHash, label: 'CI device', createdAt: now, lastSeenAt: now, expiresAt: now + 60_000 });
    expect((await repository.findSessionByTokenHash(tokenHash, now + 1))?.account.id).toBe(accountId);
    expect(await repository.revokeSession(sessionId, accountId, now + 2)).toBe(true);
    expect(await repository.findSessionByTokenHash(tokenHash, now + 3)).toBeNull();

    const passkeyId = `ci-${randomUUID()}`;
    await repository.savePasskey({ id: passkeyId, accountId, webauthnUserId: randomUUID(), publicKey: 'AQID', counter: 0, deviceType: 'multiDevice', backedUp: true, transports: ['internal'], label: 'CI passkey', createdAt: now });
    await repository.updatePasskeyCounter(passkeyId, 4, now + 4);
    expect((await repository.findByPasskeyId(passkeyId))?.passkey.counter).toBe(4);

    const challengeId = randomUUID();
    await repository.saveChallenge({ id: challengeId, kind: 'authentication', challenge: 'ci-one-time-challenge', accountId, createdAt: now, expiresAt: now + 60_000 });
    expect((await repository.consumeChallenge(challengeId, 'authentication', now + 5))?.id).toBe(challengeId);
    expect(await repository.consumeChallenge(challengeId, 'authentication', now + 6)).toBeNull();
  });
});
