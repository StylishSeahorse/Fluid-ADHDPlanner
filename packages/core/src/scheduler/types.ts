/**
 * Scheduler domain types.
 *
 * These are deliberately not the Prisma row types. The scheduler is a pure
 * function over plain data — no database, no network, no ambient clock — which
 * is what lets the entire constraint system be tested exhaustively in
 * milliseconds. Mapping from database rows happens at the edge, in the worker.
 */

export type EnergyLevel = 'LOW' | 'MEDIUM' | 'HIGH';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
/**
 * SOFT: a target. Missing it is reported, never prevented at any cost.
 * HARD: a real cut-off. It may displace lower-ranked flexible work and, as a
 * last resort, produce an overtime *proposal* — never an out-of-hours block.
 */
export type DeadlineKind = 'SOFT' | 'HARD';

/** A half-open interval [start, end). Adjacent intervals do not overlap. */
export interface Interval {
  start: Date;
  end: Date;
}

export interface SchedulableTask {
  id: string;
  title: string;
  /** Minutes of work remaining. Already net of any completed sessions. */
  remainingMinutes: number;
  priority: Priority;
  energy: EnergyLevel;
  deadline?: Date;
  /** Do not schedule before this — blocked on something, or not yet relevant. */
  earliestStart?: Date;
  isSplittable: boolean;
  minChunkMinutes: number;
  maxChunkMinutes: number;
  /** Ids of tasks that must be fully scheduled before this one may start. */
  dependsOn?: string[];
  /**
   * The day the user committed this work to, as a half-open local-day interval.
   *
   * This is the Sunsama half of the model: a task becomes a commitment when it
   * is placed on a day, and that decision outranks the scheduler's own opinion
   * about when the work would fit best.
   *
   * Soft, deliberately. If the day genuinely cannot hold the work, the block is
   * still placed elsewhere and the spill is reported — refusing to schedule it
   * would punish someone for a plan that was slightly too optimistic, which is
   * exactly the guilt loop this product exists to avoid.
   */
  committedTo?: Interval;
  /** Purely for diff copy. */
  projectName?: string;
  /** Defaults to SOFT. */
  deadlineKind?: DeadlineKind;
  /** 0 (low) – 2 (high), from the project. Defaults to 1. Ranks after priority. */
  projectImportance?: number;
  /** Older work first among equals, so new tasks cannot starve old ones. */
  createdAt?: Date;
  /**
   * A soft preference for time of day, in local minutes after midnight.
   * Tried together with energy and relaxed before the committed day is.
   */
  preferredWindow?: { startMinute: number; endMinute: number; label?: string };
  /**
   * Position in a validated AI ordering hint. A tie-break *within* the same
   * rank tier only: it can never lift a task above one with a higher priority.
   */
  aiHintRank?: number;
  /**
   * False for personal-area tasks: they occupy time but are not work, so they
   * do not count against `maxDailyWorkMinutes` or the day's work total.
   */
  countsAsWork?: boolean;
}

/** Busy time, with enough identity for an explanation to name it. */
export interface BusyInterval extends Interval {
  id?: string;
  title?: string;
}

/** A block the user has fixed in place. The scheduler routes around it. */
export interface PinnedBlock {
  taskId: string;
  blockId: string;
  start: Date;
  end: Date;
}

/** Recurring weekly availability, in the user's wall-clock time. */
export interface WorkingHoursRule {
  /** 0 = Sunday .. 6 = Saturday. */
  dayOfWeek: number;
  /** "09:00" */
  startTime: string;
  endTime: string;
}

export interface EnergyWindowRule {
  /** null/undefined = every day. */
  dayOfWeek?: number | null;
  startTime: string;
  endTime: string;
  level: EnergyLevel;
}

/** Time the scheduler may never allocate. Outranks every other constraint. */
export interface ProtectedTimeRule {
  kind: 'ROUTINE' | 'BUFFER' | 'HYPERFOCUS';
  /** Nullable rather than optional: this maps straight off a database row. */
  label?: string | null;
  /** Recurring form. */
  dayOfWeek?: number | null;
  startTime?: string | null;
  endTime?: string | null;
  /** One-off form (live hyperfocus protection). */
  start?: Date | null;
  end?: Date | null;
}

export interface SchedulingPreferences {
  /** Breathing room between blocks. Transitions are expensive. */
  bufferMinutes: number;
  /**
   * Granularity of placement. Aligning to a grid keeps the calendar readable
   * and stops the scheduler producing 09:07–09:52 blocks.
   */
  slotGranularityMinutes: number;
  /**
   * A cap below working hours ("I only do five hours of real work a day").
   * Once a day holds this much work, its remaining free time is not used for
   * more. Unset means working hours are the only bound.
   */
  maxDailyWorkMinutes?: number | null;
}

export interface SchedulingInput {
  /** Injected, never read from the ambient clock — that is what makes this testable. */
  now: Date;
  timeZone: string;
  horizonDays: number;

  tasks: SchedulableTask[];
  /** Everything already occupying time: external events plus pinned blocks. */
  busy: BusyInterval[];
  pinned: PinnedBlock[];

  workingHours: WorkingHoursRule[];
  energyWindows: EnergyWindowRule[];
  protectedTimes: ProtectedTimeRule[];
  preferences: SchedulingPreferences;

  /**
   * The plan currently in force. Used to minimize churn: a schedule that
   * reshuffles on every replan is one users stop trusting, and for an ADHD user
   * specifically it destroys the external structure they are relying on.
   */
  previous?: PlannedBlock[];

