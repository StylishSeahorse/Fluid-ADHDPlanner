/**
 * Recurring events, expanded into the occurrences that actually take time.
 *
 * The rule is stored exactly as the provider sent it (see the calendar
 * package): raw RFC 5545 lines — `RRULE`, `RDATE`, `EXDATE`. Nothing here ever
 * writes a rule back. This module only answers "when does this series happen
 * between these two instants?", so a weekly standup blocks every Monday
 * instead of only the first one.
 *
 * Expansion runs in the event's own wall-clock time and converts each
 * occurrence back to an instant, so a 09:00 London meeting stays at 09:00
 * across a clock change rather than drifting to 08:00 or 10:00.
 *
 * Supported: FREQ DAILY / WEEKLY / MONTHLY / YEARLY with INTERVAL, COUNT,
 * UNTIL, BYDAY (with ordinals for monthly and yearly), BYMONTHDAY, BYMONTH,
 * WKST, plus RDATE and EXDATE. That covers the rules calendar apps actually
 * write. Parts outside it (BYSETPOS, BYWEEKNO, BYYEARDAY, BYHOUR…) are
 * ignored rather than refused, and `unsupported` says so — the series still
 * blocks time on its base pattern rather than vanishing from the plan.
 */
import { fromLocal, toLocal } from '../time/zoned';

export interface Window {
  from: Date;
  to: Date;
}

export interface RecurringSeries {
  /** First occurrence, as stored on the master event. */
  startsAt: Date;
  endsAt: Date;
  timeZone: string;
  isAllDay: boolean;
  /** Raw recurrence lines, joined by CRLF or LF. */
  recurrence: string;
}

export interface Expansion {
  occurrences: Array<{ startsAt: Date; endsAt: Date }>;
  /** Rule parts that were present but not understood. Empty when fully honoured. */
  unsupported: string[];
}

const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
const SUPPORTED_PARTS = new Set(['FREQ', 'INTERVAL', 'COUNT', 'UNTIL', 'BYDAY', 'BYMONTHDAY', 'BYMONTH', 'WKST']);
/** A runaway rule must not stall a page load. */
const MAX_ITERATIONS = 50_000;

interface CivilDate {
  year: number;
  month: number; // 1-12
  day: number;
}

// --- Civil date arithmetic (no time zones: pure calendar days) --------------

function toDayNumber(date: CivilDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function fromDayNumber(days: number): CivilDate {
  const date = new Date(days * 86_400_000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function weekdayOf(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function compareCivil(a: CivilDate, b: CivilDate): number {
  return toDayNumber(a) - toDayNumber(b);
}

// --- Parsing ------------------------------------------------------------------

interface Rule {
  freq: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
  interval: number;
  count?: number;
  until?: Date;
  byDay: Array<{ ordinal: number; weekday: number }>;
  byMonthDay: number[];
  byMonth: number[];
  weekStart: number;
}

interface Property {
  name: string;
  params: Record<string, string>;
  value: string;
}

function parseLine(line: string): Property | null {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const [name, ...params] = line.slice(0, colon).split(';');
  const record: Record<string, string> = {};
  for (const param of params) {
    const [key, value] = param.split('=');
    if (key && value !== undefined) record[key.toUpperCase()] = value;
  }
  return { name: name!.trim().toUpperCase(), params: record, value: line.slice(colon + 1).trim() };
}

/** A DATE or DATE-TIME value from an RRULE UNTIL, RDATE or EXDATE. */
function parseIcsInstant(value: string, timeZone: string): { instant: Date; isDate: boolean } | null {
  const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!match) return null;
  const [, y, mo, d, h, mi, s, z] = match;
  const local = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h ?? 0),
    minute: Number(mi ?? 0),
    second: Number(s ?? 0),
  };
  if (h === undefined) return { instant: fromLocal(local, timeZone), isDate: true };
  if (z) return { instant: new Date(Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)), isDate: false };
  return { instant: fromLocal(local, timeZone), isDate: false };
}

