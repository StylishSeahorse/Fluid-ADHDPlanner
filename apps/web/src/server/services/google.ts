/**
 * Google: signing in, and keeping an access token fresh.
 *
 * OAuth 2.0 authorization code flow with PKCE and offline access. The client
 * secret and refresh token never leave the server; the adapter only ever sees
 * a short-lived access token through `googleAccessToken`. Credentials are
 * envelope-encrypted and bound to the user (AAD), like every other secret.
 *
 * Scopes are the least that does the job: read the calendar list, and read and
 * write events. Not `calendar` (which could delete whole calendars), and
 * nothing outside Calendar except the email that labels the connection.
 */
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { env, features } from '@fluid/env';
import { openSecret, sealSecret } from '@fluid/crypto';
import { prisma } from '@fluid/db';
import { AuthenticationError, CalendarError, type ConnectionRef } from '@fluid/calendar';
import { GoogleCalendarAdapter } from '@fluid/calendar/adapters/google';

export const GOOGLE_CREDENTIAL_PURPOSE = 'google-credentials';
/** Holds the sealed state and PKCE verifier between the two halves of sign-in. */
export const GOOGLE_OAUTH_COOKIE = 'fluid_google_oauth';
const STATE_PURPOSE = 'google-oauth-state';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
];

/** Refresh this long before Google says the token expires. */
const EXPIRY_MARGIN_MS = 2 * 60_000;

export interface GoogleCredentials {
  accessToken: string;
  refreshToken: string;
  /** ISO timestamp. */
  expiresAt: string;
  email: string;
}

export function redirectUri(): string {
  return new URL('/api/calendar/google/callback', env.APP_URL).toString();
}

function base64url(buffer: Buffer): string {
  return buffer.toString('base64url');
}

// ---------------------------------------------------------------------------
// The authorization request
// ---------------------------------------------------------------------------

/**
 * Start a sign-in: the URL to send the browser to, and a sealed cookie value
 * holding the state and PKCE verifier. Sealing binds both to this user, so a
 * callback cannot be replayed into someone else's session.
 */
export function beginGoogleSignIn(userId: string): { url: string; cookie: string } {
  if (!features.googleCalendar) throw new CalendarError('Google Calendar is not configured on this server.', false);

  const state = base64url(randomBytes(24));
  const verifier = base64url(randomBytes(48));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const url = new URL(AUTH_ENDPOINT);
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID!);
  url.searchParams.set('redirect_uri', redirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_SCOPES.join(' '));
  // Offline + consent: the only way to be sure Google issues a refresh token.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');

  const cookie = sealSecret(JSON.stringify({ state, verifier, at: Date.now() }), { userId, purpose: STATE_PURPOSE });
  return { url: url.toString(), cookie };
}

/** Check the callback's state against the cookie; return the PKCE verifier. */
export function checkGoogleState(userId: string, cookie: string | undefined, state: string | null): string {
  if (!cookie || !state) throw new CalendarError('That sign-in link has expired. Try connecting again.', false);
  let parsed: { state: string; verifier: string; at: number };
  try {
    parsed = JSON.parse(openSecret(cookie, { userId, purpose: STATE_PURPOSE })) as typeof parsed;
  } catch {
    throw new CalendarError('That sign-in did not start here. Try connecting again.', false);
  }
  if (parsed.state !== state || Date.now() - parsed.at > 15 * 60_000) {
    throw new CalendarError('That sign-in link has expired. Try connecting again.', false);
  }
  return parsed.verifier;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
  });
  const body = (await response.json().catch(() => ({}))) as TokenResponse;

  if (!response.ok || body.error) {
    // invalid_grant: the refresh token was revoked, expired, or the password
    // changed. Nothing retries its way out of that — the user must reconnect.
    if (body.error === 'invalid_grant') {
      throw new AuthenticationError('Google access was revoked or has expired. Reconnect Google Calendar in Settings.');
    }
    throw new CalendarError(`Google sign-in failed: ${body.error_description ?? body.error ?? response.status}`, response.status >= 500);
  }
  return body;
}

