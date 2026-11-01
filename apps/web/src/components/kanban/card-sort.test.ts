import { describe, expect, it } from 'vitest';
import { parseSort, sortRows, type TableRow } from './card-sort';

const row = (title: string, extra: Partial<TableRow> = {}): TableRow => ({
  id: title,
  title,
  boardId: 'b',
  columnName: 'To do',
  priority: 'MEDIUM',
  estimateMinutes: 30,
  deadline: null,
  plannedFor: null,
  completedAt: null,
  labels: [],
  checklist: { done: 0, total: 0 },
  ...extra,
});

describe('parseSort', () => {
  it('reads a key and an optional leading minus', () => {
    expect(parseSort('priority')).toEqual({ key: 'priority', descending: false });
    expect(parseSort('-estimate')).toEqual({ key: 'estimate', descending: true });
  });

  it('falls back to deadline order for anything else', () => {
    expect(parseSort(undefined)).toEqual({ key: 'due', descending: false });
    expect(parseSort('-nonsense')).toEqual({ key: 'due', descending: false });
  });
});

describe('sortRows', () => {
  const rows = [
    row('b', { priority: 'LOW', estimateMinutes: 60, deadline: new Date('2026-11-05') }),
    row('a', { priority: 'URGENT', estimateMinutes: 15 }),
    row('c', { priority: 'HIGH', estimateMinutes: 60, deadline: new Date('2026-11-02') }),
  ];

  it('sorts by priority with urgent first', () => {
    expect(sortRows(rows, parseSort('priority')).map((r) => r.title)).toEqual(['a', 'c', 'b']);
  });

  it('puts undated cards after dated ones', () => {
    expect(sortRows(rows, parseSort('due')).map((r) => r.title)).toEqual(['c', 'b', 'a']);
  });

  it('breaks ties by title, and does not change the input', () => {
    const before = rows.map((r) => r.title);
    expect(sortRows(rows, parseSort('-estimate')).map((r) => r.title)).toEqual(['b', 'c', 'a']);
    expect(rows.map((r) => r.title)).toEqual(before);
  });
});
