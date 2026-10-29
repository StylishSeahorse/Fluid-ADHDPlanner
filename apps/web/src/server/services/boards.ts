/**
 * Boards: the permanent home of every piece of work.
 *
 * The rules that make a board trustworthy live here, in one place, so every
 * route that touches a card — the board itself, My Day, the Tasks page,
 * search — inherits them:
 *
 *   1. ONE ROW PER CARD. A card is a `tasks` row with a board, a column and a
 *      position. Nothing is copied into a separate "card" table, so a title
 *      edited on the board is the title on Today.
 *   2. COMPLETION IS NOT A COLUMN. A task is done when `completedAt` is set.
 *      Dropping a card into a Done column completes it; completing it anywhere
 *      else moves it to Done. Either way it is the same transaction.
 *   3. A COLUMN'S CATEGORY DRIVES STATUS. Backlog / To do / Doing / Done map
 *      onto the `TaskStatus` the scheduler already reads, so a card moved to
 *      "Doing" is scheduled and a card moved to "Backlog" is not — without the
 *      scheduler knowing boards exist.
 *   4. EVERY CHANGE IS LOGGED in `activity_events`, in words, by whoever did it.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { prisma, type Prisma, type ColumnCategory, type TaskStatus } from '@fluid/db';
import {
  categoryForStatus,
  comparePositions,
  DEFAULT_COLUMNS,
  needsRebalance,
  parseCardQuery,
  parseLocalDay,
  positionBetween,
  PRIORITY_ORDER,
  spreadPositions,
  startOfLocalDay,
  statusForCategory,
  type CardQuery,
  type Comparison,
} from '@fluid/core';

type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

export async function logActivity(
  tx: Tx,
  entry: {
    workspaceId: string;
    boardId?: string | null;
    taskId?: string | null;
    actorId?: string | null;
    source?: 'USER' | 'ENGINE' | 'AUTOMATION' | 'AI' | 'SYNC';
    verb: string;
    summary: string;
    detail?: Prisma.InputJsonValue;
  },
): Promise<void> {
  await tx.activityEvent.create({
    data: {
      workspaceId: entry.workspaceId,
      boardId: entry.boardId ?? null,
      taskId: entry.taskId ?? null,
      actorId: entry.actorId ?? null,
      source: entry.source ?? 'USER',
      verb: entry.verb,
      summary: entry.summary,
      ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    },
  });
}

// ---------------------------------------------------------------------------
// Workspace and board setup
// ---------------------------------------------------------------------------

async function lockUser(tx: Tx, userId: string): Promise<void> {
  // Serialises board setup per user: two tabs opening the app at once must not
  // both create an Inbox.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'boards:' + userId}))`;
}

async function personalWorkspaceInTx(tx: Tx, userId: string): Promise<string> {
  const membership = await tx.workspaceMember.findFirst({
    where: { userId, role: 'OWNER', workspace: { isPersonal: true } },
    select: { workspaceId: true },
  });
  if (membership) return membership.workspaceId;

  const workspace = await tx.workspace.create({
    data: {
      name: 'My workspace',
      isPersonal: true,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  return workspace.id;
}

async function lastBoardPosition(tx: Tx, workspaceId: string): Promise<string | null> {
  const boards = await tx.board.findMany({ where: { workspaceId }, select: { position: true } });
  return boards.map((board) => board.position).sort(comparePositions).at(-1) ?? null;
}

export async function createBoardInTx(
  tx: Tx,
  input: { workspaceId: string; name: string; projectId?: string | null; isInbox?: boolean },
) {
  const positions = spreadPositions(DEFAULT_COLUMNS.length);
  return tx.board.create({
    data: {
      workspaceId: input.workspaceId,
      name: input.name,
      projectId: input.projectId ?? null,
      isInbox: input.isInbox ?? false,
      position: positionBetween(await lastBoardPosition(tx, input.workspaceId), null),
      columns: {
        create: DEFAULT_COLUMNS.map((column, index) => ({
          name: column.name,
          category: column.category,
          position: positions[index]!,
        })),
      },
    },
    include: { columns: true },
  });
}

/**
 * Make sure this user has a personal workspace, an Inbox board, a board for
 * every project, and that every top-level task sits on one of them.
 *
 * Idempotent and cheap when there is nothing to do — it runs whenever a board
 * screen loads and after tasks are created elsewhere, which is how work
 * captured on Today or in a braindump appears on a board without every
 * creation path having to know about boards.
 */