function parseRule(value: string, timeZone: string, unsupported: string[]): Rule | null {
  const parts = new Map<string, string>();
  for (const part of value.split(';')) {
    const [key, raw] = part.split('=');
    if (!key || raw === undefined) continue;
    const name = key.toUpperCase();
    parts.set(name, raw);
    if (!SUPPORTED_PARTS.has(name)) unsupported.push(name);
  }

  const freq = parts.get('FREQ')?.toUpperCase();
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    if (freq) unsupported.push(`FREQ=${freq}`);
    return null;
  }

  const byDay = (parts.get('BYDAY') ?? '')
    .split(',')
    .filter(Boolean)
    .map((token) => {
      const match = /^([+-]?\d{1,2})?(SU|MO|TU|WE|TH|FR|SA)$/i.exec(token.trim());
      return match ? { ordinal: Number(match[1] ?? 0), weekday: WEEKDAYS.indexOf(match[2]!.toUpperCase() as 'SU') } : null;
    })
    .filter((entry): entry is { ordinal: number; weekday: number } => entry !== null);

  const until = parts.get('UNTIL') ? parseIcsInstant(parts.get('UNTIL')!, timeZone) : null;
  const count = Number(parts.get('COUNT'));
  const interval = Number(parts.get('INTERVAL') ?? 1);
  const weekStart = WEEKDAYS.indexOf((parts.get('WKST') ?? 'MO').toUpperCase() as 'MO');

  return {
    freq,
    interval: Number.isFinite(interval) && interval > 0 ? Math.floor(interval) : 1,
    ...(Number.isFinite(count) && count > 0 ? { count: Math.floor(count) } : {}),
    // An all-day UNTIL names a day; the series may run to the end of it.
    ...(until ? { until: until.isDate ? new Date(until.instant.getTime() + 86_399_999) : until.instant } : {}),
    byDay,
    byMonthDay: (parts.get('BYMONTHDAY') ?? '').split(',').filter(Boolean).map(Number).filter(Number.isFinite),
    byMonth: (parts.get('BYMONTH') ?? '').split(',').filter(Boolean).map(Number).filter((m) => m >= 1 && m <= 12),
    weekStart: weekStart >= 0 ? weekStart : 1,
  };
}

// --- Candidate days per period ---------------------------------------------

/** The days a rule selects within one month, in order. */
function daysInMonthMatching(rule: Rule, year: number, month: number, anchorDay: number): number[] {
  const length = daysInMonth(year, month);
  const days = new Set<number>();

  if (rule.byMonthDay.length > 0) {
    for (const value of rule.byMonthDay) {
      const day = value > 0 ? value : length + value + 1;
      if (day >= 1 && day <= length) days.add(day);
    }
  }

  if (rule.byDay.length > 0) {
    for (const { ordinal, weekday } of rule.byDay) {
      const matches: number[] = [];
      for (let day = 1; day <= length; day += 1) {
        if (weekdayOf({ year, month, day }) === weekday) matches.push(day);
      }
      if (ordinal === 0) matches.forEach((day) => days.add(day));
      else {
        const pick = ordinal > 0 ? matches[ordinal - 1] : matches[matches.length + ordinal];
        if (pick !== undefined) days.add(pick);
      }
    }
    // BYMONTHDAY and BYDAY together narrow each other (RFC 5545 §3.3.10).
    if (rule.byMonthDay.length > 0) {
      const byMonthDay = new Set(
        rule.byMonthDay.map((value) => (value > 0 ? value : length + value + 1)),
      );
      for (const day of [...days]) if (!byMonthDay.has(day)) days.delete(day);
    }
  }

  // No day selector: the anchor's day of month. A month without that day
  // (the 31st in April) simply has no occurrence — RFC behaviour, not a bug.
  if (rule.byMonthDay.length === 0 && rule.byDay.length === 0 && anchorDay <= length) days.add(anchorDay);

  return [...days].sort((a, b) => a - b);
}

