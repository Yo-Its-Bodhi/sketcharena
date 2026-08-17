import type { AuthenticationResponseJSON, AuthenticatorTransportFuture, RegistrationResponseJSON } from '@simplewebauthn/server';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import type { AccountRepository, PlayerAccount, PlayerDeviceSession, PlayerPasskey } from './AccountRepository.js';
import { AccountService, createSecret, hashSecret } from './AccountRepository.js';

export interface PasskeyConfiguration { rpName: string; rpID: string; origin: string; }

export class PasskeyService {
  constructor(private readonly repository: AccountRepository, private readonly accounts: AccountService, private readonly config: PasskeyConfiguration, private readonly sessionTtlMs = 30 * 24 * 60 * 60 * 1000) {}

  async registrationOptions(account: PlayerAccount, now = Date.now()) {
    const existing = await this.repository.listPasskeys(account.id);
    const options = await generateRegistrationOptions({
      rpName: this.config.rpName, rpID: this.config.rpID, userName: account.name, userDisplayName: account.name,
      userID: uuidBytes(account.id), attestationType: 'none',
      excludeCredentials: existing.map((item) => ({ id: item.id, transports: item.transports as AuthenticatorTransportFuture[] | undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    });
    const challenge = await this.accounts.createChallenge('registration', options.challenge, account.id, now);
    return { challengeId: challenge.id, options };
  }

  async verifyRegistration(account: PlayerAccount, challengeId: string, response: RegistrationResponseJSON, label: string, now = Date.now()): Promise<PlayerPasskey> {
    const challenge = await this.accounts.consumeChallenge(challengeId, 'registration', now);
    if (!challenge || challenge.accountId !== account.id) throw new Error('Passkey setup expired—please try again');
    const verification = await verifyRegistrationResponse({ response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpID, requireUserVerification: true });
    if (!verification.verified || !verification.registrationInfo) throw new Error('Passkey could not be verified');
    const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
    const passkey: PlayerPasskey = {
      id: credential.id, accountId: account.id, webauthnUserId: Buffer.from(uuidBytes(account.id)).toString('base64url'), publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter, deviceType: credentialDeviceType, backedUp: credentialBackedUp, transports: credential.transports as PlayerPasskey['transports'], label: label.trim().slice(0, 80) || 'Passkey', createdAt: now,
    };
    await this.repository.savePasskey(passkey); await this.repository.saveAccount({ ...account, securedAt: account.securedAt ?? now, updatedAt: now }); return passkey;
  }

  async authenticationOptions(now = Date.now()) {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpID, userVerification: 'required' });
    const challenge = await this.accounts.createChallenge('authentication', options.challenge, undefined, now); return { challengeId: challenge.id, options };
  }

  async verifyAuthentication(challengeId: string, response: AuthenticationResponseJSON, label: string, now = Date.now()): Promise<{ account: PlayerAccount; token: string; session: PlayerDeviceSession }> {
    const challenge = await this.accounts.consumeChallenge(challengeId, 'authentication', now); if (!challenge) throw new Error('Sign-in expired—please try again');
    const found = await this.repository.findByPasskeyId(response.id); if (!found) throw new Error('This passkey is not registered here');
    const verification = await verifyAuthenticationResponse({
      response, expectedChallenge: challenge.challenge, expectedOrigin: this.config.origin, expectedRPID: this.config.rpID, requireUserVerification: true,
      credential: { id: found.passkey.id, publicKey: new Uint8Array(Buffer.from(found.passkey.publicKey, 'base64url')), counter: found.passkey.counter, transports: found.passkey.transports as AuthenticatorTransportFuture[] | undefined },
    });
    if (!verification.verified) throw new Error('Passkey sign-in could not be verified');
    await this.repository.updatePasskeyCounter(found.passkey.id, verification.authenticationInfo.newCounter, now);
    const token = createSecret(); const session: PlayerDeviceSession = { id: crypto.randomUUID(), accountId: found.account.id, tokenHash: hashSecret(token), label: label.trim().slice(0, 80) || 'Passkey device', createdAt: now, lastSeenAt: now, expiresAt: now + this.sessionTtlMs };
    await this.repository.saveSession(session); return { account: found.account, token, session };
  }
}

function uuidBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new Error('Invalid account ID');
  const hex = value.replaceAll('-', ''); const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}

export function loadPasskeyConfiguration(): PasskeyConfiguration {
  const origin = (process.env.PASSKEY_ORIGIN ?? process.env.PUBLIC_APP_ORIGIN ?? 'http://localhost:5173').replace(/\/$/, '');
  const url = new URL(origin); const rpID = process.env.PASSKEY_RP_ID?.trim() || url.hostname;
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') throw new Error('Passkeys require HTTPS outside localhost');
  if (url.hostname !== rpID && !url.hostname.endsWith(`.${rpID}`)) throw new Error('PASSKEY_RP_ID must be the origin host or a parent domain');
  return { rpName: process.env.PASSKEY_RP_NAME?.trim() || 'Sketch Arena', rpID, origin };
}