export async function ensureBoards(userId: string): Promise<{ workspaceId: string; inboxBoardId: string }> {
  const [membership, unplaced, unboardedProjects] = await Promise.all([
    prisma.workspaceMember.findFirst({
      where: { userId, role: 'OWNER', workspace: { isPersonal: true } },
      select: { workspaceId: true },
    }),
    prisma.task.count({
      where: { userId, boardId: null, parentId: null, status: { not: 'CANCELLED' } },
    }),
    prisma.project.count({ where: { userId, status: { not: 'ARCHIVED' }, board: null } }),
  ]);

  if (membership && unplaced === 0 && unboardedProjects === 0) {
    const inbox = await prisma.board.findFirst({
      where: { workspaceId: membership.workspaceId, isInbox: true },
      select: { id: true },
    });
    if (inbox) return { workspaceId: membership.workspaceId, inboxBoardId: inbox.id };
  }

  return prisma.$transaction(
    async (tx) => {
      await lockUser(tx, userId);
      const workspaceId = await personalWorkspaceInTx(tx, userId);

      let inbox = await tx.board.findFirst({ where: { workspaceId, isInbox: true } });
      inbox ??= await createBoardInTx(tx, { workspaceId, name: 'Inbox', isInbox: true });

      const projects = await tx.project.findMany({
        where: { userId, status: { not: 'ARCHIVED' }, board: null },
        orderBy: { createdAt: 'asc' },
      });
      for (const project of projects) {
        await createBoardInTx(tx, { workspaceId, name: project.name, projectId: project.id });
      }

      const tasks = await tx.task.findMany({
        where: { userId, boardId: null, parentId: null, status: { not: 'CANCELLED' } },
        orderBy: [{ dayOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, projectId: true, status: true, title: true },
      });

      if (tasks.length > 0) {
        const boards = await tx.board.findMany({
          where: { workspaceId },
          include: { columns: true },
        });
        const boardFor = (projectId: string | null) =>
          boards.find((board) => projectId && board.projectId === projectId) ??
          boards.find((board) => board.isInbox)!;

        // Group by destination column, then append each group in one go.
        const byColumn = new Map<string, { boardId: string; ids: string[] }>();
        for (const task of tasks) {
          const board = boardFor(task.projectId);
          const category = categoryForStatus(task.status);
          const column =
            board.columns.find((candidate) => candidate.category === category) ??
            [...board.columns].sort((a, b) => comparePositions(a.position, b.position))[0]!;
          const entry = byColumn.get(column.id) ?? { boardId: board.id, ids: [] };
          entry.ids.push(task.id);
          byColumn.set(column.id, entry);
        }

        for (const [columnId, { boardId, ids }] of byColumn) {
          let last = await lastPositionInColumn(tx, columnId);
          for (const id of ids) {
            last = positionBetween(last, null);
            await tx.task.update({ where: { id }, data: { boardId, columnId, position: last } });
          }
          await rebalanceIfNeeded(tx, columnId);
        }
      }

      return { workspaceId, inboxBoardId: inbox.id };
    },
    { timeout: 30_000 },
  );
}

/** The personal workspace id, setting everything up first if needed. */
export async function workspaceFor(userId: string): Promise<string> {
  return (await ensureBoards(userId)).workspaceId;
}

// ---------------------------------------------------------------------------
// Positions
// ---------------------------------------------------------------------------

async function columnPositions(tx: Tx, columnId: string) {
  const rows = await tx.task.findMany({
    where: { columnId, parentId: null },
    select: { id: true, position: true },
  });
  return rows.sort((a, b) => comparePositions(a.position, b.position));
}

async function lastPositionInColumn(tx: Tx, columnId: string): Promise<string | null> {
  return (await columnPositions(tx, columnId)).at(-1)?.position ?? null;
}

async function rebalanceIfNeeded(tx: Tx, columnId: string): Promise<void> {
  const rows = await columnPositions(tx, columnId);
  if (!needsRebalance(rows.map((row) => row.position))) return;
  const fresh = spreadPositions(rows.length);
  for (const [index, row] of rows.entries()) {
    await tx.task.update({ where: { id: row.id }, data: { position: fresh[index]! } });
  }
}

/**
 * A key for a card dropped between two neighbours. The client names the
 * neighbours it saw; if they have moved since (another tab, another person),
 * the card goes to the end of the column instead of failing the drop.
 */
async function positionForDrop(
  tx: Tx,
  columnId: string,
  movingId: string,
  beforeId: string | null | undefined,
  afterId: string | null | undefined,
): Promise<string> {
  const rows = (await columnPositions(tx, columnId)).filter((row) => row.id !== movingId);
  const indexOf = (id: string | null | undefined) => (id ? rows.findIndex((row) => row.id === id) : -1);

  const afterIndex = indexOf(afterId); // the card that should end up above
  const beforeIndex = indexOf(beforeId); // the card that should end up below

  if (beforeId && beforeIndex >= 0 && (!afterId || afterIndex === beforeIndex - 1)) {
    return positionBetween(rows[beforeIndex - 1]?.position ?? null, rows[beforeIndex]!.position);
  }
  if (afterId && afterIndex >= 0) {
    return positionBetween(rows[afterIndex]!.position, rows[afterIndex + 1]?.position ?? null);
  }
  // No neighbours given, or they have moved: the end of the column.
  return positionBetween(rows.at(-1)?.position ?? null, null);
}

// ---------------------------------------------------------------------------
// Moving cards
// ---------------------------------------------------------------------------

/**
 * Move a card to the first column of `category` on its own board — but only
 * when it currently sits in one of the `from` categories (any column at all if
 * `from` is omitted), and never when it is already in that category.
 *
 * This is how completion elsewhere stays visible on the board: finishing from
 * Today slides the card into Done; reopening it slides it out of Done; and
 * committing a backlog card to a day lifts it out of Backlog. A card in a
 * custom "Waiting on client" column is left where the user put it.
 */
export async function moveToCategoryColumn(
  tx: Tx,
  taskId: string,
  category: ColumnCategory,
  from?: ColumnCategory[],
): Promise<void> {
  const task = await tx.task.findUnique({
    where: { id: taskId },
    select: { boardId: true, columnId: true, column: { select: { category: true } } },
  });
  if (!task?.boardId) return;

  const current = task.column?.category ?? null;
  if (current === category) return;
  if (from && (current === null || !from.includes(current))) return;

  const columns = await tx.boardColumn.findMany({ where: { boardId: task.boardId } });
  const target = columns
    .filter((column) => column.category === category)
    .sort((a, b) => comparePositions(a.position, b.position))[0];
  if (!target || target.id === task.columnId) return;

  // Done cards go to the top — the most recent finish is the one you look for.
  const rows = await columnPositions(tx, target.id);
  const position =
    category === 'DONE'
      ? positionBetween(null, rows[0]?.position ?? null)
      : positionBetween(rows.at(-1)?.position ?? null, null);

  await tx.task.update({ where: { id: taskId }, data: { columnId: target.id, position } });
}

/** Load a card the user may edit, with the context moves need. */
export async function loadCard(tx: Tx, userId: string, taskId: string) {
  const task = await tx.task.findFirst({
    where: { id: taskId, userId },
    include: {
      board: { select: { id: true, name: true, workspaceId: true, projectId: true } },
      column: { select: { id: true, name: true, category: true } },
    },
  });
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'That card no longer exists.' });
  return task;
}