  /**
   * Hours overtime may never be proposed in, as local "HH:MM" (may wrap past
   * midnight). Overtime is also kept within `overtimeReachMinutes` of the
   * working day, so a proposal never reads as "work at 3am".
   */
  quietHours?: { start: string; end: string } | null;
  overtimeReachMinutes?: number;
}

export interface PlannedBlock {
  taskId: string;
  start: Date;
  end: Date;
  /** True when this block came from `previous` and did not move. */
  isPinned: boolean;
  /** Which chunk of the task this is, when split. 1-based. */
  chunkIndex: number;
  chunkCount: number;
  /** Why this block is where it is. Every block the engine places has one. */
  explanation?: BlockExplanation;
  /**
   * The task's committed day when this block was placed. A block that spilled
   * off its day is kept on the next replan only while the commitment is the
   * same: if the person moves the task to another day, the old spill goes.
   */
  committedDay?: Date;
}

/** What put a task ahead of the one after it, in rank order. */
export type RankFactor =
  | 'committed_day'
  | 'hard_deadline_risk'
  | 'priority'
  | 'project_importance'
  | 'slack'
  | 'ai_hint'
  | 'age';

/** Why a block is not earlier than it is. */
export type BindingConstraint =
  | { kind: 'now' }
  | { kind: 'earliest_start'; at: Date }
  | { kind: 'dependency'; taskId: string; endsAt: Date }
  | { kind: 'busy'; eventId?: string; title?: string; endsAt: Date }
  | { kind: 'protected'; label?: string; endsAt: Date }
  | { kind: 'working_hours' }
  | { kind: 'earlier_work'; taskId: string; endsAt: Date }
  | { kind: 'previous_session' }
  | { kind: 'committed_day' }
  | { kind: 'retained_from_previous_plan' }
  | { kind: 'pinned' }
  | { kind: 'daily_cap' }
  | { kind: 'preference' }
  | { kind: 'gap_too_short' };

export type Relaxation = 'energy' | 'preferred_window' | 'committed_day' | 'deadline';

export interface BlockExplanation {
  rankFactors: RankFactor[];
  bindingConstraints: BindingConstraint[];
  relaxed: Relaxation[];
  /** Tasks whose sessions were moved to make room for this one. */
  displaced?: string[];
  /** Placed by the hard-deadline repair's adaptive chunking. */
  adaptive?: boolean;
}

/**
 * Out-of-hours time that would let a hard deadline be met. Always a proposal:
 * no mode, however automatic, applies it without an explicit yes.
 */
export interface OvertimeProposal {
  taskId: string;
  intervals: Interval[];
  minutes: number;
  /** Minutes still short inside working hours, which these intervals cover. */
  shortfallMinutes: number;
  explanation: string;
}

/** One local day of the horizon, for capacity meters and "≈40 min over". */
export interface DaySummary {
  /** Start of the local day. */
  day: Date;
  /** Free working minutes before anything was placed. */
  availableMinutes: number;
  /** Remaining work committed to this day. */
  committedMinutes: number;
  /** Work actually placed on this day. */
  scheduledMinutes: number;
  overcommitted: boolean;
  spilledMinutes: number;
}

/** A lower-ranked task whose kept session was released to make room. */
export interface Displacement {
  taskId: string;
  /** The task that needed the time. */
  forTaskId: string;
  from: Interval;
}

export type UnscheduledReason =
  | 'NO_AVAILABLE_TIME'
  | 'DEADLINE_UNREACHABLE'
  | 'BLOCKED_BY_DEPENDENCY'
  | 'DEPENDENCY_CYCLE'
  | 'STARTS_AFTER_HORIZON'
  /** Its deadline is past the planning window; the rest is planned as the window moves. */
  | 'BEYOND_HORIZON';

export interface UnscheduledTask {
  taskId: string;
  reason: UnscheduledReason;
  /** Plain language, shown to the user. Never a constraint number. */
  explanation: string;
  /** Minutes we could not place. */
  shortfallMinutes: number;
}

/**
 * Work that was committed to a day but could not entirely fit inside it.
 *
 * Reported rather than silently relocated, and separately from
 * `UnscheduledTask`, because the two mean different things to the user: this
 * work *is* scheduled, just not on the day they picked. Conflating them would
 * turn "your Tuesday was too full" into "this could not be scheduled", which
 * is both false and needlessly alarming.
 */
export interface SpilledCommitment {
  taskId: string;
  /** The day the user asked for. */
  committedTo: Interval;
  /** Minutes that landed outside that day. */
  spilledMinutes: number;
  /** Plain language, shown to the user. */
  explanation: string;
}

export type PlanChangeKind = 'ADDED' | 'MOVED' | 'RESIZED' | 'REMOVED' | 'UNCHANGED';

export interface PlanChange {
  kind: PlanChangeKind;
  taskId: string;
  previous?: Interval;
  next?: Interval;
  /** Written for a human: what changed and why. */
  reason: string;
}

export interface Plan {
  blocks: PlannedBlock[];
  unscheduled: UnscheduledTask[];
  /** Committed work that had to be placed outside the day it was promised to. */
  spilled: SpilledCommitment[];
  changes: PlanChange[];
  overtimeProposals: OvertimeProposal[];
  days: DaySummary[];
  displaced: Displacement[];
  /** Diagnostics, surfaced on the sync/plan detail screen. */
  stats: {
    availableMinutes: number;
    scheduledMinutes: number;
    tasksScheduled: number;
    tasksUnscheduled: number;
  };
}
