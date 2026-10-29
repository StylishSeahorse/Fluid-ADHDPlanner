/**
 * Which notifications are due right now.
 *
 * Pure, like the scheduler: no database, no clock, no push service. The caller
 * passes `now` and everything else; this decides what — if anything — is worth
 * buzzing someone's phone for. Keeping the decision here is what lets "never
 * during quiet hours" and "never twice" be unit tests rather than hopes.
 *
 * Three kinds, each tied to a moment the day actually turns on:
 *
 *   BLOCK_START  a few minutes before a scheduled session — the transition is
 *                where time blindness bites, so the nudge lands just before it
 *   PLAN_DAY     at the start of the working day, if it has not been planned
 *   SHUTDOWN     at the end of the working day, if it has not been closed
 *
 * Each carries a `refKey` that the caller claims in a unique ledger before
 * sending. The key is built so that a meaningful change earns a fresh
 * notification (a session moved to 14:00 includes "14:00"), and nothing else
 * does.
 */
import type { WorkingHoursRule } from '../scheduler/types';
import { localDayOfWeek, localTimeOnDay, parseTimeOfDay, toLocal } from '../time/zoned';

export type NotificationKind = 'BLOCK_START' | 'PLAN_DAY' | 'SHUTDOWN';

export interface NotificationPrefs {
  /** Master switch. Off means nothing is sent, whatever else is set. */
  enabled: boolean;
  blockReminders: boolean;
  dayPrompts: boolean;
  /** Minutes before a session starts that its reminder arrives. */
  leadMinutes: number;
  /** "22:00" local. Both ends null means no quiet hours. */
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
}

export interface ReminderBlock {
  id: string;
  taskTitle: string;
  startsAt: Date;
  endsAt: Date;
  projectName?: string | null;
  /** A timer is already running on this task — they have started; say nothing. */
  timerRunning?: boolean;
}

export interface DueInput {
  now: Date;
  timeZone: string;
  prefs: NotificationPrefs;
  workingHours: WorkingHoursRule[];
  /** Accepted, unfinished sessions near `now`. Wider is fine; this filters. */
  blocks: ReminderBlock[];
  /** Today's ritual state. */
  day: { plannedAt?: Date | null; shutdownAt?: Date | null };
  /** Anything scheduled or committed today — no work, no wrap-up prompt. */
  hasWorkToday: boolean;
}

export interface DueNotification {
  kind: NotificationKind;
  refKey: string;
  title: string;
  body: string;
  /** Where a tap lands, relative to the app origin. */
  url: string;
  /** Replaces an earlier notification with the same tag instead of stacking. */
  tag: string;
  actions?: Array<{ action: string; title: string; url: string }>;
}

/**
 * A reminder that arrives after the session has started is still useful for a
 * minute or two — a missed tick should not swallow it — but "starting now" a
 * quarter of an hour late is noise, so the window closes quickly.
 */
export const BLOCK_GRACE_MINUTES = 2;
/** How long after the working day starts the planning prompt may still go out. */
export const PLAN_DAY_WINDOW_MINUTES = 60;
/** How long after the working day ends the wrap-up prompt may still go out. */
export const SHUTDOWN_WINDOW_MINUTES = 60;

const MINUTE = 60_000;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function clock(instant: Date, timeZone: string): string {
  const local = toLocal(instant, timeZone);
  return `${pad(local.hour)}:${pad(local.minute)}`;
}

function localDate(instant: Date, timeZone: string): string {
  const local = toLocal(instant, timeZone);
  return `${local.year}-${pad(local.month)}-${pad(local.day)}`;
}

/** Is this local time inside quiet hours? Handles windows that wrap midnight. */
export function isQuietTime(
  now: Date,
  timeZone: string,
  start?: string | null,
  end?: string | null,
): boolean {
  if (!start || !end) return false;

  const local = toLocal(now, timeZone);
  const minutes = local.hour * 60 + local.minute;
  const from = parseTimeOfDay(start);
  const to = parseTimeOfDay(end);

  if (from === to) return false;
  return from < to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
}

/** The earliest start and latest end of today's working hours, if it is a working day. */
function workingDayBounds(
  now: Date,
  timeZone: string,
  rules: WorkingHoursRule[],
): { start: Date; end: Date } | null {
  const weekday = localDayOfWeek(now, timeZone);
  const today = rules.filter((rule) => rule.dayOfWeek === weekday);
  if (today.length === 0) return null;

  const startMinutes = Math.min(...today.map((rule) => parseTimeOfDay(rule.startTime)));
  const endMinutes = Math.max(...today.map((rule) => parseTimeOfDay(rule.endTime)));

  return {
    start: localTimeOnDay(now, startMinutes, timeZone),
    end: localTimeOnDay(now, endMinutes, timeZone),
  };
}

function within(now: Date, from: Date, minutes: number): boolean {
  return now >= from && now.getTime() < from.getTime() + minutes * MINUTE;
}

export function dueNotifications(input: DueInput): DueNotification[] {
  const { now, timeZone, prefs } = input;

  if (!prefs.enabled) return [];
  if (isQuietTime(now, timeZone, prefs.quietHoursStart, prefs.quietHoursEnd)) return [];

  const due: DueNotification[] = [];
  const lead = Math.max(0, Math.min(60, Math.round(prefs.leadMinutes)));

  if (prefs.blockReminders) {
    for (const block of input.blocks) {
      if (block.timerRunning) continue;

      const opensAt = block.startsAt.getTime() - lead * MINUTE;
      const closesAt = block.startsAt.getTime() + BLOCK_GRACE_MINUTES * MINUTE;
      if (now.getTime() < opensAt || now.getTime() >= closesAt) continue;

      const minutesAway = Math.ceil((block.startsAt.getTime() - now.getTime()) / MINUTE);
      const when =
        `${clock(block.startsAt, timeZone)}–${clock(block.endsAt, timeZone)}` +
        (block.projectName ? ` · ${block.projectName}` : '');

      due.push({
        kind: 'BLOCK_START',
        refKey: `${block.id}@${block.startsAt.toISOString()}`,
        title: minutesAway > 0 ? `In ${minutesAway} min: ${block.taskTitle}` : `Time for ${block.taskTitle}`,
        body: when,
        url: '/today',
        tag: `block-${block.id}`,
        actions: [{ action: 'focus', title: 'Start focus', url: '/focus' }],
      });
    }
  }

  if (prefs.dayPrompts) {
    const bounds = workingDayBounds(now, timeZone, input.workingHours);
    const dayKey = localDate(now, timeZone);

    if (
      bounds &&
      !input.day.plannedAt &&
      !input.day.shutdownAt &&
      within(now, bounds.start, PLAN_DAY_WINDOW_MINUTES)
    ) {
      due.push({
        kind: 'PLAN_DAY',
        refKey: dayKey,
        title: 'Plan your day',
        body: 'Five minutes to choose what today is for — and check it fits.',
        url: '/plan-day',
        tag: 'plan-day',
      });
    }

    if (
      bounds &&
      !input.day.shutdownAt &&
      (input.hasWorkToday || input.day.plannedAt) &&
      within(now, bounds.end, SHUTDOWN_WINDOW_MINUTES)
    ) {
      due.push({
        kind: 'SHUTDOWN',
        refKey: dayKey,
        title: 'Time to wrap up',
        body: 'See what today added up to, and decide where the rest goes.',
        url: '/today#shutdown',
        tag: 'shutdown',
      });
    }
  }

  return due;
}
