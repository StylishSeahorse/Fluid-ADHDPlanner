import { describe, expect, it } from 'vitest';
import { emptyQuery, isEmptyQuery, parseCardQuery, parseMinutes } from './query';

describe('parseCardQuery', () => {
  it('treats plain words as ANDed text', () => {
    expect(parseCardQuery('quarterly report')).toMatchObject({ text: ['quarterly', 'report'] });
  });

  it('keeps quoted phrases whole, including after a key', () => {
    const query = parseCardQuery('"exact phrase" label:"client a"');
    expect(query.text).toEqual(['exact phrase']);
    expect(query.labels).toEqual(['client a']);
  });

  it('understands Deck’s operators and aliases', () => {
    const query = parseCardQuery('tag:todo list:doing date:overdue');
    expect(query.labels).toEqual(['todo']);
    expect(query.columns).toEqual(['doing']);
    expect(query.due).toEqual({ kind: 'overdue' });
  });

  it('negates with a leading minus', () => {
    const query = parseCardQuery('-status:done -label:waiting -draft');
    expect(query.excludeStatus).toEqual(['DONE']);
    expect(query.excludeLabels).toEqual(['waiting']);
    expect(query.excludeText).toEqual(['draft']);
  });

  it('parses comparisons on due date, priority and estimate', () => {
    const query = parseCardQuery('due:<2026-11-07 priority:>=high estimate:>1h30');
    expect(query.due).toEqual({ kind: 'compare', op: '<', date: '2026-11-07' });
    expect(query.priority).toEqual({ op: '>=', value: 'HIGH' });
    expect(query.estimate).toEqual({ kind: 'compare', op: '>', minutes: 90 });
  });

  it('reads planner filters', () => {
    const query = parseCardQuery('planned:none is:blocked board:website');
    expect(query.planned).toEqual({ kind: 'none' });
    expect(query.blocked).toBe(true);
    expect(query.boards).toEqual(['website']);
  });

  it('never rejects input: unknown keys and odd values become text', () => {
    const query = parseCardQuery('meet at 10:30 https://example.com priority:whenever');
    expect(query.text).toEqual(['meet', 'at', '10:30', 'https://example.com', 'priority:whenever']);
    expect(query.priority).toBeNull();
  });

  it('reports an empty query as empty', () => {
    expect(isEmptyQuery(parseCardQuery('   '))).toBe(true);
    expect(isEmptyQuery(emptyQuery())).toBe(true);
    expect(isEmptyQuery(parseCardQuery('x'))).toBe(false);
  });
});

describe('parseMinutes', () => {
  it.each([
    ['90', 90],
    ['45m', 45],
    ['45min', 45],
    ['1h', 60],
    ['1h30', 90],
    ['1.5h', 90],
    ['soon', null],
  ])('%s → %s', (input, expected) => {
    expect(parseMinutes(input)).toBe(expected);
  });
});
