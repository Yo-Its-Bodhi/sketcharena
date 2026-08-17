import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export type BackstageRole = 'viewer' | 'operator' | 'admin';
export interface BackstagePrincipal { name: string; role: BackstageRole; tokenHash: string; }

const credentialSchema = z.array(z.object({
  name: z.string().trim().min(2).max(40), role: z.enum(['viewer', 'operator', 'admin']), tokenHash: z.string().regex(/^[0-9a-f]{64}$/i),
})).max(50);

export function hashBackstageToken(token: string): string { return createHash('sha256').update(token).digest('hex'); }
export function roleRank(role: BackstageRole): number { return role === 'admin' ? 2 : role === 'operator' ? 1 : 0; }

export class BackstageAuth {
  readonly principals: BackstagePrincipal[];
  readonly configurationErrors: string[];
  readonly requiresNamedCredentials: boolean;
  constructor(environment: NodeJS.ProcessEnv = process.env) {
    const principals: BackstagePrincipal[] = [];
    const errors: string[] = [];
    const production = environment.NODE_ENV === 'production';
    this.requiresNamedCredentials = environment.REQUIRE_BACKSTAGE_CREDENTIALS === 'true';
    try {
      const valid = credentialSchema.safeParse(JSON.parse(environment.BACKSTAGE_CREDENTIALS ?? '[]') as unknown);
      if (!valid.success) errors.push('BACKSTAGE_CREDENTIALS has an invalid structure');
      else {
        const normalized = valid.data.map((principal) => ({ ...principal, tokenHash: principal.tokenHash.toLowerCase() }));
        const names = new Set<string>(); const hashes = new Set<string>();
        for (const principal of normalized) {
          const name = principal.name.toLowerCase();
          if (names.has(name)) errors.push(`BACKSTAGE_CREDENTIALS repeats staff name ${principal.name}`);
          if (hashes.has(principal.tokenHash)) errors.push('BACKSTAGE_CREDENTIALS reuses one token across staff accounts');
          names.add(name); hashes.add(principal.tokenHash);
        }
        principals.push(...normalized);
      }
    } catch { errors.push('BACKSTAGE_CREDENTIALS is not valid JSON'); }
    const legacy = environment.ADMIN_API_TOKEN;
    const legacyAllowed = !production || environment.ALLOW_LEGACY_ADMIN_TOKEN === 'true';
    if (legacy && legacy.length >= 32 && legacyAllowed) principals.push({ name: 'primary-admin', role: 'admin', tokenHash: hashBackstageToken(legacy) });
    else if (legacy && !legacyAllowed) errors.push('ADMIN_API_TOKEN is disabled in production; use named BACKSTAGE_CREDENTIALS');
    if (this.requiresNamedCredentials && !principals.some((principal) => principal.name !== 'primary-admin')) errors.push('Named BACKSTAGE_CREDENTIALS are required');
    this.principals = principals;
    this.configurationErrors = [...new Set(errors)];
  }
  get valid(): boolean { return this.configurationErrors.length === 0; }
  get configured(): boolean { return this.valid && this.principals.length > 0; }
  authorize(authorization: string | undefined, required: BackstageRole): BackstagePrincipal | null {
    const supplied = authorization?.startsWith('Bearer ') ? authorization.slice(7) : ''; if (supplied.length < 32) return null;
    const suppliedHash = Buffer.from(hashBackstageToken(supplied), 'hex');
    const principal = this.principals.find((candidate) => timingSafeEqual(suppliedHash, Buffer.from(candidate.tokenHash, 'hex')));
    return principal && roleRank(principal.role) >= roleRank(required) ? principal : null;
  }
  error(required?: BackstageRole): string { return this.configured ? required ? `${required} Backstage permission required` : 'Backstage authentication required' : this.valid ? 'Backstage is not configured on this server' : 'Backstage configuration is invalid'; }
}