/** Load a board the user may edit (a member of its workspace). */
export async function loadBoard(tx: Tx, userId: string, boardId: string) {
  const board = await tx.board.findFirst({
    where: { id: boardId, workspace: { members: { some: { userId } } } },
    include: { columns: true },
  });
  if (!board) throw new TRPCError({ code: 'NOT_FOUND', message: 'That board no longer exists.' });
  return board;
}

export async function moveCard(
  userId: string,
  input: { taskId: string; columnId: string; beforeId?: string | null; afterId?: string | null },
  completion: {
    complete: (tx: Tx, task: Prisma.TaskGetPayload<object>) => Promise<void>;
    reopen: (tx: Tx, task: Prisma.TaskGetPayload<object>, status: TaskStatus) => Promise<void>;
  },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await loadCard(tx, userId, input.taskId);
    const column = await tx.boardColumn.findUnique({
      where: { id: input.columnId },
      include: { board: { select: { id: true, name: true, workspaceId: true, projectId: true } } },
    });
    if (!column) throw new TRPCError({ code: 'NOT_FOUND', message: 'That column no longer exists.' });
    await loadBoard(tx, userId, column.boardId); // membership check

    const position = await positionForDrop(tx, column.id, task.id, input.beforeId, input.afterId);
    const changedBoard = task.boardId !== column.boardId;

    await tx.task.update({
      where: { id: task.id },
      data: {
        boardId: column.boardId,
        columnId: column.id,
        position,
        lastTouchedAt: new Date(),
        // A card moved onto another project's board joins that project. The
        // area is the task's own and does not follow (see architecture §9).
        ...(changedBoard && column.board.projectId ? { projectId: column.board.projectId } : {}),
        ...(changedBoard && !column.board.projectId ? { projectId: null } : {}),
      },
    });

    // Rule 2 and 3: the column's category decides status, and Done means done.
    const wasDone = task.status === 'DONE';
    if (column.category === 'DONE' && !wasDone) {
      await completion.complete(tx, task);
    } else if (column.category && column.category !== 'DONE') {
      const status = statusForCategory(column.category);
      if (wasDone) await completion.reopen(tx, task, status);
      else if (task.status !== status) {
        // Parked in the backlog means "not now": it comes off the day it was
        // planned for too, or it would sit on Today while the scheduler — which
        // ignores backlog work — never gave it a time.
        await tx.task.update({
          where: { id: task.id },
          data: { status, ...(status === 'BACKLOG' ? { plannedFor: null } : {}) },
        });
        if (status === 'BACKLOG') {
          await tx.scheduledBlock.deleteMany({ where: { taskId: task.id, state: 'PROPOSED' } });
        }
      }
    }

    await rebalanceIfNeeded(tx, column.id);

    if (task.columnId !== column.id) {
      await logActivity(tx, {
        workspaceId: column.board.workspaceId,
        boardId: column.boardId,
        taskId: task.id,
        actorId: userId,
        verb: 'moved',
        summary: changedBoard
          ? `Moved “${task.title}” to ${column.board.name} › ${column.name}`
          : `Moved “${task.title}” from ${task.column?.name ?? 'nowhere'} to ${column.name}`,
        detail: { fromColumnId: task.columnId, toColumnId: column.id, fromBoardId: task.boardId },
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Trash
// ---------------------------------------------------------------------------

export const TRASH_RETENTION_DAYS = 30;

/**
 * Delete a card, keeping a full snapshot for 30 days. Subtasks, checklist,
 * comments and labels go with it and come back with it.
 */
export async function trashCard(userId: string, taskId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const task = await loadCard(tx, userId, taskId);
    if (!task.board) throw new TRPCError({ code: 'BAD_REQUEST', message: 'Only cards on a board can be trashed.' });

    const [subtasks, checklist, comments, labels] = await Promise.all([
      tx.task.findMany({ where: { parentId: task.id } }),
      tx.checklistItem.findMany({ where: { taskId: task.id } }),
      tx.comment.findMany({ where: { taskId: task.id } }),
      tx.taskLabel.findMany({ where: { taskId: task.id } }),
    ]);

    const { board: _board, column: _column, ...row } = task;
    await tx.trashedCard.create({
      data: {
        workspaceId: task.board.workspaceId,
        boardId: task.boardId,
        taskId: task.id,
        title: task.title,
        trashedById: userId,
        snapshot: JSON.parse(
          JSON.stringify({ task: row, subtasks, checklist, comments, labelIds: labels.map((l) => l.labelId) }),
        ) as Prisma.InputJsonValue,
      },
    });

    await tx.task.delete({ where: { id: task.id } });

    await logActivity(tx, {
      workspaceId: task.board.workspaceId,
      boardId: task.boardId,
      taskId: task.id,
      actorId: userId,
      verb: 'deleted',
      summary: `Deleted “${task.title}” — it can be restored for ${TRASH_RETENTION_DAYS} days`,
    });
  });
}

type Snapshot = {
  task: Record<string, unknown>;
  subtasks: Array<Record<string, unknown>>;
  checklist: Array<Record<string, unknown>>;
  comments: Array<Record<string, unknown>>;
  labelIds: string[];
};

/** JSON turned every Date into a string; turn the date fields back. */
function revive<T extends Record<string, unknown>>(row: T): T {
  const out: Record<string, unknown> = { ...row };
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
      out[key] = new Date(value);
    }
  }
  return out as T;
}

