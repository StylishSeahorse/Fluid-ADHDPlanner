/**
 * Board templates: a board's shape — columns, labels, optionally starter
 * cards — to start new boards from.
 *
 * Built-in templates live here in code, so they arrive with upgrades; saved
 * templates are rows in `board_templates`, captured from a real board. Both
 * share one structure, validated on the way in and on the way out, because a
 * saved template is data that outlives the code that wrote it.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { prisma, type Prisma } from '@fluid/db';
import { comparePositions, positionBetween, spreadPositions, statusForCategory } from '@fluid/core';
import { LABEL_COLORS } from '../../components/label-colors';
import { BUILT_IN_TEMPLATES, templateStructure, type TemplateStructure } from './template-structure';

type Tx = Prisma.TransactionClient;

export { BUILT_IN_TEMPLATES, templateStructure, type TemplateStructure } from './template-structure';

/** `builtin:<key>` or a saved template's id. Unknown means Simple. */
export async function resolveTemplate(workspaceId: string, id: string | undefined): Promise<TemplateStructure> {
  if (!id || id.startsWith('builtin:')) {
    const key = id?.slice('builtin:'.length) ?? 'simple';
    return (BUILT_IN_TEMPLATES.find((template) => template.key === key) ?? BUILT_IN_TEMPLATES[0]!).structure;
  }
  const saved = await prisma.boardTemplate.findFirst({ where: { id, workspaceId } });
  if (!saved) throw new TRPCError({ code: 'NOT_FOUND', message: 'That template no longer exists.' });
  const parsed = templateStructure.safeParse(saved.structure);
  if (!parsed.success) throw new TRPCError({ code: 'BAD_REQUEST', message: 'That template is damaged and cannot be used.' });
  return parsed.data;
}

/** Lay a template's columns, labels and cards onto a freshly created, empty board. */
export async function applyTemplate(
  tx: Tx,
  input: {
    userId: string;
    workspaceId: string;
    boardId: string;
    projectId: string | null;
    areaId: string | null;
    structure: TemplateStructure;
    defaultEstimateMinutes: number;
  },
): Promise<void> {
  const { structure } = input;
  const positions = spreadPositions(structure.columns.length);
  const columns = [];
  for (const [index, column] of structure.columns.entries()) {
    columns.push(
      await tx.boardColumn.create({
        data: { boardId: input.boardId, name: column.name, category: column.category, wipLimit: column.wipLimit, position: positions[index]! },
      }),
    );
  }

  // Labels are workspace-wide: reuse one with the same name rather than duplicating it.
  const labelIds = new Map<string, string>();
  for (const label of structure.labels) {
    const existing = await tx.label.findFirst({ where: { workspaceId: input.workspaceId, name: { equals: label.name, mode: 'insensitive' } } });
    const row = existing ?? (await tx.label.create({ data: { workspaceId: input.workspaceId, name: label.name, color: label.color } }));
    labelIds.set(label.name.toLowerCase(), row.id);
  }

  const lastInColumn = new Map<string, string | null>();
  for (const card of structure.cards) {
    const column = columns[card.column] ?? columns[0]!;
    const position = positionBetween(lastInColumn.get(column.id) ?? null, null);
    lastInColumn.set(column.id, position);

    const status = column.category ? statusForCategory(column.category) : 'READY';
    const task = await tx.task.create({
      data: {
        userId: input.userId,
        title: card.title,
        projectId: input.projectId,
        areaId: input.areaId,
        boardId: input.boardId,
        columnId: column.id,
        position,
        status,
        ...(card.estimateMinutes
          ? { estimateMinutes: card.estimateMinutes }
          : { estimateMinutes: input.defaultEstimateMinutes, estimateAssumed: true }),
        ...(status === 'DONE' ? { completedAt: new Date() } : {}),
      },
    });
    const ids = card.labels.map((name) => labelIds.get(name.toLowerCase())).filter((value): value is string => Boolean(value));
    if (ids.length > 0) await tx.taskLabel.createMany({ data: ids.map((labelId) => ({ taskId: task.id, labelId })) });
    const itemPositions = spreadPositions(card.checklist.length);
    if (card.checklist.length > 0) {
      await tx.checklistItem.createMany({
        data: card.checklist.map((text, index) => ({ taskId: task.id, text, position: itemPositions[index]! })),
      });
    }
  }
}

/** Capture a board's shape as a template, optionally with its open cards. */
export async function saveBoardAsTemplate(
  userId: string,
  input: { boardId: string; name: string; description?: string; includeCards: boolean },
): Promise<{ id: string }> {
  const board = await prisma.board.findFirst({
    where: { id: input.boardId, workspace: { members: { some: { userId } } } },
    include: {
      columns: true,
      tasks: {
        where: { parentId: null, completedAt: null },
        include: { labels: { include: { label: true } }, checklistItems: true },
        take: 200,
      },
    },
  });
  if (!board) throw new TRPCError({ code: 'NOT_FOUND', message: 'That board no longer exists.' });

  const columns = [...board.columns].sort((a, b) => comparePositions(a.position, b.position));
  const usedLabels = new Map<string, { name: string; color: string }>();
  for (const task of board.tasks) for (const { label } of task.labels) usedLabels.set(label.id, { name: label.name, color: label.color });

  const structure = templateStructure.parse({
    columns: columns.map((column) => ({ name: column.name, category: column.category, wipLimit: column.wipLimit })),
    labels: [...usedLabels.values()].filter((label) => (LABEL_COLORS as readonly string[]).includes(label.color)),
    cards: input.includeCards
      ? [...board.tasks]
          .sort((a, b) => comparePositions(a.position, b.position))
          .map((task) => ({
            title: task.title,
            column: Math.max(0, columns.findIndex((column) => column.id === task.columnId)),
            labels: task.labels.map(({ label }) => label.name),
            checklist: [...task.checklistItems].sort((a, b) => comparePositions(a.position, b.position)).map((item) => item.text),
            ...(task.estimateAssumed ? {} : { estimateMinutes: task.estimateMinutes }),
          }))
      : [],
  });

  const template = await prisma.boardTemplate.upsert({
    where: { workspaceId_name: { workspaceId: board.workspaceId, name: input.name } },
    create: { workspaceId: board.workspaceId, name: input.name, description: input.description ?? null, structure },
    update: { description: input.description ?? null, structure },
  });
  return { id: template.id };
}
