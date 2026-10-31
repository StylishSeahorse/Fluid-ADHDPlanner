/**
 * Finishing a Google sign-in: store the grant, record the calendars, start
 * syncing. Separate from google.ts so token handling and the sync engine do
 * not import each other.
 */
import 'server-only';
import { prisma } from '@fluid/db';
import { requestSync } from '../jobs/calendar-jobs';
import { connectionRef, adapterFor, storeRemoteCalendars } from './calendar-sync';
import { renewWatches } from './calendar-watch';
import { exchangeGoogleCode, sealGoogleCredentials } from './google';

export async function connectGoogle(userId: string, code: string, verifier: string): Promise<{ email: string; calendars: number }> {
  const credentials = await exchangeGoogleCode(code, verifier);
  const encryptedCredentials = sealGoogleCredentials(userId, credentials);

  const connection = await prisma.calendarConnection.upsert({
    where: { userId_provider_accountIdentifier: { userId, provider: 'GOOGLE', accountIdentifier: credentials.email } },
    create: {
      userId,
      provider: 'GOOGLE',
      accountIdentifier: credentials.email,
      encryptedCredentials,
      accessTokenExpiresAt: new Date(credentials.expiresAt),
      status: 'ACTIVE',
    },
    // Reconnecting fixes whatever paused it; clear the old failure.
    update: {
      encryptedCredentials,
      accessTokenExpiresAt: new Date(credentials.expiresAt),
      status: 'ACTIVE',
      statusDetail: null,
      lastSyncError: null,
    },
  });

  const remoteCalendars = await adapterFor('GOOGLE').listCalendars(connectionRef(connection));
  await storeRemoteCalendars(userId, connection.id, remoteCalendars);

  await prisma.auditLog.create({
    data: { userId, action: 'calendar.connected', metadata: { provider: 'GOOGLE', calendars: remoteCalendars.length } },
  });

  // First sync and push channels in the background; the user is redirected now.
  await requestSync(connection.id, 'connected');
  void renewWatches().catch(() => {});

  return { email: credentials.email, calendars: remoteCalendars.length };
}