export async function restoreCard(userId: string, trashedId: string): Promise<{ taskId: string; boardId: string }> {
  return prisma.$transaction(async (tx) => {
    const entry = await tx.trashedCard.findFirst({
      where: { id: trashedId, workspace: { members: { some: { userId } } } },
    });
    if (!entry) throw new TRPCError({ code: 'NOT_FOUND', message: 'That card is no longer in the trash.' });

    const snapshot = entry.snapshot as unknown as Snapshot;
    const task = revive(snapshot.task) as unknown as Prisma.TaskUncheckedCreateInput;

    // Back where it was if that column still exists, else the board's To do.
    const board =
      (entry.boardId && (await tx.board.findUnique({ where: { id: entry.boardId }, include: { columns: true } }))) ||
      (await tx.board.findFirst({ where: { workspaceId: entry.workspaceId, isInbox: true }, include: { columns: true } }));
    if (!board) throw new TRPCError({ code: 'NOT_FOUND', message: 'There is no board to restore it to.' });

    const originalColumn = board.columns.find((column) => column.id === task.columnId);
    const column =
      originalColumn ??
      board.columns.find((candidate) => candidate.category === categoryForStatus(task.status ?? 'READY')) ??
      [...board.columns].sort((a, b) => comparePositions(a.position, b.position))[0]!;

    const position = originalColumn && task.position ? task.position : positionBetween(await lastPositionInColumn(tx, column.id), null);
    // A sibling may have taken the exact key while it was away.
    const clash = await tx.task.findFirst({ where: { columnId: column.id, position } });

    await tx.task.create({
      data: {
        ...task,
        // Relations that may have gone while it was in the trash.
        objectiveId: task.objectiveId && (await tx.objective.findUnique({ where: { id: task.objectiveId } })) ? task.objectiveId : null,
        areaId: task.areaId && (await tx.area.findUnique({ where: { id: task.areaId } })) ? task.areaId : null,
        projectId: board.projectId ?? (task.projectId && (await tx.project.findUnique({ where: { id: task.projectId } })) ? task.projectId : null),
        boardId: board.id,
        columnId: column.id,
        position: clash ? positionBetween(await lastPositionInColumn(tx, column.id), null) : position,
      },
    });

    for (const subtask of snapshot.subtasks) {
      const row = revive(subtask) as unknown as Prisma.TaskUncheckedCreateInput;
      await tx.task.create({ data: { ...row, objectiveId: null, boardId: null, columnId: null } });
    }
    if (snapshot.checklist.length > 0) {
      await tx.checklistItem.createMany({
        data: snapshot.checklist.map((item) => revive(item) as unknown as Prisma.ChecklistItemCreateManyInput),
      });
    }
    for (const comment of snapshot.comments) {
      const row = revive(comment) as unknown as Prisma.CommentUncheckedCreateInput;
      const authorExists = row.authorId ? await tx.user.findUnique({ where: { id: row.authorId } }) : null;
      await tx.comment.create({ data: { ...row, authorId: authorExists ? row.authorId : null } });
    }
    const labels = await tx.label.findMany({ where: { id: { in: snapshot.labelIds }, workspaceId: entry.workspaceId } });
    if (labels.length > 0) {
      await tx.taskLabel.createMany({ data: labels.map((label) => ({ taskId: entry.taskId, labelId: label.id })) });
    }

    await tx.trashedCard.delete({ where: { id: entry.id } });
    await logActivity(tx, {
      workspaceId: entry.workspaceId,
      boardId: board.id,
      taskId: entry.taskId,
      actorId: userId,
      verb: 'restored',
      summary: `Restored “${entry.title}” to ${board.name} › ${column.name}`,
    });

    return { taskId: entry.taskId, boardId: board.id };
  });
}

