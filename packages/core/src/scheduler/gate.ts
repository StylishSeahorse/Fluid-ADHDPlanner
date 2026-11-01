/**
 * The mode gate (§13.C): given a fresh plan's changes, apply it, propose it,
 * or throw it away.
 *
 * The engine computes; this decides what is allowed to happen without asking.
 * Pure, like the engine, so every rule below has a test — in particular that
 * no mode, however automatic, ever applies an always-ask change.
 *
 *   MANUAL     Runs only when asked. Every result is a proposal.
 *   ASSISTED   Every result is a proposal, optionally auto-accepted after a
 *              countdown — never when it holds an always-ask change.
 *   HYBRID     Applies small, low-disruption changes with undo; asks for big ones.
 *   AUTOMATIC  Applies everything except always-ask changes.
 *
 * Always-ask, in every mode: overtime, recovering a missed pinned session,
 * moving work off its committed day, deleting a session with logged time, and
 * anything over the per-day reshuffle cap.
 */
import { startOfLocalDay } from '../time/zoned';
import type { Interval, PlanChangeKind } from './types';

export type SchedulingMode = 'MANUAL' | 'ASSISTED' | 'HYBRID' | 'AUTOMATIC';

/** "How much can Fluid move without asking?" */
export const HYBRID_THRESHOLDS = { CAUTIOUS: 2, BALANCED: 4, RELAXED: 8 } as const;

const IMMINENT_MS = 60 * 60_000;

export interface GateChange {
  kind: PlanChangeKind;
  taskId: string;
  previous?: Interval;
  next?: Interval;
  /** The previous session had been accepted (it is in someone's calendar). */
  previousAccepted?: boolean;
  /** Minutes already logged against the previous session. */
  loggedMinutes?: number;
  /** Its calendar copy has other attendees, or was edited outside Fluid. */
  externallyShared?: boolean;
}

export interface GateInput {
  mode: SchedulingMode;
  changes: GateChange[];
  now: Date;
  timeZone: string;
  /** A person asked for this plan ("Schedule my day", "Replan"). */
  requested: boolean;
  /** Caused by the user's own action in the last minute. Halves the disruption. */
  userInitiated: boolean;
  hybridThreshold: number;
  maxDailyReshuffles: number;
  autoAcceptSeconds: number;
  overtimeProposals: number;
  /** A replan pushed committed work off its day (not the initial commitment). */
  spillsCommitment: boolean;
  recoversMissedPin: boolean;
  /** A calendar has not synced for hours: Hybrid and Automatic act as Assisted. */
  staleCalendar: boolean;
  /** Slot granularity: resizes smaller than this are noise, not change. */
  granularityMinutes: number;
}

export interface GateDecision {
  action: 'APPLY' | 'PROPOSE' | 'DISCARD';
  autoAcceptAt: Date | null;
  disruption: number;
  /** Why it must be asked about, in plain words. Empty when nothing forces a question. */
  alwaysAsk: string[];
  capped: boolean;
  /** The mode actually used, after any stale-calendar downgrade. */
  effectiveMode: SchedulingMode;
  reason: string;
}

const durationMs = (interval: Interval) => interval.end.getTime() - interval.start.getTime();

/**
 * How much a set of changes disturbs a day someone is already living in.
 * Adding work into free time disturbs nothing; moving an accepted session
 * that starts within the hour disturbs a lot.
 */
export function disruptionScore(changes: GateChange[], options: { now: Date; timeZone: string; userInitiated: boolean }): number {
  let score = 0;
  for (const change of changes) {
    let weight = 0;
    if (change.kind === 'MOVED' && change.previous && change.next) {
      const sameDay =
        startOfLocalDay(change.previous.start, options.timeZone).getTime() ===
        startOfLocalDay(change.next.start, options.timeZone).getTime();
      weight = sameDay ? 1 : 2;
    } else if (change.kind === 'RESIZED') {
      weight = 0.5;
    } else if (change.kind === 'REMOVED') {
      weight = change.previousAccepted === false ? 0 : 2;
    }
    if (weight === 0) continue;
    if (change.previous && change.previous.start.getTime() < options.now.getTime() + IMMINENT_MS) weight += 2;
    if (change.externallyShared) weight += 1;
    score += weight;
  }
  return score * (options.userInitiated ? 0.5 : 1);
}

