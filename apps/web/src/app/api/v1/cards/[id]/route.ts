import { apiRoute, readJson } from '@/server/api/handler';
import { cardDetail, cardPatch, toUpdateInput } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** One card with its checklist, comments, attachments and subtasks. */
export const GET = apiRoute<{ id: string }>('read', async ({ caller, params }) => cardDetail(caller, params.id));

/** Change a card's title, notes, priority, estimate or deadline. */
export const PATCH = apiRoute<{ id: string }>('write', async ({ caller, params, request }) => {
  const patch = cardPatch.parse(await readJson(request));
  await cardDetail(caller, params.id);
  if (Object.keys(patch).length > 0) await caller.kanban.updateCard(toUpdateInput(params.id, patch));
  return cardDetail(caller, params.id);
});

/** Move a card to its board's Recently deleted, where it can be restored for 30 days. */
export const DELETE = apiRoute<{ id: string }>('write', async ({ caller, params }) => {
  await cardDetail(caller, params.id);
  await caller.kanban.trashCard({ id: params.id });
});
