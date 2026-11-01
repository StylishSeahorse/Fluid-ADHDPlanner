/**
 * Project boards: Kanban over the same task rows every other screen uses.
 *
 * Named `kanban` because `board` already means the week board (days as
 * columns). The two are lenses on one set of cards: this one asks *where is
 * this work in its workflow*, the week board asks *which day is it for*.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { prisma, type Prisma, type Task, type TaskStatus } from '@fluid/db';
import { comparePositions, parseCardQuery, parseLocalDay, positionBetween, startOfLocalDay } from '@fluid/core';
import { protectedProcedure, router } from '../trpc';
import { replanAfter } from '../replanning';
import {
  cardWhere,
  createBoardInTx,
  ensureBoards,
  loadBoard,
  loadCard,
  logActivity,
  moveCard,
  purgeOldTrash,
  restoreCard,
  statusForCategory,
  trashCard,
} from '../services/boards';
import { completeTaskInTx, uncompleteTaskInTx } from '../services/task-lifecycle';
import { applyTemplate, BUILT_IN_TEMPLATES, resolveTemplate, saveBoardAsTemplate, templateStructure } from '../services/templates';
import { defaultEstimate, estimateFields } from '../services/estimates';
import { LABEL_COLORS } from '../../components/label-colors';

const id = z.string().min(1).max(64);
const category = z.enum(['BACKLOG', 'TODO', 'IN_PROGRESS', 'DONE']).nullable();

/** What a card face needs — enough to draw it, nothing that has to be scrolled to. */
const cardSelect = {
  id: true,
  title: true,
  status: true,
  priority: true,
  estimateMinutes: true,
  estimateAssumed: true,
  deadline: true,
  plannedFor: true,
  completedAt: true,
  position: true,
  columnId: true,
  labels: { select: { label: { select: { id: true, name: true, color: true } } } },
  checklistItems: { select: { checkedAt: true } },
  _count: { select: { comments: true, subtasks: true, attachments: true } },
  blockedBy: { select: { prerequisite: { select: { completedAt: true } } } },
  scheduledBlocks: {
    where: { state: { in: ['PROPOSED', 'ACCEPTED'] as ('PROPOSED' | 'ACCEPTED')[] } },
    orderBy: { startsAt: 'asc' as const },
    take: 1,
    select: { startsAt: true, state: true },
  },
} as const;

/** A board's cards can be many; Done is capped so a year of history does not load every time. */
const DONE_CARDS_SHOWN = 30;

function toCard<T extends {
  labels: Array<{ label: { id: string; name: string; color: string } }>;
  checklistItems: Array<{ checkedAt: Date | null }>;
  blockedBy: Array<{ prerequisite: { completedAt: Date | null } }>;
  scheduledBlocks: Array<{ startsAt: Date; state: string }>;
  _count: { comments: number; subtasks: number; attachments: number };
}>(task: T) {
  const { labels, checklistItems, blockedBy, scheduledBlocks, _count, ...rest } = task;
  return {
    ...rest,
    labels: labels.map((entry) => entry.label),
    checklist: { done: checklistItems.filter((item) => item.checkedAt).length, total: checklistItems.length },
    commentCount: _count.comments,
    attachmentCount: _count.attachments,
    subtaskCount: _count.subtasks,
    blocked: blockedBy.some((dependency) => dependency.prerequisite.completedAt === null),
    nextSession: scheduledBlocks[0] ?? null,
  };
}

