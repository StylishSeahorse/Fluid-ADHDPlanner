import { describe, expect, it } from 'vitest';
import { expandRecurrence, occurrencesInWindow, type StoredEvent } from './recurrence';

const LONDON = 'Europe/London';
const utc = (iso: string) => new Date(iso);

/** A 09:00–09:30 London meeting starting Monday 5 October 2026 (BST, UTC+1). */
const standup = (recurrence: string, overrides: Partial<{ startsAt: Date; endsAt: Date; isAllDay: boolean }> = {}) => ({
  startsAt: utc('2026-10-05T08:00:00Z'),
  endsAt: utc('2026-10-05T08:30:00Z'),
  timeZone: LONDON,
  isAllDay: false,
  recurrence,
  ...overrides,
});

const october = { from: utc('2026-10-01T00:00:00Z'), to: utc('2026-11-01T00:00:00Z') };
const starts = (result: ReturnType<typeof expandRecurrence>) => result.occurrences.map((o) => o.startsAt.toISOString());

describe('expandRecurrence', () => {
  it('expands a weekly rule on chosen weekdays', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=WEEKLY;BYDAY=MO,WE'), {
      from: utc('2026-10-05T00:00:00Z'),
      to: utc('2026-10-15T00:00:00Z'),
    });
    expect(starts(result)).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-07T08:00:00.000Z',
      '2026-10-12T08:00:00.000Z',
      '2026-10-14T08:00:00.000Z',
    ]);
    expect(result.unsupported).toEqual([]);
  });

  it('keeps wall-clock time across the clocks going back', () => {
    // London leaves BST on Sunday 25 October 2026: 09:00 is 08:00Z before, 09:00Z after.
    const result = expandRecurrence(standup('RRULE:FREQ=WEEKLY;BYDAY=MO'), {
      from: utc('2026-10-19T00:00:00Z'),
      to: utc('2026-10-27T00:00:00Z'),
    });
    expect(starts(result)).toEqual(['2026-10-19T08:00:00.000Z', '2026-10-26T09:00:00.000Z']);
  });

  it('honours COUNT, counting from the first occurrence', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=DAILY;COUNT=3'), october);
    expect(starts(result)).toEqual(['2026-10-05T08:00:00.000Z', '2026-10-06T08:00:00.000Z', '2026-10-07T08:00:00.000Z']);
  });

  it('honours UNTIL and INTERVAL', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=WEEKLY;INTERVAL=2;UNTIL=20261031T235959Z'), october);
    expect(starts(result)).toEqual(['2026-10-05T08:00:00.000Z', '2026-10-19T08:00:00.000Z']);
  });

  it('removes EXDATE occurrences, with or without a TZID', () => {
    const rule = ['RRULE:FREQ=DAILY;COUNT=4', 'EXDATE;TZID=Europe/London:20261006T090000', 'EXDATE:20261007T080000Z'].join('\r\n');
    expect(starts(expandRecurrence(standup(rule), october))).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-08T08:00:00.000Z',
    ]);
  });

  it('adds RDATE occurrences', () => {
    const rule = 'RRULE:FREQ=WEEKLY;COUNT=1\nRDATE;TZID=Europe/London:20261010T090000';
    expect(starts(expandRecurrence(standup(rule), october))).toEqual([
      '2026-10-05T08:00:00.000Z',
      '2026-10-10T08:00:00.000Z',
    ]);
  });

  it('picks the nth weekday of the month', () => {
    // Second Tuesday, then last Friday, of each month.
    const second = expandRecurrence(standup('RRULE:FREQ=MONTHLY;BYDAY=2TU'), {
      from: utc('2026-10-01T00:00:00Z'),
      to: utc('2027-01-01T00:00:00Z'),
    });
    expect(starts(second).map((iso) => iso.slice(0, 10))).toEqual(['2026-10-05', '2026-10-13', '2026-11-10', '2026-12-08']);

    const last = expandRecurrence(standup('RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=3'), {
      from: utc('2026-10-01T00:00:00Z'),
      to: utc('2027-06-01T00:00:00Z'),
    });
    expect(starts(last).map((iso) => iso.slice(0, 10))).toEqual(['2026-10-05', '2026-10-30', '2026-11-27']);
  });

  it('skips months without the day rather than moving it', () => {
    const result = expandRecurrence(
      standup('RRULE:FREQ=MONTHLY;COUNT=3', { startsAt: utc('2027-01-31T09:00:00Z'), endsAt: utc('2027-01-31T09:30:00Z') }),
      { from: utc('2027-01-01T00:00:00Z'), to: utc('2027-12-31T00:00:00Z') },
    );
    expect(starts(result).map((iso) => iso.slice(0, 10))).toEqual(['2027-01-31', '2027-03-31', '2027-05-31']);
  });

  it('includes an occurrence that started before the window but runs into it', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=DAILY'), {
      from: utc('2026-10-06T08:15:00Z'),
      to: utc('2026-10-06T12:00:00Z'),
    });
    expect(starts(result)).toEqual(['2026-10-06T08:00:00.000Z']);
  });

  it('expands a long-running series cheaply and only inside the window', () => {
    const result = expandRecurrence(
      standup('RRULE:FREQ=DAILY', { startsAt: utc('2015-01-05T09:00:00Z'), endsAt: utc('2015-01-05T09:30:00Z') }),
      { from: utc('2026-10-12T00:00:00Z'), to: utc('2026-10-14T00:00:00Z') },
    );
    expect(result.occurrences).toHaveLength(2);
  });

  it('terminates on a rule that can never match', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=MONTHLY;BYMONTH=2;BYMONTHDAY=31'), october);
    expect(starts(result)).toEqual(['2026-10-05T08:00:00.000Z']);
  });

  it('reports rule parts it does not implement, but still blocks the base pattern', () => {
    const result = expandRecurrence(standup('RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=2'), october);
    expect(result.unsupported).toEqual(['BYSETPOS']);
    expect(result.occurrences.length).toBeGreaterThan(0);
  });
});

