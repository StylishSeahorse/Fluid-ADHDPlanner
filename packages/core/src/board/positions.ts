/**
 * Ordering keys for cards, columns and boards.
 *
 * A position is a string that sorts correctly with plain byte comparison —
 * JavaScript's `<` and Postgres's `COLLATE "C"` agree on it. Moving a card
 * means computing one new key *between* its new neighbours and writing one
 * row, never renumbering the whole column. That matters for two reasons: a
 * drag is a single small write, and two people dropping cards into the same
 * column at once cannot produce conflicting renumberings.
 *
 * Keys are base-62 fractions: "V" is 31/62, "k" is 46/62, "V5" lies between
 * "V" and "W". Keys only grow when two neighbours are adjacent, and
 * `needsRebalance` says when a column's keys have grown long enough to be
 * worth respacing with `spreadPositions`.
 */

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

/** Past this length a column is respaced. Generous: rebalancing is rare. */
export const MAX_POSITION_LENGTH = 24;

function digit(char: string): number {
  const value = DIGITS.indexOf(char);
  if (value < 0) throw new RangeError(`Not a position character: "${char}"`);
  return value;
}

/**
 * A key strictly between `before` and `after`.
 *
 * Either side may be null, meaning "the start" or "the end" of the list. With
 * both null this returns the middle key. Throws if `before` is not strictly
 * less than `after` — a sign the caller read stale neighbours.
 */
export function positionBetween(before: string | null | undefined, after: string | null | undefined): string {
  const low = before ?? '';
  let high: string | null = after ?? null;

  if (high !== null && low >= high) {
    throw new RangeError(`Cannot place between "${low}" and "${high}"`);
  }
  if (low.endsWith('0') || (high !== null && high.endsWith('0'))) {
    // Trailing zeros make two different strings mean the same fraction.
    throw new RangeError('Positions must not end in "0"');
  }

  let result = '';
  for (let index = 0; ; index += 1) {
    const lowDigit = index < low.length ? digit(low[index]!) : 0;
    const highDigit = high === null ? BASE : index < high.length ? digit(high[index]!) : 0;

    if (lowDigit === highDigit) {
      result += DIGITS[lowDigit];
      continue;
    }

    if (highDigit - lowDigit > 1) {
      // Room for a digit strictly between: done. Never 0, since it exceeds lowDigit.
      return result + DIGITS[Math.floor((lowDigit + highDigit) / 2)];
    }

    // Adjacent digits: keep the lower one, and the rest of the key only has to
    // exceed what remains of `low` — the upper bound no longer constrains it.
    result += DIGITS[lowDigit];
    high = null;
  }
}

/**
 * `count` evenly spaced keys, all the same length, in ascending order.
 * Used to lay out a fresh column and to respace one whose keys grew long.
 */
export function spreadPositions(count: number): string[] {
  if (count <= 0) return [];

  // Enough digits that every slot gets a distinct, non-zero-ending key.
  let width = 1;
  while (BASE ** width < (count + 1) * 2) width += 1;

  const span = BASE ** width;
  const keys: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    let value = Math.floor((index * span) / (count + 1));
    if (value % BASE === 0) value += 1; // avoid a trailing "0"
    let key = '';
    for (let place = 0; place < width; place += 1) {
      key = DIGITS[value % BASE] + key;
      value = Math.floor(value / BASE);
    }
    keys.push(key);
  }
  return keys;
}

/** Has any key in this list grown long enough to respace the list? */
export function needsRebalance(positions: Array<string | null | undefined>): boolean {
  return positions.some((position) => (position?.length ?? 0) > MAX_POSITION_LENGTH);
}

/** Byte-order comparison, matching Postgres `COLLATE "C"`. */
export function comparePositions(a: string | null | undefined, b: string | null | undefined): number {
  const left = a ?? '';
  const right = b ?? '';
  return left < right ? -1 : left > right ? 1 : 0;
}
