/**
 * How full a day is: the one formula the Week board and the side calendar on
 * every project board share, so the two never disagree about the same Tuesday.
 *
 * Two sources, and both are needed. `bookedMinutes` is what the scheduler has
 * actually placed on the day — including work that spilled in from another
 * day, excluding work committed here that had to go elsewhere. On top of that
 * sits anything committed to the day that has no time on it yet, counted at
 * its estimate.
 *
 * Summing estimates alone would show a comfortable Friday while three hours of
 * overflow from Monday sat on it; using only the booked total would leave the
 * bar motionless when a card is dropped, the moment the number is consulted.
 */

/** `YYYY-MM-DD` of an instant in a zone. */
export function dayKeyOf(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(
    new Date(instant),
  );
}

export interface LoadTask {
  status: string;
  estimateMinutes: number;
  area?: { countsTowardCapacity: boolean } | null;
  scheduledBlocks: Array<{ startsAt: Date }>;
}

export function plannedMinutes(dayKey: string, bookedMinutes: number, tasks: LoadTask[], timeZone: string): number {
  const unplaced = tasks.filter(
    (task) =>
      task.status !== 'DONE' && !task.scheduledBlocks.some((block) => dayKeyOf(block.startsAt, timeZone) === dayKey),
  );
  return (
    bookedMinutes +
    unplaced
      // Same ledger split the server applies to booked time: a personal errand
      // shrinks the day but is not work the day owes.
      .filter((task) => task.area?.countsTowardCapacity !== false)
      .reduce((sum, task) => sum + task.estimateMinutes, 0)
  );
}
