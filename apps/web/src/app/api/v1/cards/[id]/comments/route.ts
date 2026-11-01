import { apiRoute, readJson } from '@/server/api/handler';
import { cardDetail, commentCreate } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Comment on a card, as the token's owner. */
export const POST = apiRoute<{ id: string }>(
  'write',
  async ({ caller, params, request }) => {
    const { body } = commentCreate.parse(await readJson(request));
    await caller.kanban.addComment({ taskId: params.id, body });
    return cardDetail(caller, params.id);
  },
  { status: 201 },
);
