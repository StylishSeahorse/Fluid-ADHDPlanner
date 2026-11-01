/**
 * The arithmetic behind Focus mode's two clocks. Pure, so it is unit-tested.
 *
 * The interval clock counts from when the timer last started — the same
 * moment the break prompt counts from — so the countdown reaching zero and the
 * prompt appearing are one event, not two that drift apart.
 */

/** `4:07`, or `1:04:07` past an hour. Never negative. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, '0')}:${ss}` : `${minutes}:${ss}`;
}

export interface IntervalClock {
  /** Time left in this stretch; 0 once it is up. */
  remainingMs: number;
  /** How far past the end of the stretch. */
  overMs: number;
  /** 0–1, how much of the stretch has gone. */
  fraction: number;
}

export function intervalClock(elapsedMs: number, workMinutes: number): IntervalClock {
  const lengthMs = Math.max(1, workMinutes) * 60_000;
  const elapsed = Math.max(0, elapsedMs);
  return {
    remainingMs: Math.max(0, lengthMs - elapsed),
    overMs: Math.max(0, elapsed - lengthMs),
    fraction: Math.min(1, elapsed / lengthMs),
  };
}

export interface TaskClock {
  /** Everything logged before, plus the session running now. */
  totalMs: number;
  /** 0–1 of the estimate; capped, so a bar never overflows. */
  fraction: number;
  /** Past the estimate. Information, not a failure. */
  overEstimate: boolean;
}

export function taskClock(loggedMinutes: number, sessionMs: number, estimateMinutes: number): TaskClock {
  const totalMs = Math.max(0, loggedMinutes) * 60_000 + Math.max(0, sessionMs);
  const estimateMs = Math.max(1, estimateMinutes) * 60_000;
  return { totalMs, fraction: Math.min(1, totalMs / estimateMs), overEstimate: totalMs > estimateMs };
}
