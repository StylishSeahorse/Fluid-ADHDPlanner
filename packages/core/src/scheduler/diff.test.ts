import { describe, expect, it } from 'vitest';
import { diffPlans } from './diff';
import type { PlannedBlock } from './types';

const block = (taskId: string, start: string, end: string): PlannedBlock => ({
  taskId,
  start: new Date(start),
  end: new Date(end),
  isPinned: false,
  chunkIndex: 1,
  chunkCount: 1,
});

const context = {
  timeZone: 'UTC',
  now: new Date('2026-11-02T08:00:00Z'),
  taskTitles: new Map([
    ['a', 'Write the report'],
    ['b', 'Book the dentist'],
  ]),
  trigger: 'manual',
};

describe('diffPlans and assumed estimates', () => {
  it('says when a new session is only as long as the default', () => {
    const changes = diffPlans(
      [],
      [block('a', '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z'), block('b', '2026-11-02T11:00:00Z', '2026-11-02T11:15:00Z')],
      { ...context, assumedEstimates: new Set(['a']) },
    );
    const byTask = new Map(changes.map((change) => [change.taskId, change.reason]));
    expect(byTask.get('a')).toBe('Write the report is scheduled for today at 10:00 (30 min). Its length is your default estimate, since none was set.');
    expect(byTask.get('b')).toBe('Book the dentist is scheduled for today at 11:00 (15 min).');
  });

  it('notes it on a resize too, but not on a plain move', () => {
    const previous = [block('a', '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z'), block('b', '2026-11-02T11:00:00Z', '2026-11-02T11:15:00Z')];
    const next = [block('a', '2026-11-02T10:00:00Z', '2026-11-02T10:45:00Z'), block('b', '2026-11-02T12:00:00Z', '2026-11-02T12:15:00Z')];
    const changes = diffPlans(previous, next, { ...context, assumedEstimates: new Set(['a', 'b']) });
    const byTask = new Map(changes.map((change) => [change.taskId, change]));
    expect(byTask.get('a')?.kind).toBe('RESIZED');
    expect(byTask.get('a')?.reason).toContain('default estimate');
    expect(byTask.get('b')?.kind).toBe('MOVED');
    expect(byTask.get('b')?.reason).not.toContain('default estimate');
  });

  it('is silent when no estimates are assumed', () => {
    const changes = diffPlans([], [block('a', '2026-11-02T10:00:00Z', '2026-11-02T10:30:00Z')], context);
    expect(changes[0]?.reason).not.toContain('default');
  });
});
