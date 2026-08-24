import { z } from 'zod';
import { parseLocalDay } from '@fluid/core';

/**
 * Calendar dates arriving from the browser.
 *
 * The board's columns, the ritual's "today" and the rollover buttons all name a
 * *calendar date* — "the 24th" — not an instant, and the conversion between the
 * two needs the user's timezone. So the browser sends the date it displayed and
 * the server resolves it against the zone it already knows.
 *
 * The resolution itself lives in `@fluid/core` (`parseLocalDay`), where the
 * rest of the zoned-time logic is and where it can be tested without a server
 * runtime. This module is only the wire format.
 *
 * Deliberately no `import 'server-only'`: nothing here touches a secret, and
 * the marker would make the schema untestable for no benefit.
 */

/** `YYYY-MM-DD`, as rendered in the user's own zone. */
export const localDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected a YYYY-MM-DD date.');

export { parseLocalDay as resolveLocalDay };