/** Forget trash older than the retention window. Called lazily on read. */
export async function purgeOldTrash(workspaceId: string): Promise<void> {
  const cutoff = new Date(Date.now() - TRASH_RETENTION_DAYS * 24 * 60 * 60_000);
  await prisma.trashedCard.deleteMany({ where: { workspaceId, trashedAt: { lt: cutoff } } });
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function compareDate(op: Comparison, start: Date, end: Date): Prisma.DateTimeNullableFilter {
  switch (op) {
    case '<':
      return { lt: start };
    case '<=':
      return { lt: end };
    case '>':
      return { gte: end };
    case '>=':
      return { gte: start };
    case '=':
      return { gte: start, lt: end };
  }
}

function compareNumber(op: Comparison, value: number): Prisma.IntFilter {
  switch (op) {
    case '<':
      return { lt: value };
    case '<=':
      return { lte: value };
    case '>':
      return { gt: value };
    case '>=':
      return { gte: value };
    case '=':
      return { equals: value };
  }
}

function priorities(op: Comparison, value: (typeof PRIORITY_ORDER)[number]) {
  const index = PRIORITY_ORDER.indexOf(value);
  return PRIORITY_ORDER.filter((_, candidate) =>
    op === '<' ? candidate < index : op === '<=' ? candidate <= index : op === '>' ? candidate > index : op === '>=' ? candidate >= index : candidate === index,
  );
}

/**
 * Turn a parsed query into a Prisma filter over cards. Relative dates
 * ("today", "this week") are resolved in the user's own time zone.
 */
export function cardWhere(query: CardQuery, userId: string, timeZone: string, now = new Date()): Prisma.TaskWhereInput {
  const and: Prisma.TaskWhereInput[] = [{ userId, parentId: null, boardId: { not: null } }];
  const today = startOfLocalDay(now, timeZone);
  const day = (offset: number) => startOfLocalDay(now, timeZone, offset);

  for (const term of query.text) {
    and.push({ OR: [{ title: { contains: term, mode: 'insensitive' } }, { notes: { contains: term, mode: 'insensitive' } }] });
  }
  for (const term of query.excludeText) {
    and.push({ NOT: { OR: [{ title: { contains: term, mode: 'insensitive' } }, { notes: { contains: term, mode: 'insensitive' } }] } });
  }
  for (const name of query.labels) {
    and.push({ labels: { some: { label: { name: { equals: name, mode: 'insensitive' } } } } });
  }
  for (const name of query.excludeLabels) {
    and.push({ labels: { none: { label: { name: { equals: name, mode: 'insensitive' } } } } });
  }
  if (query.columns.length > 0) {
    and.push({ OR: query.columns.map((name) => ({ column: { name: { contains: name, mode: 'insensitive' as const } } })) });
  }
  if (query.boards.length > 0) {
    and.push({ OR: query.boards.map((name) => ({ board: { name: { contains: name, mode: 'insensitive' as const } } })) });
  }
  if (query.projects.length > 0) {
    and.push({ OR: query.projects.map((name) => ({ project: { name: { contains: name, mode: 'insensitive' as const } } })) });
  }
  if (query.status.length > 0) {
    and.push({ OR: query.status.map((category) => ({ status: statusForCategory(category) })) });
  }
  for (const category of query.excludeStatus) {
    and.push({ NOT: { status: statusForCategory(category) } });
  }
  if (query.priority) {
    and.push({ priority: { in: priorities(query.priority.op, query.priority.value) } });
  }

  if (query.due) {
    const due = query.due;
    switch (due.kind) {
      case 'overdue':
        and.push({ deadline: { lt: now }, completedAt: null });
        break;
      case 'today':
        and.push({ deadline: { gte: today, lt: day(1) } });
        break;
      case 'tomorrow':
        and.push({ deadline: { gte: day(1), lt: day(2) } });
        break;
      case 'week':
        and.push({ deadline: { gte: today, lt: day(7) } });
        break;
      case 'month':
        and.push({ deadline: { gte: today, lt: day(31) } });
        break;
      case 'none':
        and.push({ deadline: null });
        break;
      case 'any':
        and.push({ deadline: { not: null } });
        break;
      case 'compare': {
        const start = parseLocalDay(due.date, timeZone);
        and.push({ deadline: compareDate(due.op, start, startOfLocalDay(start, timeZone, 1)) });
        break;
      }
    }
  }

  if (query.planned) {
    switch (query.planned.kind) {
      case 'today':
        and.push({ plannedFor: today });
        break;
      case 'tomorrow':
        and.push({ plannedFor: day(1) });
        break;
      case 'week':
        and.push({ plannedFor: { gte: today, lt: day(7) } });
        break;
      case 'none':
        and.push({ plannedFor: null });
        break;
      case 'any':
        and.push({ plannedFor: { not: null } });
        break;
    }
  }

  if (query.estimate?.kind === 'compare') {
    and.push({ estimateMinutes: compareNumber(query.estimate.op, query.estimate.minutes) });
  }

  if (query.blocked !== null) {
    const blocked: Prisma.TaskWhereInput = { blockedBy: { some: { prerequisite: { completedAt: null } } } };
    and.push(query.blocked ? blocked : { NOT: blocked });
  }

  return { AND: and };
}

export function parseAndBuild(text: string, userId: string, timeZone: string): Prisma.TaskWhereInput {
  return cardWhere(parseCardQuery(text), userId, timeZone);
}

// Re-exported so routers keep one import site for board rules.
export { statusForCategory, categoryForStatus };