export function gatePlan(input: GateInput): GateDecision {
  const meaningful = input.changes.filter((change) => {
    if (change.kind === 'UNCHANGED') return false;
    if (change.kind === 'RESIZED' && change.previous && change.next) {
      return Math.abs(durationMs(change.next) - durationMs(change.previous)) >= input.granularityMinutes * 60_000;
    }
    return true;
  });
  const disruption = disruptionScore(meaningful, input);

  const alwaysAsk: string[] = [];
  if (input.overtimeProposals > 0) alwaysAsk.push('it suggests working outside your hours');
  if (input.recoversMissedPin) alwaysAsk.push('it finds a new time for a session you placed yourself');
  if (input.spillsCommitment) alwaysAsk.push('it moves work off the day you planned it for');
  if (meaningful.some((change) => change.kind === 'REMOVED' && (change.loggedMinutes ?? 0) > 0)) {
    alwaysAsk.push('it removes a session you already logged time on');
  }

  // Churn per day, counted on the day the session was on.
  const perDay = new Map<number, number>();
  for (const change of meaningful) {
    if (change.kind === 'ADDED' || !change.previous) continue;
    const day = startOfLocalDay(change.previous.start, input.timeZone).getTime();
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
  }
  const capped = [...perDay.values()].some((count) => count > input.maxDailyReshuffles);
  if (capped) alwaysAsk.push(`it changes more than ${input.maxDailyReshuffles} sessions on one day`);

  const effectiveMode: SchedulingMode =
    input.staleCalendar && (input.mode === 'HYBRID' || input.mode === 'AUTOMATIC') ? 'ASSISTED' : input.mode;
  const base = { disruption, alwaysAsk, capped, effectiveMode };

  // Nothing to say: no plan version at all, so an unchanged input is silent (AC-3.4).
  if (meaningful.length === 0 && input.overtimeProposals === 0) {
    return { ...base, action: 'DISCARD', autoAcceptAt: null, reason: 'Nothing changed.' };
  }

  const propose = (reason: string): GateDecision => ({
    ...base,
    action: 'PROPOSE',
    autoAcceptAt:
      effectiveMode !== 'MANUAL' && input.autoAcceptSeconds > 0 && alwaysAsk.length === 0
        ? new Date(input.now.getTime() + input.autoAcceptSeconds * 1000)
        : null,
    reason,
  });
  const apply = (reason: string): GateDecision => ({ ...base, action: 'APPLY', autoAcceptAt: null, reason });
  const askBecause = () => `Needs your OK because ${alwaysAsk.join(', and ')}.`;

  switch (effectiveMode) {
    case 'MANUAL':
      return input.requested
        ? { ...propose('You asked for a plan.'), autoAcceptAt: null }
        : { ...base, action: 'DISCARD', autoAcceptAt: null, reason: 'Manual mode only plans when you ask.' };
    case 'ASSISTED':
      return propose(alwaysAsk.length > 0 ? askBecause() : 'Assisted mode asks before changing anything.');
    case 'HYBRID':
      if (alwaysAsk.length > 0) return propose(askBecause());
      if (disruption > input.hybridThreshold) {
        return propose(`It would move more than you allow without asking (${disruption} over ${input.hybridThreshold}).`);
      }
      return apply('A small change, applied with undo.');
    case 'AUTOMATIC':
      if (alwaysAsk.length > 0) return propose(askBecause());
      return apply('Applied automatically, with undo.');
  }
}