/**
 * The email in the ID token, read without verifying its signature. That is
 * permitted here (OpenID Connect Core §3.1.3.7): it came straight from
 * Google's token endpoint over TLS, in response to our own request.
 */
export function emailFromIdToken(idToken: string | undefined): string | null {
  const payload = idToken?.split('.')[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { email?: string };
    return claims.email ?? null;
  } catch {
    return null;
  }
}

export async function exchangeGoogleCode(code: string, verifier: string): Promise<GoogleCredentials> {
  const tokens = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  });

  if (!tokens.refresh_token) {
    throw new CalendarError('Google did not grant offline access. Try connecting again and approve every permission.', false);
  }
  const granted = new Set((tokens.scope ?? '').split(' '));
  if (!granted.has('https://www.googleapis.com/auth/calendar.events')) {
    throw new CalendarError('Fluid needs permission to manage events. Connect again and keep that box ticked.', false);
  }

  return {
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    email: emailFromIdToken(tokens.id_token) ?? 'Google account',
  };
}

function sealCredentials(userId: string, credentials: GoogleCredentials): string {
  return sealSecret(JSON.stringify(credentials), { userId, purpose: GOOGLE_CREDENTIAL_PURPOSE });
}

export function openGoogleCredentials(connection: { userId: string; encryptedCredentials: string }): GoogleCredentials {
  return JSON.parse(
    openSecret(connection.encryptedCredentials, { userId: connection.userId, purpose: GOOGLE_CREDENTIAL_PURPOSE }),
  ) as GoogleCredentials;
}

/**
 * A current access token for a connection, refreshing it when it is close to
 * expiry or when Google has just rejected it. A refresh that Google refuses
 * outright marks the connection as needing attention, so the next sync does
 * not keep knocking on a door that will not open.
 */
export async function googleAccessToken(connectionId: string, options: { forceRefresh: boolean }): Promise<string> {
  const connection = await prisma.calendarConnection.findUniqueOrThrow({ where: { id: connectionId } });
  const credentials = openGoogleCredentials(connection);

  if (!options.forceRefresh && new Date(credentials.expiresAt).getTime() - EXPIRY_MARGIN_MS > Date.now()) {
    return credentials.accessToken;
  }

  try {
    const tokens = await tokenRequest({ grant_type: 'refresh_token', refresh_token: credentials.refreshToken });
    const fresh: GoogleCredentials = {
      ...credentials,
      accessToken: tokens.access_token,
      // Google rarely rotates refresh tokens, but keep a new one if it does.
      refreshToken: tokens.refresh_token ?? credentials.refreshToken,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
    };
    await prisma.calendarConnection.update({
      where: { id: connection.id },
      data: {
        encryptedCredentials: sealCredentials(connection.userId, fresh),
        accessTokenExpiresAt: new Date(fresh.expiresAt),
      },
    });
    return fresh.accessToken;
  } catch (error) {
    if (error instanceof AuthenticationError) {
      await prisma.calendarConnection.update({
        where: { id: connection.id },
        data: { status: 'NEEDS_ATTENTION', statusDetail: error.message },
      });
    }
    throw error;
  }
}

/** The adapter, wired to this server's token handling. */
export function googleAdapter(): GoogleCalendarAdapter {
  return new GoogleCalendarAdapter({
    accessToken: (connection: ConnectionRef, options) => googleAccessToken(connection.id, options),
  });
}

/** Best effort: tell Google to forget the grant when someone disconnects. */
export async function revokeGoogle(connection: { userId: string; encryptedCredentials: string }): Promise<void> {
  try {
    const { refreshToken } = openGoogleCredentials(connection);
    await fetch(`${REVOKE_ENDPOINT}?token=${encodeURIComponent(refreshToken)}`, { method: 'POST' });
  } catch {
    // Disconnecting must work even if Google is unreachable.
  }
}

export { sealCredentials as sealGoogleCredentials };
