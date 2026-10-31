/**
 * Step one of connecting Google Calendar: send the browser to Google.
 *
 * The state and PKCE verifier travel in a short-lived, sealed, HttpOnly cookie
 * scoped to the callback path — never in the URL, never readable by scripts.
 */
import { NextResponse } from 'next/server';
import { env } from '@fluid/env';
import { CalendarError } from '@fluid/calendar';
import { beginGoogleSignIn, GOOGLE_OAUTH_COOKIE } from '@/server/services/google';
import { getCurrentUser } from '@/server/auth/session';

export async function GET(): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL('/login', env.APP_URL));

  try {
    const { url, cookie } = beginGoogleSignIn(user.id);
    const response = NextResponse.redirect(url);
    response.cookies.set(GOOGLE_OAUTH_COOKIE, cookie, {
      httpOnly: true,
      secure: env.APP_URL.startsWith('https://'),
      sameSite: 'lax',
      path: '/api/calendar/google/callback',
      maxAge: 15 * 60,
    });
    return response;
  } catch (error) {
    const message = error instanceof CalendarError ? error.message : 'Could not start Google sign-in.';
    return NextResponse.redirect(new URL(`/settings?calendar=${encodeURIComponent(message)}#calendars`, env.APP_URL));
  }
}