export const kanbanRouter = router({
  /** Every board, for the board list and the "move to board" picker. */
  boards: protectedProcedure.query(async ({ ctx }) => {
    const { workspaceId } = await ensureBoards(ctx.user.id);
    const boards = await prisma.board.findMany({
      where: { workspaceId },
      include: {
        project: { select: { id: true, color: true, deadline: true } },
        columns: { select: { id: true, name: true, category: true, position: true } },
        tasks: {
          where: { parentId: null },
          select: { status: true, deadline: true, completedAt: true },
        },
      },
    });

    const now = new Date();
    return boards
      .sort((a, b) => Number(b.isInbox) - Number(a.isInbox) || comparePositions(a.position, b.position))
      .map((board) => ({
        id: board.id,
        name: board.name,
        isInbox: board.isInbox,
        archivedAt: board.archivedAt,
        color: board.project?.color ?? null,
        deadline: board.project?.deadline ?? null,
        columns: board.columns.sort((a, b) => comparePositions(a.position, b.position)),
        open: board.tasks.filter((task) => task.status !== 'DONE').length,
        done: board.tasks.filter((task) => task.status === 'DONE').length,
        overdue: board.tasks.filter((task) => !task.completedAt && task.deadline && task.deadline < now).length,
      }));
  }),

  /** One board, its columns in order, and its cards — filtered when a query is given. */
  board: protectedProcedure
    .input(z.object({ id, q: z.string().max(500).optional() }))
    .query(async ({ ctx, input }) => {
      const { workspaceId } = await ensureBoards(ctx.user.id);
      const board = await loadBoard(prisma, ctx.user.id, input.id);

      const filter = input.q?.trim() ? cardWhere(parseCardQuery(input.q), ctx.user.id, ctx.user.timeZone) : {};
      const tasks = await prisma.task.findMany({
        where: { AND: [{ boardId: board.id, parentId: null }, filter] },
        select: cardSelect,
      });

      const columns = [...board.columns].sort((a, b) => comparePositions(a.position, b.position));
      const [labels, trash] = await Promise.all([
        prisma.label.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } }),
        purgeOldTrash(workspaceId).then(() =>
          prisma.trashedCard.findMany({
            where: { boardId: board.id },
            orderBy: { trashedAt: 'desc' },
            take: 20,
            select: { id: true, title: true, trashedAt: true },
          }),
        ),
      ]);

      const project = board.projectId
        ? await prisma.project.findUnique({ where: { id: board.projectId }, select: { importance: true } })
        : null;
      return {
        id: board.id,
        name: board.name,
        isInbox: board.isInbox,
        archivedAt: board.archivedAt,
        importance: project?.importance ?? null,
        filtered: Boolean(input.q?.trim()),
        labels,
        trash,
        columns: columns.map((column) => {
          const cards = tasks
            .filter((task) => task.columnId === column.id)
            .sort((a, b) => comparePositions(a.position, b.position));
          const shown = column.category === 'DONE' ? cards.slice(0, DONE_CARDS_SHOWN) : cards;
          return {
            id: column.id,
            name: column.name,
            category: column.category,
            wipLimit: column.wipLimit,
            autoSchedule: column.autoSchedule,
            total: cards.length,
            estimateMinutes: cards.reduce((sum, card) => sum + (card.completedAt ? 0 : card.estimateMinutes), 0),
            cards: shown.map(toCard),
          };
        }),
      };
    }),

  /**
   * Search every board at once, with the same grammar as the board filter.
   * An empty query lists every open card — the cross-board table's default.
   */
  search: protectedProcedure
    .input(z.object({ q: z.string().max(500), limit: z.number().int().min(1).max(500).default(200) }))
    .query(async ({ ctx, input }) => {
      await ensureBoards(ctx.user.id);
      const text = input.q.trim() || '-status:done';
      const tasks = await prisma.task.findMany({
        where: cardWhere(parseCardQuery(text), ctx.user.id, ctx.user.timeZone),
        select: {
          ...cardSelect,
          updatedAt: true,
          board: { select: { id: true, name: true } },
          column: { select: { name: true } },
        },
        orderBy: [{ completedAt: { sort: 'asc', nulls: 'first' } }, { deadline: { sort: 'asc', nulls: 'last' } }],
        take: input.limit,
      });
      return tasks.map((task) => ({ ...toCard(task), board: task.board, column: task.column }));
    }),

  // --- Saved views ------------------------------------------------------------

  /** Views for one board, or (boardId null) the cross-board ones. */
  views: protectedProcedure.input(z.object({ boardId: id.nullable() })).query(async ({ ctx, input }) => {
    return prisma.savedView.findMany({
      where: { userId: ctx.user.id, boardId: input.boardId },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, query: true, layout: true },
    });
  }),

  saveView: protectedProcedure
    .input(
      z.object({
        boardId: id.nullable(),
        name: z.string().trim().min(1).max(60),
        query: z.string().max(500),
        layout: z.enum(['board', 'table']).default('board'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { workspaceId } = await ensureBoards(ctx.user.id);
      if (input.boardId) await loadBoard(prisma, ctx.user.id, input.boardId);
      // Same name on the same board replaces, rather than piling up duplicates.
      const existing = await prisma.savedView.findFirst({
        where: { userId: ctx.user.id, boardId: input.boardId, name: input.name },
      });
      if (existing) {
        return prisma.savedView.update({ where: { id: existing.id }, data: { query: input.query, layout: input.layout } });
      }
      return prisma.savedView.create({ data: { workspaceId, userId: ctx.user.id, ...input } });
    }),

  deleteView: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await prisma.savedView.deleteMany({ where: { id: input.id, userId: ctx.user.id } });
  }),

  // --- Boards ---------------------------------------------------------------

  /** A new board is a new project with its board — one name, one step. */
  /** Starting points for a new board: the built-in ones, then any you saved. */
  templates: protectedProcedure.query(async ({ ctx }) => {
    const { workspaceId } = await ensureBoards(ctx.user.id);
    const saved = await prisma.boardTemplate.findMany({ where: { workspaceId }, orderBy: { name: 'asc' } });
    return {
      builtIn: BUILT_IN_TEMPLATES.map((template) => ({
        id: `builtin:${template.key}`,
        name: template.name,
        description: template.description,
        columns: template.structure.columns.map((column) => column.name),
      })),
      saved: saved.map((template) => ({
        id: template.id,
        name: template.name,
        description: template.description,
        columns: templateStructure.safeParse(template.structure).data?.columns.map((column) => column.name) ?? [],
      })),
    };
  }),

  /** A new board is a new project with its board — one name, one step — shaped by a template. */
  createBoard: replanAfter('task_changed')
    .input(z.object({ name: z.string().trim().min(1).max(120), templateId: z.string().max(64).optional() }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId } = await ensureBoards(ctx.user.id);
      const structure = await resolveTemplate(workspaceId, input.templateId);
      return prisma.$transaction(async (tx) => {
        const project = await tx.project.create({ data: { userId: ctx.user.id, name: input.name } });
        const board = await createBoardInTx(tx, { workspaceId, name: input.name, projectId: project.id, defaultColumns: false });
        await applyTemplate(tx, {
          defaultEstimateMinutes: await defaultEstimate(ctx.user.id, tx),
          userId: ctx.user.id,
          workspaceId,
          boardId: board.id,
          projectId: project.id,
          areaId: project.areaId,
          structure,
        });
        await logActivity(tx, {
          workspaceId,
          boardId: board.id,
          actorId: ctx.user.id,
          verb: 'created',
          summary: `Created the board “${input.name}”`,
        });
        return { id: board.id };
      });
    }),

  saveTemplate: protectedProcedure
    .input(
      z.object({
        boardId: id,
        name: z.string().trim().min(1).max(80),
        description: z.string().trim().max(300).optional(),
        includeCards: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => saveBoardAsTemplate(ctx.user.id, input)),

  deleteTemplate: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { workspaceId } = await ensureBoards(ctx.user.id);
    await prisma.boardTemplate.deleteMany({ where: { id: input.id, workspaceId } });
  }),

  /** How much the board's project matters, 0–2. Ranks after priority, before deadlines. */
  setImportance: replanAfter('task_changed')
    .input(z.object({ boardId: id, importance: z.number().int().min(0).max(2) }))
    .mutation(async ({ ctx, input }) => {
      const board = await loadBoard(prisma, ctx.user.id, input.boardId);
      if (!board.projectId) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The inbox has no project to rank.' });
      await prisma.project.update({ where: { id: board.projectId }, data: { importance: input.importance } });
    }),

  renameBoard: protectedProcedure
    .input(z.object({ id, name: z.string().trim().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const board = await loadBoard(tx, ctx.user.id, input.id);
        await tx.board.update({ where: { id: board.id }, data: { name: input.name } });
        // The board and its project are one thing to the user; keep the names in step.
        if (board.projectId) await tx.project.update({ where: { id: board.projectId }, data: { name: input.name } });
      });
    }),

  /**
   * Archive a board: hidden from the list, its cards out of the scheduler
   * (the project is archived with it). Reversible.
   */
  setBoardArchived: replanAfter('task_changed')
    .input(z.object({ id, archived: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const board = await loadBoard(tx, ctx.user.id, input.id);
        if (board.isInbox) throw new TRPCError({ code: 'BAD_REQUEST', message: 'The Inbox cannot be archived.' });
        const now = new Date();
        await tx.board.update({ where: { id: board.id }, data: { archivedAt: input.archived ? now : null } });
        if (board.projectId) {
          await tx.project.update({
            where: { id: board.projectId },
            data: { status: input.archived ? 'ARCHIVED' : 'ACTIVE' },
          });
        }
        if (input.archived) {
          // Out of the plan: sessions nobody accepted yet go now; the next replan drops the rest.
          await tx.scheduledBlock.deleteMany({ where: { state: 'PROPOSED', task: { boardId: board.id } } });
        }
        await logActivity(tx, {
          workspaceId: board.workspaceId,
          boardId: board.id,
          actorId: ctx.user.id,
          verb: input.archived ? 'archived' : 'unarchived',
          summary: `${input.archived ? 'Archived' : 'Restored'} the board “${board.name}”`,
        });
      });
    }),

  // --- Columns --------------------------------------------------------------

  addColumn: protectedProcedure
    .input(z.object({ boardId: id, name: z.string().trim().min(1).max(80), category: category.optional() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const board = await loadBoard(tx, ctx.user.id, input.boardId);
        const columns = [...board.columns].sort((a, b) => comparePositions(a.position, b.position));
        // New columns go before Done, which is where nearly everyone wants them.
        const doneIndex = columns.findIndex((column) => column.category === 'DONE');
        const before = doneIndex >= 0 ? columns[doneIndex - 1] : columns.at(-1);
        const after = doneIndex >= 0 ? columns[doneIndex] : undefined;
        await tx.boardColumn.create({
          data: {
            boardId: board.id,
            name: input.name,
            category: input.category ?? null,
            position: positionBetween(before?.position ?? null, after?.position ?? null),
          },
        });
      });
    }),

  updateColumn: replanAfter('task_changed')
    .input(
      z.object({
        id,
        name: z.string().trim().min(1).max(80).optional(),
        category: category.optional(),
        wipLimit: z.number().int().min(1).max(999).nullable().optional(),
        /** Schedule cards in this column automatically: on, off, or null to follow the mode. */
        autoSchedule: z.boolean().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const column = await prisma.boardColumn.findUnique({ where: { id: input.id } });
      if (!column) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadBoard(prisma, ctx.user.id, column.boardId);
      await prisma.boardColumn.update({
        where: { id: column.id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.category !== undefined ? { category: input.category } : {}),
          ...(input.wipLimit !== undefined ? { wipLimit: input.wipLimit } : {}),
          ...(input.autoSchedule !== undefined ? { autoSchedule: input.autoSchedule } : {}),
        },
      });
    }),

  /** Shift a column one place left or right. */
  shiftColumn: protectedProcedure
    .input(z.object({ id, direction: z.enum(['left', 'right']) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const column = await tx.boardColumn.findUnique({ where: { id: input.id } });
        if (!column) throw new TRPCError({ code: 'NOT_FOUND' });
        const board = await loadBoard(tx, ctx.user.id, column.boardId);
        const columns = [...board.columns].sort((a, b) => comparePositions(a.position, b.position));
        const index = columns.findIndex((candidate) => candidate.id === column.id);
        const others = columns.filter((candidate) => candidate.id !== column.id);
        const target = input.direction === 'left' ? index - 1 : index + 1;
        if (target < 0 || target >= columns.length) return;
        const position = positionBetween(others[target - 1]?.position ?? null, others[target]?.position ?? null);
        await tx.boardColumn.update({ where: { id: column.id }, data: { position } });
      });
    }),

  /**
   * Delete a column. Its cards are never deleted with it: they move to the
   * column you name, which is the one question worth asking here.
   */
  deleteColumn: replanAfter('task_changed')
    .input(z.object({ id, moveCardsTo: id.optional() }))
    .mutation(async ({ ctx, input }) => {
      const column = await prisma.boardColumn.findUnique({
        where: { id: input.id },
        include: { tasks: { where: { parentId: null }, select: { id: true, position: true } } },
      });
      if (!column) throw new TRPCError({ code: 'NOT_FOUND' });
      const board = await loadBoard(prisma, ctx.user.id, column.boardId);
      if (board.columns.length <= 1) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'A board needs at least one column.' });
      }

      if (column.tasks.length > 0) {
        const destination = board.columns.find((candidate) => candidate.id === input.moveCardsTo);
        if (!destination || destination.id === column.id) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: 'Choose where this column’s cards should go.' });
        }
        const ordered = [...column.tasks].sort((a, b) => comparePositions(a.position, b.position));
        for (const task of ordered) {
          await moveCard(ctx.user.id, { taskId: task.id, columnId: destination.id }, lifecycle(ctx.user.id));
        }
      }

      await prisma.boardColumn.delete({ where: { id: column.id } });
    }),

  // --- Cards ----------------------------------------------------------------

  createCard: replanAfter('task_changed')
    .input(z.object({ columnId: id, title: z.string().trim().min(1).max(255) }))
    .mutation(async ({ ctx, input }) => {
      const column = await prisma.boardColumn.findUnique({
        where: { id: input.columnId },
        include: { board: { include: { project: { select: { areaId: true } } } } },
      });
      if (!column) throw new TRPCError({ code: 'NOT_FOUND' });
      await loadBoard(prisma, ctx.user.id, column.boardId);

      return prisma.$transaction(async (tx) => {
        const last = await tx.task.findMany({
          where: { columnId: column.id, parentId: null },
          select: { position: true },
        });
        const position = positionBetween(
          last.map((row) => row.position).sort(comparePositions).at(-1) ?? null,
          null,
        );
        const now = new Date();
        const status = column.category ? statusForCategory(column.category) : 'READY';

        const task = await tx.task.create({
          data: {
            userId: ctx.user.id,
            title: input.title,
            projectId: column.board.projectId,
            areaId: column.board.project?.areaId ?? null,
            boardId: column.boardId,
            columnId: column.id,
            position,
            status,
            ...(await estimateFields(ctx.user.id, undefined, tx)),
            ...(status === 'DONE' ? { completedAt: now } : {}),
          },
        });
        await logActivity(tx, {
          workspaceId: column.board.workspaceId,
          boardId: column.boardId,
          taskId: task.id,
          actorId: ctx.user.id,
          verb: 'created',
          summary: `Added “${task.title}” to ${column.name}`,
        });
        return { id: task.id };
      });
    }),

  moveCard: replanAfter('task_changed')
    .input(z.object({ taskId: id, columnId: id, beforeId: id.nullish(), afterId: id.nullish() }))
    .mutation(async ({ ctx, input }) => {
      await moveCard(ctx.user.id, input, lifecycle(ctx.user.id));
    }),

  /** Everything the card panel shows. */
  card: protectedProcedure.input(z.object({ id })).query(async ({ ctx, input }) => {
    const task = await prisma.task.findFirst({
      where: { id: input.id, userId: ctx.user.id },
      include: {
        board: { select: { id: true, name: true, workspaceId: true } },
        column: { select: { id: true, name: true, category: true } },
        project: { select: { id: true, name: true } },
        labels: { select: { label: true } },
        checklistItems: true,
        comments: { orderBy: { createdAt: 'asc' }, include: { author: { select: { id: true, email: true } } } },
        attachments: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, filename: true, contentType: true, sizeBytes: true, createdAt: true },
        },
        subtasks: { orderBy: { createdAt: 'asc' }, select: { id: true, title: true, status: true, estimateMinutes: true } },
        blockedBy: { select: { prerequisite: { select: { id: true, title: true, completedAt: true } } } },
        scheduledBlocks: {
          where: { state: { in: ['PROPOSED', 'ACCEPTED'] }, endsAt: { gt: new Date() } },
          orderBy: { startsAt: 'asc' },
          select: { id: true, startsAt: true, endsAt: true, state: true, isPinned: true, explanationText: true },
        },
      },
    });
    if (!task) return null;

    const activity = await prisma.activityEvent.findMany({
      where: { taskId: task.id },
      orderBy: { createdAt: 'desc' },
      take: 30,
      include: { actor: { select: { email: true } } },
    });

    return {
      ...task,
      labels: task.labels.map((entry) => entry.label),
      checklistItems: [...task.checklistItems].sort((a, b) => comparePositions(a.position, b.position)),
      activity,
    };
  }),

  updateCard: replanAfter('task_changed')
    .input(
      z.object({
        id,
        title: z.string().trim().min(1).max(255).optional(),
        notes: z.string().max(20_000).nullable().optional(),
        priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']).optional(),
        estimateMinutes: z.number().int().min(5).max(10_080).optional(),
        /**
         * A calendar date from a date picker. "Due Friday" means by the end of
         * Friday in the user's own zone — the start of Saturday there — which
         * is the same convention the braindump uses.
         */
        deadlineDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
        /**
         * The estimate shown is the right one, even if it is the default. The
         * card form sends every field on save, so sending an estimate alone
         * does not clear "assumed" — changing it, or this, does.
         */
        confirmEstimate: z.boolean().optional(),
        deadlineKind: z.enum(['SOFT', 'HARD']).optional(),
        preferredWindow: z.enum(['MORNING', 'AFTERNOON', 'EVENING']).nullable().optional(),
        /** On, off, or null to follow the column and the mode. */
        autoSchedule: z.boolean().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const task = await loadCard(tx, ctx.user.id, input.id);
        const { id: _id, deadlineDay, confirmEstimate, ...rest } = input;
        const timeZone = ctx.user.timeZone;
        const patch = {
          ...rest,
          ...(deadlineDay === undefined
            ? {}
            : {
                deadline: deadlineDay
                  ? startOfLocalDay(parseLocalDay(deadlineDay, timeZone), timeZone, 1)
                  : null,
              }),
        };
        const changed = Object.entries(patch)
          .filter(([key, value]) => {
            const before = task[key as keyof typeof task];
            const normalise = (v: unknown) => (v instanceof Date ? v.getTime() : v ?? null);
            return value !== undefined && normalise(value) !== normalise(before);
          })
          .map(([key]) => key);
        const settlesEstimate = task.estimateAssumed && (confirmEstimate || changed.includes('estimateMinutes'));
        if (changed.length === 0 && !settlesEstimate) return;

        await tx.task.update({
          where: { id: task.id },
          data: { ...patch, ...(settlesEstimate ? { estimateAssumed: false } : {}), lastTouchedAt: new Date() },
        });
        if (changed.length === 0) return;
        if (task.board) {
          const words: Record<string, string> = {
            title: 'title',
            notes: 'description',
            priority: 'priority',
            estimateMinutes: 'estimate',
            deadline: 'deadline',
            deadlineKind: 'deadline kind',
            preferredWindow: 'preferred time of day',
            autoSchedule: 'auto-scheduling',
            earliestStart: 'start date',
          };
          await logActivity(tx, {
            workspaceId: task.board.workspaceId,
            boardId: task.boardId,
            taskId: task.id,
            actorId: ctx.user.id,
            verb: 'edited',
            summary: `Changed the ${changed.map((key) => words[key] ?? key).join(', ')} of “${input.title ?? task.title}”`,
            detail: { fields: changed },
          });
        }
      });
    }),

  trashCard: replanAfter('task_changed').input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await trashCard(ctx.user.id, input.id);
  }),

  restoreCard: replanAfter('task_changed').input(z.object({ id })).mutation(async ({ ctx, input }) => {
    return restoreCard(ctx.user.id, input.id);
  }),

  // --- Labels ---------------------------------------------------------------

  createLabel: protectedProcedure
    .input(z.object({ name: z.string().trim().min(1).max(40), color: z.enum(LABEL_COLORS) }))
    .mutation(async ({ ctx, input }) => {
      const { workspaceId } = await ensureBoards(ctx.user.id);
      const existing = await prisma.label.findFirst({
        where: { workspaceId, name: { equals: input.name, mode: 'insensitive' } },
      });
      if (existing) return existing;
      return prisma.label.create({ data: { workspaceId, name: input.name, color: input.color } });
    }),

  deleteLabel: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const { workspaceId } = await ensureBoards(ctx.user.id);
    await prisma.label.deleteMany({ where: { id: input.id, workspaceId } });
  }),

  toggleLabel: protectedProcedure
    .input(z.object({ taskId: id, labelId: id }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const task = await loadCard(tx, ctx.user.id, input.taskId);
        const label = await tx.label.findFirst({
          where: { id: input.labelId, workspace: { members: { some: { userId: ctx.user.id } } } },
        });
        if (!label) throw new TRPCError({ code: 'NOT_FOUND' });

        const key = { taskId_labelId: { taskId: task.id, labelId: label.id } };
        const existing = await tx.taskLabel.findUnique({ where: key });
        if (existing) await tx.taskLabel.delete({ where: key });
        else await tx.taskLabel.create({ data: { taskId: task.id, labelId: label.id } });

        if (task.board) {
          await logActivity(tx, {
            workspaceId: task.board.workspaceId,
            boardId: task.boardId,
            taskId: task.id,
            actorId: ctx.user.id,
            verb: 'labelled',
            summary: `${existing ? 'Removed' : 'Added'} the label “${label.name}” ${existing ? 'from' : 'to'} “${task.title}”`,
          });
        }
      });
    }),

  // --- Checklist ------------------------------------------------------------

  addChecklistItem: protectedProcedure
    .input(z.object({ taskId: id, text: z.string().trim().min(1).max(500) }))
    .mutation(async ({ ctx, input }) => {
      const task = await loadCard(prisma, ctx.user.id, input.taskId);
      const items = await prisma.checklistItem.findMany({ where: { taskId: task.id }, select: { position: true } });
      const last = items.map((item) => item.position).sort(comparePositions).at(-1) ?? null;
      await prisma.checklistItem.create({
        data: { taskId: task.id, text: input.text, position: positionBetween(last, null) },
      });
    }),

  toggleChecklistItem: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const item = await prisma.checklistItem.findFirst({ where: { id: input.id, task: { userId: ctx.user.id } } });
    if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
    await prisma.checklistItem.update({
      where: { id: item.id },
      data: { checkedAt: item.checkedAt ? null : new Date() },
    });
  }),

  deleteChecklistItem: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await prisma.checklistItem.deleteMany({ where: { id: input.id, task: { userId: ctx.user.id } } });
  }),

  /** It turned out to be real work: make it a subtask with its own estimate. */
  promoteChecklistItem: replanAfter('task_changed').input(z.object({ id })).mutation(async ({ ctx, input }) => {
    await prisma.$transaction(async (tx) => {
      const item = await tx.checklistItem.findFirst({
        where: { id: input.id, task: { userId: ctx.user.id } },
        include: { task: true },
      });
      if (!item) throw new TRPCError({ code: 'NOT_FOUND' });
      await tx.task.create({
        data: {
          userId: ctx.user.id,
          parentId: item.taskId,
          title: item.text,
          projectId: item.task.projectId,
          areaId: item.task.areaId,
          // Small by nature, but nobody said how small: flag it.
          estimateMinutes: 15,
          estimateAssumed: true,
          status: item.checkedAt ? 'DONE' : 'READY',
          ...(item.checkedAt ? { completedAt: item.checkedAt } : {}),
        },
      });
      await tx.checklistItem.delete({ where: { id: item.id } });
    });
  }),

  // --- Comments -------------------------------------------------------------

  addComment: protectedProcedure
    .input(z.object({ taskId: id, body: z.string().trim().min(1).max(10_000) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.$transaction(async (tx) => {
        const task = await loadCard(tx, ctx.user.id, input.taskId);
        await tx.comment.create({ data: { taskId: task.id, authorId: ctx.user.id, body: input.body } });
        await tx.task.update({ where: { id: task.id }, data: { lastTouchedAt: new Date() } });
      });
    }),

  deleteComment: protectedProcedure.input(z.object({ id })).mutation(async ({ ctx, input }) => {
    const result = await prisma.comment.deleteMany({ where: { id: input.id, authorId: ctx.user.id } });
    if (result.count === 0) throw new TRPCError({ code: 'NOT_FOUND', message: 'Only the author can delete a comment.' });
  }),
});

/** Completion side effects for moves into and out of Done columns. */
function lifecycle(userId: string) {
  return {
    // The card is already in the column it was dropped into, so neither side
    // effect should move it again.
    complete: (tx: Prisma.TransactionClient, task: Task) =>
      completeTaskInTx(tx, userId, task, new Date(), { moveOnBoard: false }),
    reopen: (tx: Prisma.TransactionClient, task: Task, status: TaskStatus) =>
      uncompleteTaskInTx(tx, userId, task, new Date(), { status, moveOnBoard: false }),
  };
}
