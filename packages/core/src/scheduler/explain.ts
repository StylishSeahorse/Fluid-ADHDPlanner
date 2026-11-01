/**
 * "Why here?" — a block's structured explanation as one or two sentences.
 *
 * Rendered in core rather than the UI so the wording is tested alongside the
 * engine that produces the facts, and so the API, the timeline and a push
 * notification all say the same thing.
 */
import { describeMoment } from './diff';
import type { BindingConstraint, BlockExplanation, Priority, RankFactor, Relaxation } from './types';

export interface ExplainContext {
  timeZone: string;
  now: Date;
  /** Titles and facts for the tasks a sentence may mention. */
  tasks: Map<
    string,
    { title: string; priority?: Priority; deadline?: Date | null; deadlineKind?: 'SOFT' | 'HARD' | null; plannedFor?: boolean }
  >;
}

const quote = (title: string) => `“${title}”`;

function factorPhrase(factor: RankFactor, task: ExplainContext['tasks'] extends Map<string, infer T> ? T : never, context: ExplainContext): string | null {
  switch (factor) {
    case 'committed_day':
      return 'you planned it for that day';
    case 'hard_deadline_risk':
      return 'its hard deadline is close';
    case 'priority':
      return task.priority === 'URGENT' ? 'it’s urgent' : task.priority === 'HIGH' ? 'it’s high priority' : null;
    case 'project_importance':
      return 'its project matters more';
    case 'slack':
      return task.deadline
        ? `it’s due ${describeMoment(task.deadline, context.timeZone, context.now)}${task.deadlineKind === 'HARD' ? ' (a hard deadline)' : ''}`
        : null;
    case 'ai_hint':
      return 'the suggested order put it first';
    case 'age':
      return 'it has been waiting longest';
  }
}

function constraintPhrase(constraint: BindingConstraint, context: ExplainContext): string {
  const when = (at: Date) => describeMoment(at, context.timeZone, context.now);
  const title = (taskId: string) => quote(context.tasks.get(taskId)?.title ?? 'another task');
  switch (constraint.kind) {
    case 'now':
      return 'that’s the next free time from now';
    case 'earliest_start':
      return `it can’t start before ${when(constraint.at)}`;
    case 'dependency':
      return `it has to follow ${title(constraint.taskId)}, which ends ${when(constraint.endsAt)}`;
    case 'busy':
      return constraint.title
        ? `${quote(constraint.title)} runs until ${when(constraint.endsAt)}`
        : `your calendar is busy until ${when(constraint.endsAt)}`;
    case 'protected':
      return `${constraint.label ? quote(constraint.label) : 'protected time'} runs until ${when(constraint.endsAt)}`;
    case 'working_hours':
      return 'that’s when your working hours start';
    case 'earlier_work':
      return `${title(constraint.taskId)} comes first and ends ${when(constraint.endsAt)}`;
    case 'previous_session':
      return 'it follows its own earlier session';
    case 'committed_day':
      return 'that’s the start of the day you picked';
    case 'retained_from_previous_plan':
      return 'it was already here and nothing needed the time';
    case 'pinned':
      return 'you put it here';
    case 'daily_cap':
      return 'earlier days already hold your daily work limit';
    case 'preference':
      return 'it suits your energy or preferred time of day better';
    case 'gap_too_short':
      return 'the free gaps before it were too short';
  }
}

const RELAXED: Record<Relaxation, string> = {
  energy: 'Your high-energy time was full, so it’s in a lower-energy slot.',
  preferred_window: 'Your preferred time of day was full, so it’s outside it.',
  committed_day: 'The day you picked was full, so it moved to the next opening.',
  deadline: 'There was no room before the deadline, so it lands after it.',
};

/** One explanation, as text a person reads in a "Why here?" popover. */
export function describeExplanation(taskId: string, start: Date, explanation: BlockExplanation, context: ExplainContext): string {
  const task = context.tasks.get(taskId) ?? { title: 'This task' };
  const at = describeMoment(start, context.timeZone, context.now);
  const binding = explanation.bindingConstraints[0];

  if (binding?.kind === 'pinned') return `${at[0]!.toUpperCase()}${at.slice(1)} because you put it there. Fluid never moves it.`;
  if (binding?.kind === 'retained_from_previous_plan') {
    return `${at[0]!.toUpperCase()}${at.slice(1)} because it was already here, and nothing with a stronger claim needed the time.`;
  }

  const reasons = explanation.rankFactors
    .map((factor) => factorPhrase(factor, task, context))
    .filter((phrase): phrase is string => phrase !== null)
    .slice(0, 2);
  const sentences = [
    `${at[0]!.toUpperCase()}${at.slice(1)}${reasons.length > 0 ? ` because ${reasons.join(' and ')}` : ''}.`,
  ];
  if (binding) sentences.push(`Not earlier: ${constraintPhrase(binding, context)}.`);
  if (explanation.displaced?.length) {
    const names = explanation.displaced.map((id) => quote(context.tasks.get(id)?.title ?? 'other work'));
    sentences.push(`To make room, ${names.join(' and ')} moved later.`);
  }
  if (explanation.adaptive) sentences.push('Its sessions are sized to fit the gaps before its hard deadline.');
  for (const relaxed of explanation.relaxed) sentences.push(RELAXED[relaxed]);
  return sentences.join(' ');
}
