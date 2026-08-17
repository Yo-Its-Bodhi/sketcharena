import { describe, expect, it } from 'vitest';
import { AccountService, MemoryAccountRepository } from './AccountRepository.js';
import { PasskeyService } from './PasskeyService.js';

describe('PasskeyService', () => {
  it('issues account-bound, user-verifying registration options and one-time challenges', async () => {
    const repository = new MemoryAccountRepository(); const accounts = new AccountService(repository);
    const migrated = await accounts.migrateLegacy('cd'.repeat(32), 'Panic Person', 'Browser', 1_000);
    const passkeys = new PasskeyService(repository, accounts, { rpName: 'Sketch Arena', rpID: 'localhost', origin: 'http://localhost:5173' });
    const result = await passkeys.registrationOptions(migrated.account, 2_000);
    expect(result.options.rp.id).toBe('localhost');
    expect(result.options.authenticatorSelection?.residentKey).toBe('required');
    expect(result.options.authenticatorSelection?.userVerification).toBe('required');
    expect(await accounts.consumeChallenge(result.challengeId, 'registration', 2_001)).toMatchObject({ accountId: migrated.account.id, challenge: result.options.challenge });
    expect(await accounts.consumeChallenge(result.challengeId, 'registration', 2_002)).toBeNull();
  });

  it('issues discoverable passkey authentication options', async () => {
    const repository = new MemoryAccountRepository(); const accounts = new AccountService(repository); const passkeys = new PasskeyService(repository, accounts, { rpName: 'Sketch Arena', rpID: 'sketch.bodhix.io', origin: 'https://sketch.bodhix.io' });
    const result = await passkeys.authenticationOptions(3_000);
    expect(result.options.rpId).toBe('sketch.bodhix.io');
    expect(result.options.userVerification).toBe('required');
    expect(result.options.allowCredentials).toBeUndefined();
  });
});