function* candidateDays(rule: Rule, anchor: CivilDate): Generator<CivilDate> {
  const anchorNumber = toDayNumber(anchor);

  // Every loop is bounded by periods, not by results: a rule that can never
  // match (the 31st of February) must end rather than spin.
  if (rule.freq === 'DAILY') {
    for (let step = 0; step < MAX_ITERATIONS; step += 1) {
      const date = fromDayNumber(anchorNumber + step * rule.interval);
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(date.month)) continue;
      if (rule.byDay.length > 0 && !rule.byDay.some((entry) => entry.weekday === weekdayOf(date))) continue;
      yield date;
    }
  }

  if (rule.freq === 'WEEKLY') {
    const offset = (weekdayOf(anchor) - rule.weekStart + 7) % 7;
    const weekStartNumber = anchorNumber - offset;
    const weekdays = rule.byDay.length > 0 ? rule.byDay.map((entry) => entry.weekday) : [weekdayOf(anchor)];
    const orderedOffsets = [...new Set(weekdays.map((weekday) => (weekday - rule.weekStart + 7) % 7))].sort((a, b) => a - b);

    for (let week = 0; week < MAX_ITERATIONS; week += 1) {
      for (const dayOffset of orderedOffsets) {
        const date = fromDayNumber(weekStartNumber + week * 7 * rule.interval + dayOffset);
        if (rule.byMonth.length > 0 && !rule.byMonth.includes(date.month)) continue;
        yield date;
      }
    }
  }

  if (rule.freq === 'MONTHLY') {
    for (let step = 0; step < MAX_ITERATIONS; step += 1) {
      const monthIndex = anchor.year * 12 + (anchor.month - 1) + step * rule.interval;
      const year = Math.floor(monthIndex / 12);
      const month = (monthIndex % 12) + 1;
      if (rule.byMonth.length > 0 && !rule.byMonth.includes(month)) continue;
      for (const day of daysInMonthMatching(rule, year, month, anchor.day)) yield { year, month, day };
    }
  }

  if (rule.freq === 'YEARLY') {
    for (let step = 0; step < 1_000; step += 1) {
      const year = anchor.year + step * rule.interval;
      const months = rule.byMonth.length > 0 ? [...rule.byMonth].sort((a, b) => a - b) : [anchor.month];
      for (const month of months) {
        const selectors = rule.byDay.length > 0 || rule.byMonthDay.length > 0;
        const days = selectors ? daysInMonthMatching(rule, year, month, anchor.day) : anchor.day <= daysInMonth(year, month) ? [anchor.day] : [];
        for (const day of days) yield { year, month, day };
      }
    }
  }
}

// --- Expansion ------------------------------------------------------------------

/**
 * The occurrences of a series that overlap `window`, earliest first.
 *
 * An occurrence counts if any part of it falls inside the window, so a meeting
 * that started before the window and runs into it still blocks that time.
 */
export function expandRecurrence(series: RecurringSeries, window: Window, limit = 1_000): Expansion {
  const unsupported: string[] = [];
  const lines = series.recurrence.split(/\r?\n/).map(parseLine).filter((line): line is Property => line !== null);
  const duration = series.endsAt.getTime() - series.startsAt.getTime();

  const zoneOf = (property: Property) => property.params.TZID ?? series.timeZone;
  const instantsOf = (property: Property) =>
    property.value
      .split(',')
      .map((value) => parseIcsInstant(value, zoneOf(property)))
      .filter((entry): entry is { instant: Date; isDate: boolean } => entry !== null);

  // Excluded occurrences. A DATE-only EXDATE removes the whole day's occurrence.
  const excludedInstants = new Set<number>();
  const excludedDays = new Set<number>();
  for (const property of lines.filter((line) => line.name === 'EXDATE')) {
    for (const { instant, isDate } of instantsOf(property)) {
      if (isDate) excludedDays.add(toDayNumber(toLocal(instant, series.timeZone)));
      else excludedInstants.add(instant.getTime());
    }
  }
  const isExcluded = (start: Date) =>
    excludedInstants.has(start.getTime()) || excludedDays.has(toDayNumber(toLocal(start, series.timeZone)));

  const starts = new Map<number, Date>();
  const overlaps = (start: Date) => start.getTime() < window.to.getTime() && start.getTime() + duration > window.from.getTime();

  // The series' own first occurrence always counts (RFC 5545: DTSTART is the
  // first instance), even when the rule's pattern would not select that day.
  const ruleLine = lines.find((line) => line.name === 'RRULE');
  const rule = ruleLine ? parseRule(ruleLine.value, series.timeZone, unsupported) : null;

  const local = toLocal(series.startsAt, series.timeZone);
  const anchor: CivilDate = { year: local.year, month: local.month, day: local.day };
  const at = (date: CivilDate) =>
    fromLocal({ ...date, hour: local.hour, minute: local.minute, second: local.second }, series.timeZone);

  let produced = 0;
  if (!isExcluded(series.startsAt) && overlaps(series.startsAt)) starts.set(series.startsAt.getTime(), series.startsAt);
  produced += 1;

  if (rule) {
    let iterations = 0;
    for (const date of candidateDays(rule, anchor)) {
      iterations += 1;
      if (iterations > MAX_ITERATIONS) break;
      if (compareCivil(date, anchor) <= 0) continue; // DTSTART is already counted

      const start = at(date);
      if (rule.until && start.getTime() > rule.until.getTime()) break;
      if (rule.count !== undefined && produced >= rule.count) break;
      if (start.getTime() >= window.to.getTime()) break;

      // Excluded occurrences still count towards COUNT (RFC 5545 §3.8.5.1).
      produced += 1;
      if (!isExcluded(start) && overlaps(start)) starts.set(start.getTime(), start);
      if (starts.size >= limit) break;
    }
  }
  // A rule we could not read at all (an unknown FREQ) leaves only DTSTART —
  // the first occurrence still blocks time, and `unsupported` says why.

  for (const property of lines.filter((line) => line.name === 'RDATE')) {
    for (const { instant, isDate } of instantsOf(property)) {
      const start = isDate ? at(toLocal(instant, series.timeZone)) : instant;
      if (!isExcluded(start) && overlaps(start)) starts.set(start.getTime(), start);
    }
  }

  for (const line of lines) {
    if (!['RRULE', 'RDATE', 'EXDATE'].includes(line.name)) unsupported.push(line.name);
  }

  const occurrences = [...starts.values()]
    .sort((a, b) => a.getTime() - b.getTime())
    .slice(0, limit)
    .map((start) => ({ startsAt: start, endsAt: new Date(start.getTime() + duration) }));

  return { occurrences, unsupported: [...new Set(unsupported)] };
}

