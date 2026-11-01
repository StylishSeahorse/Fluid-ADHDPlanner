/**
 * Personal access tokens: their shape and what each scope allows.
 *
 * Pure, so it can be tested without a database. The token is `fluid_pat_`
 * followed by 256 random bits; the prefix makes a leaked token recognisable
 * to secret scanners and to a person reading a log.
 */
// node:crypto directly rather than @fluid/crypto, whose index loads the
// environment — this module stays importable by plain unit tests.
import { randomBytes } from 'node:crypto';

export const TOKEN_PREFIX = 'fluid_pat_';
export const SCOPES = ['read', 'write'] as const;
export type Scope = (typeof SCOPES)[number];

export function newPersonalToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
}

/** Enough of the token to tell two apart in a list, never enough to use. */
export function displayPrefix(token: string): string {
  return token.slice(0, TOKEN_PREFIX.length + 4);
}

/** The token from an `Authorization: Bearer …` header, or null if there is none of our shape. */
export function parseBearer(header: string | null): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? '');
  const token = match?.[1];
  if (!token || !token.startsWith(TOKEN_PREFIX) || token.length > 200) return null;
  return token;
}

/** `write` includes `read`: a token that may change cards may also look at them. */
export function allows(granted: readonly string[], needed: Scope): boolean {
  return granted.includes(needed) || (needed === 'read' && granted.includes('write'));
}

/** Scopes as stored: always includes read, so a write-only token never exists. */
export function normaliseScopes(requested: readonly string[]): Scope[] {
  return requested.includes('write') ? ['read', 'write'] : ['read'];
}
