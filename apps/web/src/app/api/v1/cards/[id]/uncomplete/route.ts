import { apiRoute } from '@/server/api/handler';
import { cardDetail } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Put a finished card back. */
export const POST = apiRoute<{ id: string }>('write', async ({ caller, params }) => {
  const card = await cardDetail(caller, params.id);
  if (card.completedAt) await caller.task.uncomplete({ id: params.id });
  return cardDetail(caller, params.id);
});
