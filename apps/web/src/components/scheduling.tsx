/**
 * The scheduler, made visible: a proposal to answer, a change to undo, the
 * problems a plan could not solve, and "why is this here?".
 *
 * Server components; every button is an ordinary server action.
 */
import Link from 'next/link';
import {
  acceptPlanAction,
  overtimeAction,
  rejectPlanAction,
  resolveIssueAction,
  undoPlanAction,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { formatDuration, formatTime } from '@/components/format';

const KIND_STYLE: Record<string, string> = {
  REMOVED: 'badge-error',
  MOVED: 'badge-warning',
  RESIZED: 'badge-warning',
  ADDED: 'badge-success',
};

function when(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);
}

interface Change {
  id: string;
  kind: string;
  reason: string;
}

interface Overtime {
  taskId: string;
  title: string;
  intervals: Array<{ start: string; end: string }>;
  minutes: number;
  explanation: string;
  status: string;
}

/** "Why here?" — the stored explanation, one tap away, never in the way. */
export function WhyHere({ text, className = '' }: { text: string | null | undefined; className?: string }) {
  if (!text) return null;
  return (
    <details className={`group text-xs ${className}`}>
      <summary className="text-base-content/45 hover:text-base-content inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
        Why here?
      </summary>
      <p className="bg-base-200/60 text-base-content/75 mt-1 rounded-lg px-2.5 py-1.5 leading-relaxed">{text}</p>
    </details>
  );
}

/** A plan waiting on a yes or no. */
export function PlanProposal({
  pending,
  timeZone,
}: {
  pending: {
    id: string;
    usedAi: boolean;
    trigger: string;
    gateReason: string | null;
    staleCalendarSince: Date | null;
    overtimeProposals: unknown;
    changes: Change[];
  };
  timeZone: string;
}) {
  const changes = pending.changes.filter((change) => change.kind !== 'UNCHANGED');
  const overtime = (Array.isArray(pending.overtimeProposals) ? (pending.overtimeProposals as Overtime[]) : []).filter(
    (entry) => entry.status === 'pending',
  );
  const recovery = pending.trigger === 'missed_session';

  return (
    <section className="card bg-base-100 border-primary/40 mb-5 border shadow-sm" aria-labelledby="proposal-title">
      <div className="card-body gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 id="proposal-title" className="card-title text-base">
            {recovery ? 'A session you placed was missed' : 'A new plan is ready'}
          </h2>
          <span className={`badge badge-sm ${pending.usedAi ? 'badge-secondary' : 'badge-ghost'}`}>{pending.usedAi ? 'with AI' : 'no AI'}</span>
        </div>
        {pending.gateReason ? <p className="text-base-content/60 text-sm">{pending.gateReason}</p> : null}
        {pending.staleCalendarSince ? (
          <p className="text-warning text-xs">
            Based on calendar data from {when(pending.staleCalendarSince, timeZone)} — your calendar hasn’t synced since. Fluid asks
            before changing anything until it does.
          </p>
        ) : null}

        {changes.length > 0 ? (
          <ul className="space-y-1.5">
            {changes.slice(0, 8).map((change) => (
              <li key={change.id} className="flex items-start gap-2 text-sm">
                <span className={`badge badge-xs badge-soft mt-1 shrink-0 ${KIND_STYLE[change.kind] ?? 'badge-ghost'}`}>{change.kind.toLowerCase()}</span>
                <span className="text-base-content/80">{change.reason}</span>
              </li>
            ))}
            {changes.length > 8 ? <li className="text-base-content/50 text-xs">…and {changes.length - 8} more.</li> : null}
          </ul>
        ) : null}

        {overtime.map((entry) => (
          <OvertimeOffer key={entry.taskId} planVersionId={pending.id} overtime={entry} timeZone={timeZone} />
        ))}

        <div className="card-actions">
          {changes.length > 0 ? (
            <LoggedActionButton
              action={acceptPlanAction}
              fields={{ planVersionId: pending.id }}
              successMessage="Accepted the new plan."
              pendingLabel="Accepting…"
              className="btn btn-primary btn-sm rounded-xl"
            >
              Accept
            </LoggedActionButton>
          ) : null}
          <LoggedActionButton
            action={rejectPlanAction}
            fields={{ planVersionId: pending.id }}
            successMessage="Kept the plan you already had."
            pendingLabel="Keeping…"
            className="btn btn-ghost btn-sm"
          >
            Keep what I had
          </LoggedActionButton>
        </div>
      </div>
    </section>
  );
}

