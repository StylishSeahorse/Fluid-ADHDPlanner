/**
 * The API's card shapes, and the request bodies it accepts for them.
 *
 * The API returns its own shapes rather than whatever a procedure happens to
 * return, so an internal refactor does not quietly break someone's script.
 */
import 'server-only';
import { z } from 'zod';
import type { ApiCaller } from './handler';
import { ApiProblem } from './handler';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a YYYY-MM-DD date.');

export const cardPatch = z
  .object({
    title: z.string().trim().min(1).max(255),
    notes: z.string().max(20_000).nullable(),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'URGENT']),
    estimateMinutes: z.number().int().min(5).max(10_080),
    /** The day it is due by, in the owner's time zone. */
    deadline: day.nullable(),
  })
  .partial()
  .strict();

export const cardCreate = cardPatch.extend({ columnId: z.string().min(1).max(64), title: z.string().trim().min(1).max(255) }).strict();

export const cardMove = z
  .object({
    columnId: z.string().min(1).max(64),
    /** Put it directly below this card. */
    afterId: z.string().min(1).max(64).nullish(),
    /** Put it directly above this card. */
    beforeId: z.string().min(1).max(64).nullish(),
  })
  .strict();

export const cardPlan = z.object({ day: day.nullable() }).strict();
export const commentCreate = z.object({ body: z.string().trim().min(1).max(10_000) }).strict();
export const checklistCreate = z.object({ text: z.string().trim().min(1).max(500) }).strict();

/** A patch as `kanban.updateCard` takes it. */
export function toUpdateInput(id: string, patch: z.infer<typeof cardPatch>) {
  const { deadline, ...rest } = patch;
  return {
    id,
    ...rest,
    ...(rest.estimateMinutes !== undefined ? { confirmEstimate: true } : {}),
    ...(deadline === undefined ? {} : { deadlineDay: deadline }),
  };
}

interface CardSummaryInput {
  id: string;
  title: string;
  status: string;
  priority: string;
  estimateMinutes: number;
  estimateAssumed: boolean;
  deadline: Date | null;
  plannedFor: Date | null;
  completedAt: Date | null;
  columnId: string | null;
  labels: Array<{ id: string; name: string; color: string }>;
  checklist: { done: number; total: number };
  commentCount: number;
  attachmentCount: number;
  subtaskCount: number;
  blocked: boolean;
  board?: { id: string; name: string } | null;
  column?: { name: string } | null;
}

export function cardSummary(card: CardSummaryInput, boardId?: string) {
  return {
    id: card.id,
    title: card.title,
    status: card.status,
    priority: card.priority,
    estimateMinutes: card.estimateMinutes,
    estimateAssumed: card.estimateAssumed,
    deadline: card.deadline,
    plannedFor: card.plannedFor,
    completedAt: card.completedAt,
    boardId: card.board?.id ?? boardId ?? null,
    columnId: card.columnId,
    ...(card.board ? { boardName: card.board.name } : {}),
    ...(card.column ? { columnName: card.column.name } : {}),
    labels: card.labels.map(({ id, name, color }) => ({ id, name, color })),
    checklist: card.checklist,
    commentCount: card.commentCount,
    attachmentCount: card.attachmentCount,
    subtaskCount: card.subtaskCount,
    blocked: card.blocked,
  };
}

/** One card in full, or a 404. */
export async function cardDetail(caller: ApiCaller, id: string) {
  const card = await caller.kanban.card({ id });
  if (!card) throw new ApiProblem(404, 'Not found', 'No card with that id.');
  return {
    id: card.id,
    title: card.title,
    notes: card.notes,
    status: card.status,
    priority: card.priority,
    estimateMinutes: card.estimateMinutes,
    estimateAssumed: card.estimateAssumed,
    deadline: card.deadline,
    plannedFor: card.plannedFor,
    completedAt: card.completedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    board: card.board ? { id: card.board.id, name: card.board.name } : null,
    column: card.column,
    project: card.project,
    labels: card.labels.map(({ id: labelId, name, color }) => ({ id: labelId, name, color })),
    checklist: card.checklistItems.map((item) => ({ id: item.id, text: item.text, checkedAt: item.checkedAt })),
    comments: card.comments.map((comment) => ({
      id: comment.id,
      body: comment.body,
      createdAt: comment.createdAt,
      editedAt: comment.editedAt,
      author: comment.author ? { id: comment.author.id, email: comment.author.email } : null,
    })),
    attachments: card.attachments.map((file) => ({ ...file, url: `/api/attachments/${file.id}` })),
    subtasks: card.subtasks,
    blockedBy: card.blockedBy.map(({ prerequisite }) => prerequisite),
  };
}
