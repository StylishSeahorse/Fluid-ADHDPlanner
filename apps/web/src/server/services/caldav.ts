/**
 * Connecting a CalDAV server.
 *
 * Only the part of CalDAV that differs from every other provider lives here:
 * a user types a server address and an app password. Pulling, pushing and the
 * rules that keep them safe are shared by all providers, in calendar-sync.ts.
 */
import 'server-only';
import { features } from '@fluid/env';
import { sealSecret } from '@fluid/crypto';
import { prisma } from '@fluid/db';
import { CalendarError, type ConnectionRef } from '@fluid/calendar';
import { CalDavAdapter } from '@fluid/calendar/adapters/caldav';
import { CALDAV_CREDENTIAL_PURPOSE, storeRemoteCalendars } from './calendar-sync';

export interface CalDavCredentials {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * Link a CalDAV server.
 *
 * The credentials are proved before anything is stored: a connection row that
 * has never successfully talked to its server is just a future support
 * question. Discovery runs first, and only a working sign-in gets saved.
 */
export async function connectCalDav(
  userId: string,
  input: CalDavCredentials,
): Promise<{ connectionId: string; calendars: number }> {
  const adapter = new CalDavAdapter({ allowLocalhost: features.caldavLocalhost });
  const probe: ConnectionRef = { id: 'probe', userId, provider: 'CALDAV', credentials: input };

  // Throws on a bad address or bad credentials, before anything is persisted.
  const remoteCalendars = await adapter.listCalendars(probe);

  if (remoteCalendars.length === 0) {
    throw new CalendarError(
      'Signed in, but that account has no calendars we can use. ' +
        'Check the address points at your calendar home.',
      false,
    );
  }

  const encryptedCredentials = sealSecret(JSON.stringify(input), { userId, purpose: CALDAV_CREDENTIAL_PURPOSE });
  const accountIdentifier = `${input.username} @ ${new URL(input.serverUrl).host}`;

  const connection = await prisma.calendarConnection.upsert({
    where: { userId_provider_accountIdentifier: { userId, provider: 'CALDAV', accountIdentifier } },
    create: { userId, provider: 'CALDAV', accountIdentifier, encryptedCredentials, status: 'ACTIVE' },
    // Reconnecting with a new password must clear the previous failure, or the
    // connection stays paused for a problem that has just been fixed.
    update: { encryptedCredentials, status: 'ACTIVE', statusDetail: null, lastSyncError: null },
  });

  await storeRemoteCalendars(userId, connection.id, remoteCalendars);
  return { connectionId: connection.id, calendars: remoteCalendars.length };
}
