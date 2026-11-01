import { apiRoute, readJson } from '@/server/api/handler';
import { cardDetail, cardPlan } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Plan a card for a day (`YYYY-MM-DD`, the owner's time zone), or `null` to unplan it. */
export const POST = apiRoute<{ id: string }>('write', async ({ caller, params, request }) => {
  const { day } = cardPlan.parse(await readJson(request));
  await cardDetail(caller, params.id);
  await caller.board.commit({ taskId: params.id, day });
  return cardDetail(caller, params.id);
});
