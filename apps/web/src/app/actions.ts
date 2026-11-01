'use server';

/**
 * Server actions — the mutation surface for the UI.
 *
 * Each one runs the same tRPC procedure the HTTP API exposes, then revalidates.
 * Actions return a plain `{ error }` shape rather than throwing, because a
 * thrown error in a form is a blank screen, and a blank screen is where an
 * ADHD user loses the thread of what they were doing.
 */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@fluid/db';
import { fakeVerify, hashPassword, validatePasswordLength, verifyPassword } from '@fluid/crypto';
import { z } from 'zod';
import { assertValidTimeZone } from '@fluid/core';
import { getCaller } from '@/server/caller';
import { createSession, destroySession, getCurrentUser } from '@/server/auth/session';
import { notifyBoardChange } from '@/server/live-notify';

export type ActionState = { error?: string } | undefined;

/**
 * The browser's IANA zone, as the sign-in form reports it — or null when it is
 * missing or not a zone this runtime knows. Every reminder and every "today"
 * is computed in this zone, so a wrong guess is worse than no guess.
 */
function browserTimeZone(formData: FormData): string | null {
  const value = String(formData.get('timeZone') ?? '').trim();
  if (!value || value.length > 64) return null;
  try {
    assertValidTimeZone(value);
    return value;
  } catch {
    return null;
  }
}

const credentials = z.object({
  email: z.string().trim().toLowerCase().email('That does not look like an email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export async function signUp(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Check your details.' };

  const lengthProblem = validatePasswordLength(parsed.data.password);
  if (lengthProblem) return { error: lengthProblem };

  const existing = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  if (existing) {
    // Deliberately vague: confirming which addresses are registered turns the
    // signup form into an account-enumeration oracle.
    return { error: 'That address cannot be used. Try signing in instead.' };
  }

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash: await hashPassword(parsed.data.password),
      // Working hours are wall-clock times in this zone. Defaulting to UTC
      // would put a phone in Sydney's 09:00 reminder at 20:00.
      timeZone: browserTimeZone(formData) ?? 'UTC',
      preferences: { create: {} },
      aiSetting: { create: {} },
      workingHours: {
        create: [1, 2, 3, 4, 5].map((dayOfWeek) => ({
          dayOfWeek,
          startTime: '09:00',
          endTime: '17:00',
        })),
      },
    },
  });

  await prisma.auditLog.create({
    data: { userId: user.id, action: 'user.signup' },
  });

  await createSession(user.id);
  redirect('/today');
}

