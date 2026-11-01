import { describe, expect, it } from 'vitest';
import { allows, displayPrefix, newPersonalToken, normaliseScopes, parseBearer, TOKEN_PREFIX } from './token-format';

describe('personal access tokens', () => {
  it('generates prefixed, unguessable tokens', () => {
    const a = newPersonalToken();
    const b = newPersonalToken();
    expect(a.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(a.length).toBeGreaterThan(TOKEN_PREFIX.length + 40);
    expect(a).not.toBe(b);
    expect(displayPrefix(a)).toHaveLength(TOKEN_PREFIX.length + 4);
  });

  it('reads only well-formed bearer headers', () => {
    expect(parseBearer('Bearer fluid_pat_abc')).toBe('fluid_pat_abc');
    expect(parseBearer('bearer   fluid_pat_abc  ')).toBe('fluid_pat_abc');
    expect(parseBearer('Bearer someoneelses_token')).toBeNull();
    expect(parseBearer('Basic fluid_pat_abc')).toBeNull();
    expect(parseBearer('Bearer fluid_pat_a b')).toBeNull();
    expect(parseBearer(null)).toBeNull();
    expect(parseBearer(`Bearer ${TOKEN_PREFIX}${'x'.repeat(300)}`)).toBeNull();
  });

  it('lets write imply read, never the reverse', () => {
    expect(allows(['read'], 'read')).toBe(true);
    expect(allows(['read'], 'write')).toBe(false);
    expect(allows(['read', 'write'], 'write')).toBe(true);
    expect(allows(['write'], 'read')).toBe(true);
    expect(allows([], 'read')).toBe(false);
  });

  it('stores read with every token', () => {
    expect(normaliseScopes(['write'])).toEqual(['read', 'write']);
    expect(normaliseScopes([])).toEqual(['read']);
    expect(normaliseScopes(['read', 'admin'])).toEqual(['read']);
  });
});