// --- Whole calendars ------------------------------------------------------------

/** An event as stored, reduced to what expansion needs. */
export interface StoredEvent {
  id: string;
  calendarId: string;
  externalId: string | null;
  startsAt: Date;
  endsAt: Date;
  isAllDay: boolean;
  timeZone: string;
  rrule: string | null;
  /** On a modified occurrence: the series' own externalId. */
  recurringEventId: string | null;
  /** On a modified occurrence: the start of the occurrence it replaces. */
  originalStartsAt: Date | null;
  status: 'CONFIRMED' | 'TENTATIVE' | 'CANCELLED';
}

export type Occurrence<T extends StoredEvent> = T & {
  /** The stored event this came from (the series, for generated occurrences). */
  sourceId: string;
};

/**
 * Turn stored events — single events, recurring series and their modified
 * occurrences — into the concrete occurrences overlapping `window`.
 *
 * A modified occurrence replaces the one it names; a cancelled one removes it.
 * Generated occurrences get a stable id (`<series id>@<start ISO>`) so a list
 * keyed on ids does not shuffle between renders.
 */
export function occurrencesInWindow<T extends StoredEvent>(events: T[], window: Window): Array<Occurrence<T>> {
  const overrides = events.filter((event) => event.recurringEventId !== null);
  const replaced = new Set(
    overrides
      .filter((event) => event.originalStartsAt !== null)
      .map((event) => `${event.calendarId}|${event.recurringEventId}|${event.originalStartsAt!.getTime()}`),
  );

  const result: Array<Occurrence<T>> = [];
  const overlaps = (event: { startsAt: Date; endsAt: Date }) =>
    event.startsAt.getTime() < window.to.getTime() && event.endsAt.getTime() > window.from.getTime();

  for (const event of events) {
    if (event.status === 'CANCELLED') continue;

    if (event.rrule && event.recurringEventId === null) {
      const { occurrences } = expandRecurrence(
        {
          startsAt: event.startsAt,
          endsAt: event.endsAt,
          timeZone: event.timeZone,
          isAllDay: event.isAllDay,
          recurrence: event.rrule,
        },
        window,
      );
      for (const occurrence of occurrences) {
        if (replaced.has(`${event.calendarId}|${event.externalId}|${occurrence.startsAt.getTime()}`)) continue;
        const isFirst = occurrence.startsAt.getTime() === event.startsAt.getTime();
        result.push({
          ...event,
          id: isFirst ? event.id : `${event.id}@${occurrence.startsAt.toISOString()}`,
          startsAt: occurrence.startsAt,
          endsAt: occurrence.endsAt,
          sourceId: event.id,
        });
      }
      continue;
    }

    if (overlaps(event)) result.push({ ...event, sourceId: event.id });
  }

  return result.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}
