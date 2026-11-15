import { fromBase64Url } from './ids.js';

/** A JWT's claims, unverified: the SDK reads its own tokens, it does not judge them (the servers do). */
export function jwtClaims(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return JSON.parse(new TextDecoder().decode(fromBase64Url(parts[1]!))) as Record<string, unknown>;
}
