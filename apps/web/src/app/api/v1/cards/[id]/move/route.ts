import { apiRoute, readJson } from '@/server/api/handler';
import { cardDetail, cardMove } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Move a card to a column, on this board or another, optionally next to a given card. */
export const POST = apiRoute<{ id: string }>('write', async ({ caller, params, request }) => {
  const body = cardMove.parse(await readJson(request));
  await cardDetail(caller, params.id);
  await caller.kanban.moveCard({ taskId: params.id, ...body });
  return cardDetail(caller, params.id);
});