function OvertimeOffer({ planVersionId, overtime, timeZone }: { planVersionId: string; overtime: Overtime; timeZone: string }) {
  return (
    <div className="border-warning/40 bg-warning/8 rounded-xl border px-3 py-2.5" data-testid="overtime-offer">
      <p className="text-sm font-semibold">Overtime for “{overtime.title}”?</p>
      <p className="text-base-content/70 mt-0.5 text-sm">{overtime.explanation}</p>
      <p className="mt-1 text-sm">
        {overtime.intervals.map((interval) => `${when(new Date(interval.start), timeZone)}–${formatTime(new Date(interval.end), timeZone)}`).join(', ')}
      </p>
      <div className="mt-2 flex gap-2">
        <LoggedActionButton
          action={overtimeAction}
          fields={{ planVersionId, taskId: overtime.taskId, approve: 'true' }}
          successMessage="Booked it. Fluid will not stretch your hours again without asking."
          className="btn btn-warning btn-xs rounded-lg"
        >
          Yes, book it
        </LoggedActionButton>
        <LoggedActionButton
          action={overtimeAction}
          fields={{ planVersionId, taskId: overtime.taskId, approve: 'false' }}
          successMessage="No overtime. The deadline stays at risk; the tray has other options."
          className="btn btn-ghost btn-xs rounded-lg"
        >
          No thanks
        </LoggedActionButton>
      </div>
    </div>
  );
}

