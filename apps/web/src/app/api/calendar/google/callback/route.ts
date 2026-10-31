/**
 * Step two: Google sends the browser back with a code. Check it belongs to the
 * sign-in this browser started, exchange it, and go back to Settings with a
 * plain-language result either way.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { env } from '@fluid/env';
import { CalendarError } from '@fluid/calendar';
import { checkGoogleState, GOOGLE_OAUTH_COOKIE } from '@/server/services/google';
import { connectGoogle } from '@/server/services/google-connect';
import { getCurrentUser } from '@/server/auth/session';

function back(message: string): NextResponse {
  const response = NextResponse.redirect(
    new URL(`/settings?calendar=${encodeURIComponent(message)}#calendars`, env.APP_URL),
  );
  response.cookies.delete({ name: GOOGLE_OAUTH_COOKIE, path: '/api/calendar/google/callback' });
  return response;
}

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return NextResponse.redirect(new URL('/login', env.APP_URL));

  const params = request.nextUrl.searchParams;
  if (params.get('error')) {
    return back(params.get('error') === 'access_denied' ? 'Google Calendar was not connected — access was declined.' : 'Google sign-in did not complete.');
  }

  try {
    const verifier = checkGoogleState(user.id, request.cookies.get(GOOGLE_OAUTH_COOKIE)?.value, params.get('state'));
    const code = params.get('code');
    if (!code) throw new CalendarError('Google did not send a sign-in code. Try again.', false);

    const result = await connectGoogle(user.id, code, verifier);
    return back(`Connected ${result.email} — ${result.calendars} calendar${result.calendars === 1 ? '' : 's'}. Your first sync is running.`);
  } catch (error) {
    return back(error instanceof CalendarError ? error.message : 'Could not connect Google Calendar. Try again.');
  }
}
