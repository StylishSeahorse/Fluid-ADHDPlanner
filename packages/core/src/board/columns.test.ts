import { describe, expect, it } from 'vitest';
import { categoryForStatus, DEFAULT_COLUMNS, statusForCategory } from './columns';

describe('column categories', () => {
  it('maps every category to the status the scheduler reads', () => {
    expect(statusForCategory('BACKLOG')).toBe('BACKLOG');
    expect(statusForCategory('TODO')).toBe('READY');
    expect(statusForCategory('IN_PROGRESS')).toBe('IN_PROGRESS');
    expect(statusForCategory('DONE')).toBe('DONE');
  });

  it('places existing tasks in the column matching their status', () => {
    expect(categoryForStatus('READY')).toBe('TODO');
    expect(categoryForStatus('BLOCKED')).toBe('TODO');
    expect(categoryForStatus('CANCELLED')).toBe('DONE');
  });

  it('round-trips: a card placed by status keeps that status when dropped back', () => {
    for (const status of ['BACKLOG', 'READY', 'IN_PROGRESS', 'DONE'] as const) {
      expect(statusForCategory(categoryForStatus(status))).toBe(status);
    }
  });

  it('gives new boards one column of each kind, ending in Done', () => {
    expect(DEFAULT_COLUMNS.map((column) => column.category)).toEqual(['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE']);
  });
});