/** "Fluid moved two sessions — Undo." Shown for an hour after an automatic change. */
export function AutoAppliedBanner({
  version,
}: {
  version: { id: string; gateReason: string | null; changes: Change[] } | null;
}) {
  if (!version || version.changes.length === 0) return null;
  const changed = version.changes.filter((change) => !change.reason.endsWith('(undone)'));
  if (changed.length === 0) return null;
  return (
    <section className="border-info/30 bg-info/6 mb-5 rounded-2xl border px-4 py-3" aria-label="Recent automatic change" data-testid="auto-applied">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 grow text-sm">
          <span className="font-semibold">Fluid adjusted your plan.</span>{' '}
          <span className="text-base-content/65">
            {changed.length} change{changed.length === 1 ? '' : 's'}, small enough to make without asking.
          </span>
        </p>
        <LoggedActionButton
          action={undoPlanAction}
          fields={{ planVersionId: version.id }}
          successMessage="Undone. What moved is back, and pinned there."
          pendingLabel="Undoing…"
          className="btn btn-sm rounded-xl"
        >
          Undo all
        </LoggedActionButton>
      </div>
      <details className="mt-1">
        <summary className="text-base-content/55 cursor-pointer text-xs">Details</summary>
        <ul className="mt-2 space-y-1.5">
          {changed.map((change) => (
            <li key={change.id} className="flex items-start gap-2 text-sm">
              <span className={`badge badge-xs badge-soft mt-1 shrink-0 ${KIND_STYLE[change.kind] ?? 'badge-ghost'}`}>{change.kind.toLowerCase()}</span>
              <span className="text-base-content/80 grow">{change.reason}</span>
              <LoggedActionButton
                action={undoPlanAction}
                fields={{ planVersionId: version.id, changeId: change.id }}
                successMessage="Put back, and pinned so it stays."
                className="btn btn-ghost btn-xs shrink-0 rounded-lg"
              >
                Undo
              </LoggedActionButton>
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

interface TrayIssues {
  planVersionId: string | null;
  unscheduled: Array<{ taskId: string; title: string; reason: string; explanation: string; shortfallMinutes: number; hard: boolean }>;
  spilled: Array<{ taskId: string; title: string; explanation: string; spilledMinutes: number; committedDay: string }>;
  overtime: Overtime[];
  missed: Array<{ id: string; startsAt: Date; endsAt: Date; task: { id: string; title: string } }>;
  staleCalendarSince: Date | null;
}

const INFORMATIONAL = new Set(['BEYOND_HORIZON', 'STARTS_AFTER_HORIZON']);

/**
 * What the plan could not do well, each with something to do about it —
 * concrete options, not a red list (US-3.2). Informational items (beyond the
 * planning window) are folded away so they do not read as failures.
 */
export function ResolveTray({ issues, timeZone }: { issues: TrayIssues; timeZone: string }) {
  const problems = issues.unscheduled.filter((entry) => !INFORMATIONAL.has(entry.reason));
  const later = issues.unscheduled.filter((entry) => INFORMATIONAL.has(entry.reason));
  const total = problems.length + issues.spilled.length + issues.overtime.length + issues.missed.length;
  if (total === 0 && later.length === 0) return null;

  return (
    <section className="card bg-base-100 border-base-200 mb-5 border shadow-sm" aria-labelledby="tray-title" data-testid="resolve-tray">
      <div className="card-body gap-3 py-4">
        <h2 id="tray-title" className="card-title text-base">
          {total === 0 ? 'Planned as far as it can be' : total === 1 ? 'One thing to sort out' : `${total} things to sort out`}
        </h2>

        <ul className="divide-base-200 divide-y">
          {issues.missed.map((block) => (
            <li key={block.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
              <div className="min-w-0 grow">
                <p className="text-sm font-medium">{block.task.title}</p>
                <p className="text-base-content/60 text-xs">
                  Missed {when(block.startsAt, timeZone)}. You placed it yourself, so Fluid hasn’t moved it; the work itself goes
                  back into your plan, and anything that needs your OK is shown above.
                </p>
              </div>
              <LoggedActionButton
                action={resolveIssueAction}
                fields={{ kind: 'let-go-missed', blockId: block.id }}
                successMessage="Let it go. No new time will be suggested for that session."
                className="btn btn-ghost btn-xs rounded-lg"
              >
                Let it go
              </LoggedActionButton>
            </li>
          ))}

          {problems.map((entry) => (
            <li key={`${entry.taskId}-${entry.reason}`} className="py-2.5">
              <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                {entry.title}
                {entry.hard ? <span className="badge badge-xs badge-error badge-soft">hard deadline</span> : null}
              </p>
              <p className="text-base-content/60 text-xs">{entry.explanation}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {entry.reason === 'DEADLINE_UNREACHABLE' ? (
                  <LoggedActionButton
                    action={resolveIssueAction}
                    fields={{ kind: 'extend-deadline', taskId: entry.taskId, days: '1' }}
                    successMessage="Deadline moved a day later. Replanning."
                    className="btn btn-outline btn-xs rounded-lg"
                  >
                    Push the deadline a day
                  </LoggedActionButton>
                ) : null}
                {entry.shortfallMinutes > 0 && entry.reason !== 'BLOCKED_BY_DEPENDENCY' && entry.reason !== 'DEPENDENCY_CYCLE' ? (
                  <ShrinkButton taskId={entry.taskId} shortfall={entry.shortfallMinutes} />
                ) : null}
                <Link href={`/tasks?focus=${entry.taskId}`} className="btn btn-ghost btn-xs rounded-lg">
                  {entry.reason === 'BLOCKED_BY_DEPENDENCY' ? 'See what it waits on' : 'Open it'}
                </Link>
              </div>
            </li>
          ))}

          {issues.spilled.map((entry) => (
            <li key={`spill-${entry.taskId}`} className="py-2.5">
              <p className="text-sm font-medium">{entry.title}</p>
              <p className="text-base-content/60 text-xs">{entry.explanation}</p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                <Link href="/week" className="btn btn-ghost btn-xs rounded-lg">
                  Choose another day
                </Link>
              </div>
            </li>
          ))}

          {issues.planVersionId
            ? issues.overtime.map((entry) => (
                <li key={`ot-${entry.taskId}`} className="py-2.5">
                  <OvertimeOffer planVersionId={issues.planVersionId!} overtime={entry} timeZone={timeZone} />
                </li>
              ))
            : null}
        </ul>

        {later.length > 0 ? (
          <details>
            <summary className="text-base-content/50 cursor-pointer text-xs">
              {later.length} task{later.length === 1 ? '' : 's'} planned as the window moves forward
            </summary>
            <ul className="mt-1 space-y-1">
              {later.map((entry) => (
                <li key={entry.taskId} className="text-base-content/60 text-xs">
                  {entry.explanation}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </section>
  );
}

function ShrinkButton({ taskId, shortfall }: { taskId: string; shortfall: number }) {
  return (
    <LoggedActionButton
      action={resolveIssueAction}
      fields={{ kind: 'trim-estimate', taskId, by: String(shortfall) }}
      successMessage="Estimate reduced. Replanning."
      className="btn btn-outline btn-xs rounded-lg"
    >
      Make it {formatDuration(shortfall)} smaller
    </LoggedActionButton>
  );
}
