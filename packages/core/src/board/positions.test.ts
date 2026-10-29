import { describe, expect, it } from 'vitest';
import { comparePositions, needsRebalance, positionBetween, spreadPositions } from './positions';

describe('positionBetween', () => {
  it('starts in the middle of an empty list', () => {
    expect(positionBetween(null, null)).toBe('V');
  });

  it('places strictly between two keys', () => {
    const key = positionBetween('A', 'C');
    expect(key > 'A' && key < 'C').toBe(true);
  });

  it('finds room between adjacent keys by going one digit deeper', () => {
    const key = positionBetween('A', 'B');
    expect(key > 'A' && key < 'B').toBe(true);
    expect(key.startsWith('A')).toBe(true);
  });

  it('places before the first and after the last', () => {
    expect(positionBetween(null, 'V') < 'V').toBe(true);
    expect(positionBetween('V', null) > 'V').toBe(true);
  });

  it('refuses neighbours in the wrong order — a sign of a stale read', () => {
    expect(() => positionBetween('C', 'A')).toThrow(RangeError);
    expect(() => positionBetween('A', 'A')).toThrow(RangeError);
  });

  it('never produces a key ending in 0', () => {
    let low: string | null = null;
    const high = 'V';
    for (let index = 0; index < 200; index += 1) {
      const key = positionBetween(low, high);
      expect(key.endsWith('0')).toBe(false);
      low = key;
    }
  });

  it('keeps any random sequence of inserts in order', () => {
    // A deterministic pseudo-random walk of inserts at arbitrary indexes.
    let seed = 7;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;

    const list: string[] = [];
    for (let step = 0; step < 500; step += 1) {
      const at = Math.floor(next() * (list.length + 1));
      const key = positionBetween(list[at - 1] ?? null, list[at] ?? null);
      list.splice(at, 0, key);
    }

    const sorted = [...list].sort(comparePositions);
    expect(sorted).toEqual(list);
    expect(new Set(list).size).toBe(list.length);
  });
});

describe('spreadPositions', () => {
  it('produces evenly spaced, sorted, unique keys of one length', () => {
    const keys = spreadPositions(500);
    expect(keys).toHaveLength(500);
    expect([...keys].sort(comparePositions)).toEqual(keys);
    expect(new Set(keys).size).toBe(500);
    expect(new Set(keys.map((key) => key.length)).size).toBe(1);
    expect(keys.some((key) => key.endsWith('0'))).toBe(false);
  });

  it('leaves room to insert anywhere afterwards', () => {
    const keys = spreadPositions(3);
    expect(positionBetween(keys[0], keys[1]) > keys[0]!).toBe(true);
    expect(positionBetween(null, keys[0]) < keys[0]!).toBe(true);
  });

  it('handles nothing', () => {
    expect(spreadPositions(0)).toEqual([]);
  });
});

describe('needsRebalance', () => {
  it('flags only lists whose keys have grown long', () => {
    expect(needsRebalance(['V', 'k'])).toBe(false);
    expect(needsRebalance(['V', 'z'.repeat(30)])).toBe(true);
  });
});
