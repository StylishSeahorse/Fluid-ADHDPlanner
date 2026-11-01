import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma } from '@fluid/db';
import { minutesBetween } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';
import { acceptPlan, currentIssues, decideOvertime, recentAutoApplied, rejectPlan, StalePlanError, undoPlan } from '../services/planning';
import { requestReplan, runReplan } from '../jobs/replan-jobs';
import { overlapsOtherSession } from '../services/block-overlap';
import { replanAfter } from '../replanning';
import { externalEvents } from '../services/external-events';
import { requestPushForUser } from '../jobs/calendar-jobs';

export const planRouter = router({
  /**
   * Re-plan now, because a person asked. The mode gate still decides whether
   * it applies or asks; `schedule_day` is "Schedule my day" (REQ-SCH-DAY).
   */
  build: protectedProcedure
    .input(
      z
        .object({
          trigger: z
            .enum(['manual', 'schedule_day', 'task_skipped', 'task_overran', 'new_urgent_task', 'task_completed', 'external_event_conflict', 'settings_changed'])
            .default('manual'),
        })
        .default({ trigger: 'manual' }),
    )
    .mutation(async ({ ctx, input }) => runReplan(ctx.user.id, input.trigger, { requested: true, userInitiated: true })),

  accept: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        await acceptPlan(ctx.user.id, input.planVersionId);
      } catch (error) {
        if (error instanceof StalePlanError) {
          await requestReplan(ctx.user.id, 'manual', { userInitiated: true, delayMs: 0 });
          throw new TRPCError({ code: 'CONFLICT', message: error.message });
        }
        throw error;
      }
      // Accepted sessions belong on the real calendar; get them there soon.
      await requestPushForUser(ctx.user.id, 'plan-accepted');
    }),

  reject: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await rejectPlan(ctx.user.id, input.planVersionId);
    }),

  /** Undo an applied plan, or one line of it. What comes back comes back pinned. */
  undo: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid(), changeId: z.string().cuid().optional() }))
    .mutation(async ({ ctx, input }) => {
      await undoPlan(ctx.user.id, input.planVersionId, input.changeId);
      await requestPushForUser(ctx.user.id, 'plan-undone');
    }),

  /** Approve or decline an overtime proposal. Nothing goes out of hours otherwise. */
  overtime: protectedProcedure
    .input(z.object({ planVersionId: z.string().cuid(), taskId: z.string().min(1), approve: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await decideOvertime(ctx.user.id, input.planVersionId, input.taskId, input.approve);
      if (input.approve) await requestPushForUser(ctx.user.id, 'overtime-approved');
    }),

  /** What the plan could not do well, for the resolve tray. */
  issues: protectedProcedure.query(async ({ ctx }) => currentIssues(ctx.user.id)),

  /** The latest plan Fluid applied on its own, within the hour, for "Undo". */
  recentAutoApplied: protectedProcedure.query(async ({ ctx }) => recentAutoApplied(ctx.user.id)),

  /**
   * One-tap fixes from the resolve tray. Each is an ordinary edit a person
   * could make by hand; the replan that follows is the usual one.
   */
  resolve: replanAfter('task_changed')
    .input(
      z.discriminatedUnion('kind', [
        z.object({ kind: z.literal('extend-deadline'), taskId: z.string().min(1), days: z.number().int().min(1).max(30) }),
        /** Take `by` minutes off the estimate: the part that does not fit. */
        z.object({ kind: z.literal('trim-estimate'), taskId: z.string().min(1), by: z.number().int().min(1).max(10_080) }),
        z.object({ kind: z.literal('let-go-missed'), blockId: z.string().cuid() }),
      ]),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.kind === 'let-go-missed') {
        await prisma.scheduledBlock.updateMany({
          where: { id: input.blockId, state: 'MISSED', task: { userId: ctx.user.id } },
          data: { state: 'SKIPPED' },
        });
        return;
      }
      const task = await prisma.task.findFirst({ where: { id: input.taskId, userId: ctx.user.id } });
      if (!task) throw new TRPCError({ code: 'NOT_FOUND' });
      if (input.kind === 'extend-deadline') {
        if (!task.deadline) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That task has no deadline.' });
        await prisma.task.update({
          where: { id: task.id },
          data: { deadline: new Date(task.deadline.getTime() + input.days * 86_400_000), lastTouchedAt: new Date() },
        });
      } else {
        await prisma.task.update({
          where: { id: task.id },
          data: { estimateMinutes: Math.max(5, task.estimateMinutes - input.by), estimateAssumed: false, lastTouchedAt: new Date() },
        });
      }
    }),

  /** Why a session is where it is. */
  why: protectedProcedure.input(z.object({ blockId: z.string().cuid() })).query(async ({ ctx, input }) => {
    const block = await prisma.scheduledBlock.findFirst({
      where: { id: input.blockId, task: { userId: ctx.user.id } },
      select: { explanationText: true, isPinned: true },
    });
    if (!block) throw new TRPCError({ code: 'NOT_FOUND' });
    return {
      text:
        block.explanationText ??
        (block.isPinned ? 'You put this here. Fluid never moves it.' : 'Placed before explanations were recorded. The next replan will explain it.'),
    };
  }),

  pending: protectedProcedure.query(async ({ ctx }) => {
    return prisma.planVersion.findFirst({
      where: { userId: ctx.user.id, status: 'PROPOSED' },
      include: { changes: true },
      orderBy: { createdAt: 'desc' },
    });
  }),

  /** Blocks in a window, for the calendar and the day view. */
  blocks: protectedProcedure
    .input(z.object({ from: z.coerce.date(), to: z.coerce.date() }))
    .query(async ({ ctx, input }) => {
      const [blocks, events] = await Promise.all([
        prisma.scheduledBlock.findMany({
          where: {
            task: { userId: ctx.user.id },
            state: { in: ['PROPOSED', 'ACCEPTED', 'COMPLETED', 'MISSED'] },
            startsAt: { lt: input.to },
            endsAt: { gt: input.from },
          },
          include: {
            task: {
              select: {
                id: true,
                title: true,
                // The planner's tick box acts on the task, so it has to read
                // the task's own status. A block's COMPLETED state is not the
                // same fact: un-completing deliberately leaves an already-past
                // block marked complete, and a row keyed off that would stay
                // ticked for a task that is no longer done.
                status: true,
                energy: true,
                priority: true,
                timerStartedAt: true,
                starterStep: true,
                // Focus mode shows time spent against the estimate, and every
                // session says when that estimate was only assumed.
                estimateMinutes: true,
                estimateAssumed: true,
                actualMinutes: true,
                project: { select: { name: true, color: true } },
              },
            },
          },
          orderBy: { startsAt: 'asc' },
        }),
        // Every meeting in the range — busy or not, since this is for display —
        // with recurring series expanded into their occurrences.
        externalEvents(ctx.user.id, { from: input.from, to: input.to }, { busyOnly: false }),
      ]);

      return { blocks, events };
    }),

  /**
   * Move a block by hand — dragging it on the calendar grid.
   *
   * Deliberately not routed through the AI action validator: that gate exists
   * to constrain what the *AI* may decide on its own, and its boundaries
   * (protected time, working hours, double-booking) are about second-guessing
   * an autonomous choice. A person dragging their own block is the opposite —
   * a deliberate, first-party decision — so the only checks here are
   * structural: it is theirs, it is committed (not still a proposal awaiting
   * accept/reject), and the resulting span is not empty.
   *
   * Always pins the block. A drag is the clearest possible statement of
   * intent, and the same rule already applied to remote drags in Google
   * Calendar applies here: once a person has placed something by hand, the
   * scheduler stops moving it.
   */
  moveBlock: protectedProcedure
    .input(
      z
        .object({
          blockId: z.string().cuid(),
          startsAt: z.coerce.date(),
          endsAt: z.coerce.date(),
        })
        .refine((value) => value.endsAt > value.startsAt, {
          message: 'A block cannot end before it starts.',
        }),
    )
    .mutation(async ({ ctx, input }) => {
      // A drag onto other work is a decision: acknowledge the overlap rather
      // than refuse it, and let the next plan move what is in the way.
      const overlapAck = await overlapsOtherSession(prisma, input.blockId, input.startsAt, input.endsAt);
      const result = await prisma.scheduledBlock.updateMany({
        where: {
          id: input.blockId,
          task: { userId: ctx.user.id },
          // A proposal is still awaiting a yes/no on /today; dragging it here
          // would let two different flows disagree about whether it exists.
          state: 'ACCEPTED',
        },
        data: { startsAt: input.startsAt, endsAt: input.endsAt, isPinned: true, ...(overlapAck ? { overlapAck } : {}) },
      });

      if (result.count === 0) {
        throw new TRPCError({
          code: 'NOT_FOUND',
          message: 'That block could not be moved — it may still be awaiting your OK.',
        });
      }

      await requestPushForUser(ctx.user.id, 'block-moved');
      if (overlapAck) await requestReplan(ctx.user.id, 'task_changed', { userInitiated: true, delayMs: 0 });
    }),

  /**
   * Deadline runway.
   *
   * Counts remaining *scheduled working sessions* before each deadline, not
   * calendar days. "Three days left" and "one 45-minute session left" describe
   * the same instant and produce completely different decisions — the second
   * is the one that makes time blindness concrete.
   */
  runway: protectedProcedure.query(async ({ ctx }) => {
    const now = new Date();

    const tasks = await prisma.task.findMany({
      where: {
        userId: ctx.user.id,
        deadline: { not: null, gte: now },
        status: { notIn: ['DONE', 'CANCELLED'] },
      },
      include: {
        scheduledBlocks: {
          where: { state: { in: ['PROPOSED', 'ACCEPTED'] }, startsAt: { gte: now } },
        },
      },
      orderBy: { deadline: 'asc' },
      take: 6,
    });

    return tasks.map((task) => {
      const before = task.scheduledBlocks.filter(
        (block) => task.deadline && block.endsAt <= task.deadline,
      );
      const scheduledMinutes = before.reduce(
        (sum, block) => sum + minutesBetween(block.startsAt, block.endsAt),
        0,
      );
      const remaining = Math.max(0, task.estimateMinutes - task.actualMinutes);

      return {
        taskId: task.id,
        title: task.title,
        deadline: task.deadline!,
        sessionsBeforeDeadline: before.length,
        scheduledMinutes,
        remainingMinutes: remaining,
        // The honest bit: is the work that remains actually on the calendar?
        shortfallMinutes: Math.max(0, remaining - scheduledMinutes),
        daysRemaining: Math.ceil(
          (task.deadline!.getTime() - now.getTime()) / 86_400_000,
        ),
      };
    });
  }),

  /** Estimate-vs-actual accuracy, for the weekly review. */
  estimateAccuracy: protectedProcedure.query(async ({ ctx }) => {
    const samples = await prisma.timeEstimateSample.findMany({
      where: { userId: ctx.user.id },
      orderBy: { recordedAt: 'desc' },
      take: 100,
    });

    if (samples.length === 0) return { sampleCount: 0, byCategory: [] };

    const groups = new Map<string, { estimated: number; actual: number; count: number }>();
    for (const sample of samples) {
      const entry = groups.get(sample.category) ?? { estimated: 0, actual: 0, count: 0 };
      entry.estimated += sample.estimatedMinutes;
      entry.actual += sample.actualMinutes;
      entry.count += 1;
      groups.set(sample.category, entry);
    }

    return {
      sampleCount: samples.length,
      byCategory: [...groups.entries()].map(([category, entry]) => ({
        category,
        count: entry.count,
        // >1 means the work takes longer than expected — the common direction.
        ratio: entry.estimated > 0 ? entry.actual / entry.estimated : 1,
      })),
    };
  }),
});
