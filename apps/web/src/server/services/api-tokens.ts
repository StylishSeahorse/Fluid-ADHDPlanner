/**
 * Personal access tokens for the REST API.
 *
 * Like sessions, only a digest of each token is stored; the token itself is
 * shown once, when it is made. A token acts as the person who made it, within
 * its scopes, and can be revoked at any time from Settings.
 */
import 'server-only';
import { prisma, type User } from '@fluid/db';
import { hashToken } from '@fluid/crypto';
import { displayPrefix, newPersonalToken, normaliseScopes } from '../api/token-format';

const MAX_TOKENS = 20;
/** `lastUsedAt` is for "is this still in use?", not an audit log — once a minute is plenty. */
const LAST_USED_GRANULARITY_MS = 60_000;

export async function createApiToken(
  userId: string,
  input: { name: string; scopes: string[]; expiresInDays: number | null },
): Promise<{ id: string; token: string }> {
  const active = await prisma.apiToken.count({ where: { userId, revokedAt: null } });
  if (active >= MAX_TOKENS) throw new Error(`You have ${MAX_TOKENS} tokens already. Revoke one you no longer use first.`);

  const token = newPersonalToken();
  const row = await prisma.apiToken.create({
    data: {
      userId,
      name: input.name,
      tokenDigest: hashToken(token),
      prefix: displayPrefix(token),
      scopes: normaliseScopes(input.scopes),
      expiresAt: input.expiresInDays ? new Date(Date.now() + input.expiresInDays * 86_400_000) : null,
    },
  });
  return { id: row.id, token };
}

export async function listApiTokens(userId: string) {
  return prisma.apiToken.findMany({
    where: { userId, revokedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { id: true, name: true, prefix: true, scopes: true, createdAt: true, lastUsedAt: true, expiresAt: true },
  });
}

export async function revokeApiToken(userId: string, id: string): Promise<void> {
  await prisma.apiToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
}

/** The token's owner and scopes, or null if it is unknown, revoked or expired. */
export async function authenticateApiToken(token: string): Promise<{ user: User; scopes: string[]; tokenId: string } | null> {
  const row = await prisma.apiToken.findUnique({ where: { tokenDigest: hashToken(token) }, include: { user: true } });
  const now = new Date();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
  if (!row.lastUsedAt || now.getTime() - row.lastUsedAt.getTime() > LAST_USED_GRANULARITY_MS) {
    await prisma.apiToken.update({ where: { id: row.id }, data: { lastUsedAt: now } }).catch(() => {});
  }
  return { user: row.user, scopes: row.scopes, tokenId: row.id };
}