describe('occurrencesInWindow', () => {
  const base: Omit<StoredEvent, 'id' | 'startsAt' | 'endsAt'> = {
    calendarId: 'cal',
    externalId: null,
    isAllDay: false,
    timeZone: LONDON,
    rrule: null,
    recurringEventId: null,
    originalStartsAt: null,
    status: 'CONFIRMED',
  };

  const series: StoredEvent = {
    ...base,
    id: 'master',
    externalId: 'series-1',
    startsAt: utc('2026-10-05T08:00:00Z'),
    endsAt: utc('2026-10-05T08:30:00Z'),
    rrule: 'RRULE:FREQ=DAILY;COUNT=3',
  };

  it('lets a modified occurrence replace the one it names', () => {
    const moved: StoredEvent = {
      ...base,
      id: 'moved',
      externalId: 'series-1_20261006',
      startsAt: utc('2026-10-06T13:00:00Z'),
      endsAt: utc('2026-10-06T13:30:00Z'),
      recurringEventId: 'series-1',
      originalStartsAt: utc('2026-10-06T08:00:00Z'),
    };
    const result = occurrencesInWindow([series, moved], october);
    expect(result.map((event) => [event.id, event.startsAt.toISOString()])).toEqual([
      ['master', '2026-10-05T08:00:00.000Z'],
      ['moved', '2026-10-06T13:00:00.000Z'],
      ['master@2026-10-07T08:00:00.000Z', '2026-10-07T08:00:00.000Z'],
    ]);
  });

  it('drops an occurrence that was cancelled on its own', () => {
    const cancelled: StoredEvent = {
      ...base,
      id: 'cancelled',
      externalId: 'series-1_20261007',
      startsAt: utc('2026-10-07T08:00:00Z'),
      endsAt: utc('2026-10-07T08:30:00Z'),
      recurringEventId: 'series-1',
      originalStartsAt: utc('2026-10-07T08:00:00Z'),
      status: 'CANCELLED',
    };
    const result = occurrencesInWindow([series, cancelled], october);
    expect(result.map((event) => event.startsAt.toISOString().slice(0, 10))).toEqual(['2026-10-05', '2026-10-06']);
    expect(result.every((event) => event.sourceId === 'master')).toBe(true);
  });

  it('passes single events through, filtered to the window', () => {
    const inside: StoredEvent = { ...base, id: 'in', startsAt: utc('2026-10-10T10:00:00Z'), endsAt: utc('2026-10-10T11:00:00Z') };
    const outside: StoredEvent = { ...base, id: 'out', startsAt: utc('2026-12-10T10:00:00Z'), endsAt: utc('2026-12-10T11:00:00Z') };
    expect(occurrencesInWindow([inside, outside], october).map((event) => event.id)).toEqual(['in']);
  });
});
