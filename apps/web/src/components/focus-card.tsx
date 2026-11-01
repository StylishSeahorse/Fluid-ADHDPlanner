'use client';

/**
 * The one thing to do now.
 *
 * "Just start — 5 minutes" used to quietly add five minutes to a counter
 * nothing on screen displayed, so the biggest button on the page looked
 * broken. It now starts the real timer: the number moves, which is the
 * entire point. Initiation is the barrier, so the offer stays small — five
 * minutes, stop whenever — while what actually happens underneath is an
 * honest recording of however long the person really worked.
 *
 * Once past five minutes the copy changes to say the deal is met. That
 * matters: someone who agreed to five minutes and is still going at twenty
 * should be told they already won, not left feeling they signed up for
 * something open-ended.
 */
import { useEffect, useState, useTransition } from 'react';
import { startTaskTimer, stopTaskTimer } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { TimerIcon } from '@/components/icons';
import { formatDuration } from '@/components/format';
import { formatClock, intervalClock, taskClock } from '@/components/focus-timers';
import { ASSUMED_ESTIMATE_HINT } from '@/components/estimate';

const FIVE_MINUTES_MS = 5 * 60_000;

export interface TaskTime {
  /** Logged before the session running now. */
  loggedMinutes: number;
  estimateMinutes: number;
  estimateAssumed: boolean;
}

export function FocusTimer({
  taskId,
  taskTitle,
  startedAt,
  taskTime,
  rhythm,
}: {
  taskId: string;
  taskTitle: string;
  startedAt: Date | null;
  /**
   * Given in Focus mode, where both clocks show at once: the stretch until the
   * next break, and the whole time on this task against its estimate. Seeing
   * only one forces a choice between pacing and progress, and either hidden
   * number becomes a source of low-level worry.
   */
  taskTime?: TaskTime;
  rhythm?: { enabled: boolean; workMinutes: number };
}) {
  const [pending, startTransition] = useTransition();
  const [elapsedMs, setElapsedMs] = useState(() => (startedAt ? Date.now() - startedAt.getTime() : 0));

  useEffect(() => {
    if (!startedAt) return;
    setElapsedMs(Date.now() - startedAt.getTime());
    const id = setInterval(() => setElapsedMs(Date.now() - startedAt.getTime()), 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  if (!startedAt) {
    return (
      <>
        <button
          type="button"
          className="btn btn-primary w-full gap-2 sm:w-auto"
          disabled={pending}
          onClick={() => {
            startTransition(async () => {
              const result = await startTaskTimer(taskId);
              if (result.error) {
                logAction(result.error, 'error');
                return;
              }
              logAction(
                result.switchedFrom
                  ? `Started "${taskTitle}" (stopped "${result.switchedFrom}").`
                  : `Started "${taskTitle}".`,
                'success',
              );
            });
          }}
        >
          {pending ? <span className="loading loading-dots loading-xs" /> : <TimerIcon />}
          Just start — 5 minutes
        </button>
        {taskTime && taskTime.loggedMinutes > 0 ? (
          <p className="text-base-content/55 mt-2 text-sm">
            {formatDuration(taskTime.loggedMinutes)} on this so far, of {taskTime.estimateAssumed ? '~' : ''}
            {formatDuration(taskTime.estimateMinutes)}.
          </p>
        ) : null}
      </>
    );
  }

  const pastTheDeal = elapsedMs >= FIVE_MINUTES_MS;

  const stop = (
    <button
      type="button"
      className="btn btn-error btn-soft btn-sm gap-2"
      disabled={pending}
      onClick={() => {
        startTransition(async () => {
          const result = await stopTaskTimer(taskId);
          if (result.error) {
            logAction(result.error, 'error');
            return;
          }
          const minutes = result.minutes ?? 0;
          logAction(`Logged ${minutes} minute${minutes === 1 ? '' : 's'} on "${taskTitle}".`, 'success');
        });
      }}
    >
      {pending ? (
        <span className="loading loading-dots loading-xs" />
      ) : (
        <span className="bg-error inline-block size-2 animate-pulse rounded-full" aria-hidden="true" />
      )}
      Stop and log it
    </button>
  );

  const promise = (
    <p className={`text-sm ${pastTheDeal ? 'text-success' : 'text-base-content/55'}`}>
      {pastTheDeal
        ? 'Five minutes done — you kept the deal. Carry on or stop, both count.'
        : 'Five minutes is the whole commitment. Stop whenever you like.'}
    </p>
  );

  // --- Focus mode: both clocks at once --------------------------------------
  if (taskTime && rhythm) {
    const interval = intervalClock(elapsedMs, rhythm.workMinutes);
    const task = taskClock(taskTime.loggedMinutes, elapsedMs, taskTime.estimateMinutes);
    const estimateLabel = `${taskTime.estimateAssumed ? '~' : ''}${formatDuration(taskTime.estimateMinutes)}`;

    return (
      <div className="w-full space-y-3">
        <div className="grid grid-cols-2 gap-3 text-left" data-testid="focus-clocks">
          <div className="bg-base-200/60 rounded-2xl p-3">
            <p className="text-base-content/50 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">
              {rhythm.enabled ? (interval.overMs > 0 ? 'Break due' : 'Until a break') : 'This stretch'}
            </p>
            <p
              className={`font-mono text-3xl font-bold tabular-nums ${interval.overMs > 0 && rhythm.enabled ? 'text-warning' : 'text-primary'}`}
              role="timer"
              aria-live="off"
              aria-label={rhythm.enabled ? 'Time until a break' : 'Time in this stretch'}
            >
              {rhythm.enabled
                ? interval.overMs > 0
                  ? `+${formatClock(interval.overMs)}`
                  : formatClock(interval.remainingMs)
                : formatClock(elapsedMs)}
            </p>
            {rhythm.enabled ? (
              <progress
                className="progress progress-primary mt-1 h-1.5 w-full"
                value={interval.fraction}
                max={1}
                aria-hidden="true"
              />
            ) : null}
            <p className="text-base-content/50 mt-1 text-xs">
              {rhythm.enabled
                ? `${formatClock(elapsedMs)} of a ${formatDuration(rhythm.workMinutes)} stretch`
                : 'Breaks are off in Settings'}
            </p>
          </div>

          <div className="bg-base-200/60 rounded-2xl p-3">
            <p className="text-base-content/50 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">
              On this task
            </p>
            <p
              className="font-mono text-3xl font-bold tabular-nums"
              role="timer"
              aria-live="off"
              aria-label="Total time on this task"
            >
              {formatClock(task.totalMs)}
            </p>
            <progress
              className={`progress mt-1 h-1.5 w-full ${task.overEstimate ? 'progress-warning' : 'progress-success'}`}
              value={task.fraction}
              max={1}
              aria-hidden="true"
            />
            <p
              className="text-base-content/50 mt-1 text-xs"
              title={taskTime.estimateAssumed ? ASSUMED_ESTIMATE_HINT : undefined}
            >
              {task.overEstimate ? 'Past the ' : 'Of '}
              {estimateLabel} estimate
              {taskTime.estimateAssumed ? ' (assumed)' : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-3">{stop}</div>
        {promise}
      </div>
    );
  }

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-primary font-mono text-3xl font-bold tabular-nums" role="timer" aria-live="off">
          {formatClock(elapsedMs)}
        </span>
        {stop}
      </div>

      {promise}
    </div>
  );
}
