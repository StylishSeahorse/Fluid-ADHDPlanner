import { apiRoute } from '@/server/api/handler';
import { cardDetail } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Mark a card done — the same as ticking it in the app, side effects included. */
export const POST = apiRoute<{ id: string }>('write', async ({ caller, params }) => {
  const card = await cardDetail(caller, params.id);
  if (!card.completedAt) await caller.task.complete({ id: params.id });
  return cardDetail(caller, params.id);
});
