import { createHash } from 'node:crypto';

const CREDENTIAL = /^[0-9a-f]{64}$/i;

export function sessionIdFromCredential(credential: string): string {
  if (!CREDENTIAL.test(credential)) throw new Error('Invalid session credential');
  const hex = createHash('sha256').update(credential).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = hex.join('');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function sessionFromAuthorization(authorization: string | undefined): string | null {
  const match = authorization?.match(/^Bearer ([0-9a-f]{64})$/i);
  return match ? sessionIdFromCredential(match[1]!) : null;
}
