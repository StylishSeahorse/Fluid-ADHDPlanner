/**
 * External calendar events, as the time they actually occupy.
 *
 * The one place the app reads meetings for planning or display. Recurring
 * series are stored as they came from the provider — one row with its rule —
 * and expanded here into the occurrences inside the window asked for. Before
 * this existed, every reader queried rows directly, so a weekly standup only
 * blocked the week it started, and planning (which reads from "now") saw none
 * of a series that began last month.
 */
import 'server-only';
import { prisma, type Db, type Event } from '@fluid/db';
import { occurrencesInWindow, type Occurrence, type Window } from '@fluid/core';

/** How far to look for modified occurrences whose original slot is near the window. */
const OVERRIDE_SLACK_MS = 7 * 24 * 60 * 60_000;

export type ExternalOccurrence = Occurrence<Event>;

export async function externalEvents(
  userId: string,
  window: Window,
  options: { busyOnly?: boolean; db?: Db } = {},
): Promise<ExternalOccurrence[]> {
  const db = options.db ?? prisma;
  const busyOnly = options.busyOnly ?? true;

  const rows = await db.event.findMany({
    where: {
      calendar: { userId, isSelected: true },
      origin: 'EXTERNAL',
      deletedAt: null,
      OR: [
        // Single events overlapping the window.
        {
          rrule: null,
          recurringEventId: null,
          status: { not: 'CANCELLED' },
          startsAt: { lt: window.to },
          endsAt: { gt: window.from },
        },
        // Every series that has started by the end of the window — expansion
        // decides which of its occurrences fall inside.
        { rrule: { not: null }, recurringEventId: null, status: { not: 'CANCELLED' }, startsAt: { lt: window.to } },
        // Modified occurrences, whatever their status or busy flag: a cancelled
        // or "free" one still has to remove the occurrence it replaces.
        {
          recurringEventId: { not: null },
          OR: [
            { startsAt: { lt: window.to }, endsAt: { gt: window.from } },
            {
              originalStartsAt: {
                gte: new Date(window.from.getTime() - OVERRIDE_SLACK_MS),
                lt: new Date(window.to.getTime() + OVERRIDE_SLACK_MS),
              },
            },
          ],
        },
      ],
    },
  });

  const occurrences = occurrencesInWindow(rows, window);
  return busyOnly ? occurrences.filter((event) => event.transparency === 'BUSY') : occurrences;
}