export async function signIn(_state: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = credentials.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'Check your email and password.' };

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });

  // Burn equivalent CPU when the account does not exist, so response timing
  // does not reveal which addresses are registered.
  if (!user?.passwordHash) {
    await fakeVerify();
    return { error: 'Those details did not match.' };
  }

  const ok = await verifyPassword(user.passwordHash, parsed.data.password);
  if (!ok) {
    await prisma.auditLog.create({
      data: { userId: user.id, action: 'user.signin.failed' },
    });
    return { error: 'Those details did not match.' };
  }

  await prisma.auditLog.create({ data: { userId: user.id, action: 'user.signin' } });

  // Accounts created before the zone was captured are sitting on the UTC
  // default. Adopt the device's zone once; anyone who has picked a zone in
  // Settings keeps it.
  const zone = browserTimeZone(formData);
  if (user.timeZone === 'UTC' && zone && zone !== 'UTC') {
    await prisma.user.update({ where: { id: user.id }, data: { timeZone: zone } });
  }

  await createSession(user.id);
  redirect('/today');
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/login');
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export async function createTask(_state: ActionState, formData: FormData): Promise<ActionState> {
  const caller = await getCaller();
  const deadlineRaw = String(formData.get('deadline') ?? '').trim();

  try {
    await caller.task.create({
      title: String(formData.get('title') ?? ''),
      notes: String(formData.get('notes') ?? '') || undefined,
      projectId: String(formData.get('projectId') ?? '') || null,
      priority: (formData.get('priority') as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT') ?? 'MEDIUM',
      energy: (formData.get('energy') as 'LOW' | 'MEDIUM' | 'HIGH') ?? 'MEDIUM',
      ...(String(formData.get('estimateMinutes') ?? '').trim()
        ? { estimateMinutes: Number(formData.get('estimateMinutes')) }
        : {}),
      deadline: deadlineRaw ? new Date(deadlineRaw) : null,
      isSplittable: formData.get('isSplittable') !== 'off',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that task.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

export async function completeTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.complete({ id: String(formData.get('id')) });
  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
  // Completion moves the card to its board's Done column.
  revalidatePath('/boards', 'layout');
  const user = await getCurrentUser();
  if (user) await notifyBoardChange(user.id);
}

/** The `FormData` shape, for buttons that submit fields rather than an id. */
export async function uncompleteTaskAction(formData: FormData): Promise<{ error?: string }> {
  return uncompleteTask(String(formData.get('id')));
}

/** Reverses `completeTask`, including the side effects completing it had. */
export async function uncompleteTask(taskId: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.uncomplete({ id: taskId });
  } catch (error) {
    return { error: messageFrom(error, 'Could not bring that task back.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
  revalidatePath('/boards', 'layout');
  const user = await getCurrentUser();
  if (user) await notifyBoardChange(user.id);
  return {};
}

export interface TaskEdit {
  id: string;
  title: string;
  notes: string;
  projectId: string | null;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  energy: 'LOW' | 'MEDIUM' | 'HIGH';
  estimateMinutes: number;
  /** `datetime-local` string, or empty to clear the deadline. */
  deadline: string;
  isSplittable: boolean;
}

export async function updateTaskDetails(input: TaskEdit): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.update({
      id: input.id,
      title: input.title,
      notes: input.notes.trim() || undefined,
      projectId: input.projectId,
      priority: input.priority,
      energy: input.energy,
      estimateMinutes: input.estimateMinutes,
      deadline: input.deadline ? new Date(input.deadline) : null,
      isSplittable: input.isSplittable,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save those changes.') };
  }

  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

export async function deleteTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.delete({ id: String(formData.get('id')) });
  revalidatePath('/projects');
  revalidatePath('/week');
}

export async function deferTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.defer({
    id: String(formData.get('id')),
    days: Number(formData.get('days') ?? 1),
  });
  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
}

export async function breakdownTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.breakdown({
    id: String(formData.get('id')),
    granularity: (formData.get('granularity') as 'tiny' | 'normal') ?? 'tiny',
  });
  revalidatePath('/projects');
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
}

export async function acknowledgeAvoidance(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.acknowledgeAvoidance({ id: String(formData.get('id')) });
  revalidatePath('/today');
  revalidatePath('/week');
}

export async function logTime(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.logTime({
    id: String(formData.get('id')),
    minutes: Number(formData.get('minutes') ?? 5),
  });
  revalidatePath('/today');
  revalidatePath('/projects');
  revalidatePath('/week');
  revalidatePath('/focus');
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export async function createProject(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();
  try {
    await caller.project.create({
      name: String(formData.get('name') ?? ''),
      description: String(formData.get('description') ?? '') || undefined,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not create that project.') };
  }
  revalidatePath('/projects');
  return {};
}

// ---------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------

export async function rebuildPlan(): Promise<void> {
  const caller = await getCaller();
  await caller.plan.build({ trigger: 'manual' });
  revalidatePath('/today');
  revalidatePath('/week');
}

export async function acceptPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.accept({
    planVersionId: String(formData.get('planVersionId')),
    auto: formData.get('auto') === 'true',
  });
  revalidatePath('/today');
  revalidatePath('/week');
}

export async function rejectPlanAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.plan.reject({ planVersionId: String(formData.get('planVersionId')) });
  revalidatePath('/today');
  revalidatePath('/week');
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

export async function updateAccessibility(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      highContrast: formData.get('highContrast') === 'on',
      reducedMotion: formData.get('reducedMotion') === 'on',
      dyslexiaFont: formData.get('dyslexiaFont') === 'on',
      largeText: formData.get('largeText') === 'on',
    },
    update: {
      highContrast: formData.get('highContrast') === 'on',
      reducedMotion: formData.get('reducedMotion') === 'on',
      dyslexiaFont: formData.get('dyslexiaFont') === 'on',
      largeText: formData.get('largeText') === 'on',
    },
  });

  revalidatePath('/', 'layout');
}

function messageFrom(error: unknown, fallback: string): string {
  if (error && typeof error === 'object' && 'message' in error) {
    const message = String((error as { message: unknown }).message);
    // tRPC serializes Zod issues as JSON; show the first human sentence.
    try {
      const issues = JSON.parse(message) as Array<{ message?: string }>;
      if (Array.isArray(issues) && issues[0]?.message) return issues[0].message;
    } catch {
      if (message && message.length < 200) return message;
    }
  }
  return fallback;
}

// ---------------------------------------------------------------------------
// AI calendar agent (§3.6)
// ---------------------------------------------------------------------------

export async function reflowSchedule(): Promise<void> {
  const caller = await getCaller();
  await caller.agent.reflow({ trigger: 'manual' });
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/review');
}

export async function revertAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.revert({ id: String(formData.get('id')) });
  revalidatePath('/review');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function confirmAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.confirm({ id: String(formData.get('id')) });
  revalidatePath('/review');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function rejectAiActionAction(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.reject({ id: String(formData.get('id')) });
  revalidatePath('/review');
}

export async function setAutonomy(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.agent.setAutonomy({
    level: formData.get('level') as 'FULL_AUTO' | 'AUTO_WITH_UNDO' | 'PROPOSE_THEN_CONFIRM',
    scope: formData.get('scope') as 'TODAY' | 'THIS_WEEK',
    undoWindowSeconds: Number(formData.get('undoWindowSeconds') ?? 30),
  });
  revalidatePath('/settings');
}

// ---------------------------------------------------------------------------
// AI provider configuration
// ---------------------------------------------------------------------------

export async function saveAiSettings(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.ai.save({
      providerId: String(formData.get('providerId') ?? 'anthropic'),
      model: String(formData.get('model') ?? '').trim() || undefined,
      baseUrl: String(formData.get('baseUrl') ?? '').trim() || undefined,
      apiKey: String(formData.get('apiKey') ?? '').trim() || undefined,
      clearKey: formData.get('clearKey') === 'on',
      allowScheduling: formData.get('allowScheduling') === 'on',
      allowTaskBreakdown: formData.get('allowTaskBreakdown') === 'on',
      allowAvoidanceCheck: formData.get('allowAvoidanceCheck') === 'on',
      allowChat: formData.get('allowChat') === 'on',
      shareTaskText: formData.get('shareTaskText') === 'on',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save those AI settings.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function testAiConnection(): Promise<{ ok: boolean; message: string }> {
  const caller = await getCaller();
  return caller.ai.test();
}

export async function listAiModels(): Promise<string[]> {
  const caller = await getCaller();
  const result = await caller.ai.models();
  return result.models;
}

// ---------------------------------------------------------------------------
// Calendar connections
// ---------------------------------------------------------------------------

export async function connectCalendar(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.calendar.connect({
      serverUrl: String(formData.get('serverUrl') ?? '').trim(),
      username: String(formData.get('username') ?? '').trim(),
      password: String(formData.get('password') ?? ''),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not connect to that calendar server.') };
  }

  // Pull straight away, so the first thing someone sees after connecting is
  // their actual calendar rather than an empty week and a question about
  // whether it worked.
  try {
    await caller.calendar.sync();
  } catch {
    // A failed first sync is not a failed connection — the connection page
    // shows what happened, and Sync now retries it.
  }

  revalidatePath('/settings');
  revalidatePath('/week');
  return {};
}

export async function disconnectCalendar(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.disconnect({ connectionId: String(formData.get('connectionId')) });
  revalidatePath('/settings');
  revalidatePath('/week');
}

export async function syncCalendars(): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.sync();
  revalidatePath('/settings');
  revalidatePath('/week');
  revalidatePath('/today');
}

export async function setCalendarSelected(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.setSelected({
    calendarId: String(formData.get('calendarId')),
    isSelected: formData.get('isSelected') === 'on',
  });
  revalidatePath('/settings');
  revalidatePath('/week');
}

export async function setCalendarWriteTarget(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.setWriteTarget({ calendarId: String(formData.get('calendarId')) });
  revalidatePath('/settings');
}

export async function resumeCalendarSync(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.calendar.resume({ connectionId: String(formData.get('connectionId')) });
  revalidatePath('/settings');
}

// ---------------------------------------------------------------------------
// Dragging a block on the calendar grid
// ---------------------------------------------------------------------------

export async function moveScheduledBlock(input: {
  blockId: string;
  startsAt: Date;
  endsAt: Date;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.plan.moveBlock(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that block.') };
  }

  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// Task timers
// ---------------------------------------------------------------------------

export async function startTaskTimer(
  taskId: string,
): Promise<{ startedAt?: Date; switchedFrom?: string | null; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.startTimer({ id: taskId });
    revalidatePath('/projects');
    revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
    return { startedAt: result.startedAt, switchedFrom: result.switchedFrom };
  } catch (error) {
    return { error: messageFrom(error, 'Could not start the timer.') };
  }
}

export async function stopTaskTimer(taskId: string): Promise<{ minutes?: number; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.stopTimer({ id: taskId });
    revalidatePath('/projects');
    revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
    return { minutes: result.minutes };
  } catch (error) {
    return { error: messageFrom(error, 'Could not stop the timer.') };
  }
}

// ---------------------------------------------------------------------------
// Routines
// ---------------------------------------------------------------------------

export async function createRoutine(input: {
  label: string;
  startTime: string;
  endTime: string;
  days: number[];
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.routine.create(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that routine.') };
  }

  revalidatePath('/week');
  return {};
}

export async function deleteRoutine(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.routine.delete({ groupId: String(formData.get('groupId')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that routine.') };
  }

  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// The day's rituals
// ---------------------------------------------------------------------------

export async function shutdownDay(input: {
  day: string;
  reflection: string;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.shutdown({
      day: new Date(input.day),
      ...(input.reflection.trim() ? { reflection: input.reflection.trim() } : {}),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not close the day.') };
  }

  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

export async function reopenDay(day: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.reopen({ day: new Date(day) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not reopen the day.') };
  }

  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

/** Push an unfinished task to tomorrow. Counts as a deferral, deliberately. */
export async function rolloverTask(formData: FormData): Promise<void> {
  const caller = await getCaller();
  await caller.task.defer({ id: String(formData.get('id')), days: 1 });
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/focus');
}

export async function archiveTask(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.archive({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that to the backlog.') };
  }

  revalidatePath('/today');
  revalidatePath('/projects');
  revalidatePath('/week');
  return {};
}

export async function unarchiveTask(id: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.task.unarchive({ id });
  } catch (error) {
    return { error: messageFrom(error, 'Could not bring that back.') };
  }

  revalidatePath('/today');
  revalidatePath('/projects');
  revalidatePath('/week');
  return {};
}

export async function setTaskBucket(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();
  const raw = String(formData.get('bucket'));

  try {
    await caller.task.setBucket({
      id: String(formData.get('id')),
      bucket: raw === '' ? null : (raw as 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY'),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that.') };
  }

  revalidatePath('/projects');
  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------------

export async function createObjective(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.objective.create({
      title: String(formData.get('title') ?? ''),
      notes: String(formData.get('notes') ?? '') || undefined,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function setObjectiveAchieved(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.setAchieved({
      id: String(formData.get('id')),
      achieved: formData.get('achieved') === 'true',
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not update that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function deleteObjective(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.delete({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that objective.') };
  }

  revalidatePath('/review');
  return {};
}

export async function rollObjectiveForward(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.objective.rollForward({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not carry that forward.') };
  }

  revalidatePath('/review');
  return {};
}

// ---------------------------------------------------------------------------
// Braindump
// ---------------------------------------------------------------------------

export interface BraindumpDraft {
  title: string;
  source: string;
  hints: string[];
  estimateMinutes?: number;
  bucket?: 'SOON' | 'THIS_MONTH' | 'THIS_QUARTER' | 'LATER' | 'SOMEDAY';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  dueInDays?: number;
}

/** What this kind of task has actually taken, from the user's own history. */
export async function suggestEstimate(title: string): Promise<{
  sampleCount: number;
  suggestion: { medianMinutes: number; averageMinutes: number } | null;
}> {
  const caller = await getCaller();
  const result = await caller.task.estimateSuggestion({ title });
  return { sampleCount: result.sampleCount, suggestion: result.suggestion };
}

export async function parseBraindumpText(text: string): Promise<BraindumpDraft[]> {
  const caller = await getCaller();
  return caller.task.parseBraindump({ text });
}

export async function commitBraindump(
  items: BraindumpDraft[],
): Promise<{ count?: number; error?: string }> {
  const caller = await getCaller();

  try {
    const result = await caller.task.commitBraindump({
      items: items.map((item) => ({
        title: item.title,
        ...(item.estimateMinutes !== undefined ? { estimateMinutes: item.estimateMinutes } : {}),
        bucket: item.bucket ?? null,
        priority: item.priority ?? 'MEDIUM',
        dueInDays: item.dueInDays ?? null,
      })),
    });
    revalidatePath('/projects');
    revalidatePath('/today');
  revalidatePath('/week');
    return { count: result.count };
  } catch (error) {
    return { error: messageFrom(error, 'Could not create those tasks.') };
  }
}

// ---------------------------------------------------------------------------
// The week board
// ---------------------------------------------------------------------------

/**
 * Put a task on a day, move it between days, or return it to the backlog.
 *
 * `day` is a plain `YYYY-MM-DD` string rather than a Date: the board is a
 * client component, the columns are already keyed by local date, and sending
 * an instant would invite the browser's timezone to disagree with the user's.
 */
export async function commitTaskToDay(input: {
  taskId: string;
  day: string | null;
  position?: number;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.board.commit({
      taskId: input.taskId,
      day: input.day,
      // Passed through rather than defaulted: omitting it means "append",
      // which is a different instruction to "put it first".
      ...(input.position !== undefined ? { position: input.position } : {}),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not move that task.') };
  }

  revalidatePath('/week');
  revalidatePath('/today');
  revalidatePath('/boards', 'layout');
  const user = await getCurrentUser();
  if (user) await notifyBoardChange(user.id);
  return {};
}

export async function reorderBoardDay(input: {
  day: string;
  orderedIds: string[];
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.board.reorder({
      day: input.day,
      orderedIds: input.orderedIds,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not reorder that day.') };
  }

  revalidatePath('/week');
  return {};
}

export async function rolloverDay(formData: FormData): Promise<{ error?: string }> {
  const from = String(formData.get('from') ?? '');
  const to = String(formData.get('to') ?? '');
  if (!from || !to) return { error: 'Missing day.' };

  const caller = await getCaller();

  try {
    const result = await caller.board.rollover({
      from,
      to,
    });
    revalidatePath('/week');
    revalidatePath('/today');
    return result.moved === 0 ? { error: 'Nothing left to move.' } : {};
  } catch (error) {
    return { error: messageFrom(error, 'Could not move those tasks.') };
  }
}


/** Record that the morning plan was completed, so the prompt stops asking. */
export async function markDayPlanned(day: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.day.markPlanned({ day });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save your plan.') };
  }

  revalidatePath('/today');
  revalidatePath('/week');
  return {};
}

// ---------------------------------------------------------------------------
// Areas
// ---------------------------------------------------------------------------

export async function createArea(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();

  try {
    await caller.area.create({
      name: String(formData.get('name') ?? ''),
      color: String(formData.get('color') ?? '') || null,
      // An unchecked checkbox is simply absent from the form data, so the
      // presence of the key *is* the answer.
      countsTowardCapacity: formData.get('countsTowardCapacity') !== null,
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not add that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function updateArea(input: {
  id: string;
  name?: string;
  color?: string | null;
  countsTowardCapacity?: boolean;
}): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.update(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not save that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function deleteArea(formData: FormData): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.delete({ id: String(formData.get('id')) });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

export async function assignTaskArea(
  taskId: string,
  areaId: string | null,
): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.area.assign({ taskId, areaId });
  } catch (error) {
    return { error: messageFrom(error, 'Could not change that area.') };
  }

  revalidateAreaSurfaces();
  return {};
}

/**
 * An area change moves the capacity arithmetic, so every screen that reports
 * on a day is stale afterwards — not just the one the edit happened on.
 */
function revalidateAreaSurfaces(): void {
  revalidatePath('/settings');
  revalidatePath('/projects');
  revalidatePath('/week');
  revalidatePath('/today');
  revalidatePath('/review');
}

// ---------------------------------------------------------------------------
// Focus rhythm
// ---------------------------------------------------------------------------

/**
 * Save the break cadence.
 *
 * Clamped to the same bounds the form advertises rather than trusted: a form
 * post is an API call, and `min`/`max` attributes are a hint to the browser,
 * not a constraint on the request.
 */
export async function updateFocusRhythm(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const clamp = (value: FormDataEntryValue | null, min: number, max: number, fallback: number) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  };

  const values = {
    pomodoroEnabled: formData.get('pomodoroEnabled') === 'on',
    pomodoroWorkMinutes: clamp(formData.get('pomodoroWorkMinutes'), 10, 180, 50),
    pomodoroBreakMinutes: clamp(formData.get('pomodoroBreakMinutes'), 1, 60, 10),
  };

  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    create: { userId: user.id, ...values },
    update: values,
  });

  revalidatePath('/settings');
  revalidatePath('/focus');
}

/** The estimate used for work nobody estimated. Already-assumed tasks keep theirs. */
export async function updateDefaultEstimate(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  const minutes = Math.round(Number(formData.get('defaultEstimateMinutes')));
  const value = Number.isFinite(minutes) ? Math.min(480, Math.max(5, Math.round(minutes / 5) * 5)) : 30;
  await prisma.userPreferences.upsert({
    where: { userId: user.id },
    create: { userId: user.id, defaultEstimateMinutes: value },
    update: { defaultEstimateMinutes: value },
  });
  revalidatePath('/settings');
}

// ---------------------------------------------------------------------------
// Push notifications
// ---------------------------------------------------------------------------

export interface PushSubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

/** Register this browser or installed app for push. */
export async function savePushSubscription(
  input: PushSubscriptionInput,
): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.notification.subscribe(input);
  } catch (error) {
    return { error: messageFrom(error, 'Could not turn on notifications for this device.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function removePushSubscription(endpoint: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.notification.unsubscribe({ endpoint });
  } catch (error) {
    return { error: messageFrom(error, 'Could not turn off notifications for this device.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function removePushDevice(id: string): Promise<{ error?: string }> {
  const caller = await getCaller();

  try {
    await caller.notification.removeDevice({ id });
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that device.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function sendTestNotification(): Promise<{ error?: string; sent?: number }> {
  const caller = await getCaller();

  try {
    const result = await caller.notification.test();
    if (result.sent === 0) {
      return {
        error:
          result.removed > 0
            ? 'That device had stopped accepting notifications, so it was removed. Turn them on again.'
            : 'The push service did not accept it. Check the device is online and try again.',
      };
    }
    return { sent: result.sent };
  } catch (error) {
    return { error: messageFrom(error, 'Could not send a test notification.') };
  }
}

export async function updateNotificationSettings(
  _state: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const caller = await getCaller();
  const time = (name: string) => {
    const value = String(formData.get(name) ?? '').trim();
    return value === '' ? null : value;
  };

  try {
    await caller.notification.updatePreferences({
      enabled: formData.get('enabled') === 'on',
      blockReminders: formData.get('blockReminders') === 'on',
      dayPrompts: formData.get('dayPrompts') === 'on',
      leadMinutes: Math.min(60, Math.max(0, Math.round(Number(formData.get('leadMinutes') ?? 5)) || 0)),
      quietHoursStart: time('quietHoursStart'),
      quietHoursEnd: time('quietHoursEnd'),
    });
  } catch (error) {
    return { error: messageFrom(error, 'Could not save notification settings.') };
  }

  revalidatePath('/settings');
  return {};
}

export async function updateTimeZone(formData: FormData): Promise<void> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');

  const zone = browserTimeZone(formData);
  if (!zone) return;

  await prisma.user.update({ where: { id: user.id }, data: { timeZone: zone } });
  revalidatePath('/', 'layout');
}

// ---------------------------------------------------------------------------
// Project boards
// ---------------------------------------------------------------------------

/**
 * Anything on a board can change what Today, the week and the task list show
 * — a card moved to Done is finished everywhere — so board writes refresh all
 * of them, not just the board.
 */
async function revalidateBoards(): Promise<void> {
  revalidatePath('/boards', 'layout');
  revalidatePath('/today');
  revalidatePath('/week');
  revalidatePath('/projects');
  // …and in every other open tab or device.
  const user = await getCurrentUser();
  if (user) await notifyBoardChange(user.id);
}

const field = (formData: FormData, name: string) => String(formData.get(name) ?? '').trim();

async function boardMutation(
  run: (caller: Awaited<ReturnType<typeof getCaller>>) => Promise<unknown>,
  fallback: string,
): Promise<{ error?: string }> {
  const caller = await getCaller();
  try {
    await run(caller);
  } catch (error) {
    return { error: messageFrom(error, fallback) };
  }
  await revalidateBoards();
  return {};
}

export async function createBoard(_state: ActionState, formData: FormData): Promise<ActionState> {
  const caller = await getCaller();
  let boardId: string;
  try {
    ({ id: boardId } = await caller.kanban.createBoard({
      name: field(formData, 'name'),
      ...(field(formData, 'templateId') ? { templateId: field(formData, 'templateId') } : {}),
    }));
  } catch (error) {
    return { error: messageFrom(error, 'Could not create that board.') };
  }
  await revalidateBoards();
  redirect(`/boards/${boardId}`);
}

export async function renameBoard(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.renameBoard({ id: field(formData, 'id'), name: field(formData, 'name') }),
    'Could not rename the board.',
  );
}

export async function setBoardArchived(formData: FormData) {
  return boardMutation(
    (caller) =>
      caller.kanban.setBoardArchived({ id: field(formData, 'id'), archived: field(formData, 'archived') === 'true' }),
    'Could not change the board.',
  );
}

export async function addColumn(formData: FormData) {
  const category = field(formData, 'category');
  return boardMutation(
    (caller) =>
      caller.kanban.addColumn({
        boardId: field(formData, 'boardId'),
        name: field(formData, 'name'),
        category: category ? (category as 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE') : null,
      }),
    'Could not add that column.',
  );
}

export async function updateColumn(formData: FormData) {
  const category = field(formData, 'category');
  const wip = field(formData, 'wipLimit');
  return boardMutation(
    (caller) =>
      caller.kanban.updateColumn({
        id: field(formData, 'id'),
        ...(formData.has('name') ? { name: field(formData, 'name') } : {}),
        ...(formData.has('category')
          ? { category: category ? (category as 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE') : null }
          : {}),
        ...(formData.has('wipLimit') ? { wipLimit: wip ? Number(wip) : null } : {}),
      }),
    'Could not change that column.',
  );
}

export async function shiftColumn(formData: FormData) {
  return boardMutation(
    (caller) =>
      caller.kanban.shiftColumn({
        id: field(formData, 'id'),
        direction: field(formData, 'direction') === 'left' ? 'left' : 'right',
      }),
    'Could not move that column.',
  );
}

export async function deleteColumn(formData: FormData) {
  const moveTo = field(formData, 'moveCardsTo');
  return boardMutation(
    (caller) => caller.kanban.deleteColumn({ id: field(formData, 'id'), ...(moveTo ? { moveCardsTo: moveTo } : {}) }),
    'Could not delete that column.',
  );
}

export async function createCard(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.createCard({ columnId: field(formData, 'columnId'), title: field(formData, 'title') }),
    'Could not add that card.',
  );
}

/** Drag-and-drop and the "Move to…" dialog both land here. */
export async function moveBoardCard(input: {
  taskId: string;
  columnId: string;
  beforeId?: string | null;
  afterId?: string | null;
}): Promise<{ error?: string }> {
  return boardMutation((caller) => caller.kanban.moveCard(input), 'Could not move that card.');
}

export async function updateCard(formData: FormData) {
  const has = (name: string) => formData.has(name);
  return boardMutation(
    (caller) =>
      caller.kanban.updateCard({
        id: field(formData, 'id'),
        ...(has('title') ? { title: field(formData, 'title') } : {}),
        ...(has('notes') ? { notes: field(formData, 'notes') || null } : {}),
        ...(has('priority') ? { priority: field(formData, 'priority') as 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT' } : {}),
        ...(has('estimateMinutes') ? { estimateMinutes: Number(field(formData, 'estimateMinutes')) } : {}),
        ...(formData.get('confirmEstimate') === '1' ? { confirmEstimate: true } : {}),
        // The calendar date as typed; the router resolves it in the user's zone.
        ...(has('deadline') ? { deadlineDay: field(formData, 'deadline') || null } : {}),
      }),
    'Could not save that card.',
  );
}

export async function trashBoardCard(formData: FormData) {
  return boardMutation((caller) => caller.kanban.trashCard({ id: field(formData, 'id') }), 'Could not delete that card.');
}

export async function restoreBoardCard(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.restoreCard({ id: field(formData, 'id') }),
    'Could not restore that card.',
  );
}

export async function createLabel(formData: FormData) {
  return boardMutation(async (caller) => {
    const label = await caller.kanban.createLabel({
      name: field(formData, 'name'),
      color: (field(formData, 'color') || 'indigo') as 'indigo',
    });
    const taskId = field(formData, 'taskId');
    if (taskId) await caller.kanban.toggleLabel({ taskId, labelId: label.id });
  }, 'Could not create that label.');
}

export async function deleteLabel(formData: FormData) {
  return boardMutation((caller) => caller.kanban.deleteLabel({ id: field(formData, 'id') }), 'Could not delete that label.');
}

export async function toggleCardLabel(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.toggleLabel({ taskId: field(formData, 'taskId'), labelId: field(formData, 'labelId') }),
    'Could not change that label.',
  );
}

export async function addChecklistItem(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.addChecklistItem({ taskId: field(formData, 'taskId'), text: field(formData, 'text') }),
    'Could not add that item.',
  );
}

export async function toggleChecklistItem(formData: FormData) {
  return boardMutation((caller) => caller.kanban.toggleChecklistItem({ id: field(formData, 'id') }), 'Could not tick that.');
}

export async function deleteChecklistItem(formData: FormData) {
  return boardMutation((caller) => caller.kanban.deleteChecklistItem({ id: field(formData, 'id') }), 'Could not remove that.');
}

export async function promoteChecklistItem(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.promoteChecklistItem({ id: field(formData, 'id') }),
    'Could not make that a subtask.',
  );
}

export async function addComment(formData: FormData) {
  return boardMutation(
    (caller) => caller.kanban.addComment({ taskId: field(formData, 'taskId'), body: field(formData, 'body') }),
    'Could not post that comment.',
  );
}

export async function deleteComment(formData: FormData) {
  return boardMutation((caller) => caller.kanban.deleteComment({ id: field(formData, 'id') }), 'Could not delete that comment.');
}

export async function deleteAttachmentAction(id: string): Promise<{ error?: string }> {
  const user = await getCurrentUser();
  if (!user) return { error: 'Sign in to continue.' };
  try {
    const { deleteAttachment } = await import('@/server/services/attachments');
    await deleteAttachment(user.id, id);
  } catch (error) {
    return { error: messageFrom(error, 'Could not remove that file.') };
  }
  await revalidateBoards();
  return {};
}

export async function saveBoardTemplate(formData: FormData) {
  return boardMutation(
    (caller) =>
      caller.kanban.saveTemplate({
        boardId: field(formData, 'boardId'),
        name: field(formData, 'name'),
        includeCards: formData.get('includeCards') === 'on',
      }),
    'Could not save that template.',
  );
}

export async function deleteBoardTemplate(formData: FormData) {
  return boardMutation((caller) => caller.kanban.deleteTemplate({ id: field(formData, 'id') }), 'Could not delete that template.');
}

export async function saveView(formData: FormData) {
  const boardId = field(formData, 'boardId');
  return boardMutation(
    (caller) =>
      caller.kanban.saveView({
        boardId: boardId || null,
        name: field(formData, 'name'),
        query: field(formData, 'query'),
        layout: field(formData, 'layout') === 'table' ? 'table' : 'board',
      }),
    'Could not save that view.',
  );
}

export async function deleteView(formData: FormData) {
  return boardMutation((caller) => caller.kanban.deleteView({ id: field(formData, 'id') }), 'Could not delete that view.');
}

// ---------------------------------------------------------------------------
// API tokens
// ---------------------------------------------------------------------------

export type TokenState = { error?: string; token?: string; name?: string } | undefined;

/** Make a token. It is returned here, once, and never readable again. */
export async function createApiTokenAction(_state: TokenState, formData: FormData): Promise<TokenState> {
  const caller = await getCaller();
  const expiry = field(formData, 'expiresInDays');
  try {
    const { token } = await caller.apiToken.create({
      name: field(formData, 'name'),
      write: formData.get('write') === 'on',
      expiresInDays: expiry === 'never' ? null : (Number(expiry) as 30 | 90 | 365),
    });
    revalidatePath('/settings');
    return { token, name: field(formData, 'name') };
  } catch (error) {
    return { error: messageFrom(error, 'Could not make that token.') };
  }
}

export async function revokeApiTokenAction(formData: FormData) {
  const caller = await getCaller();
  try {
    await caller.apiToken.revoke({ id: field(formData, 'id') });
  } catch (error) {
    return { error: messageFrom(error, 'Could not revoke that token.') };
  }
  revalidatePath('/settings');
  return {};
}
