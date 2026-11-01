import { apiRoute, readJson } from '@/server/api/handler';
import { cardDetail, checklistCreate } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** Add a checklist item to the end of a card's checklist. */
export const POST = apiRoute<{ id: string }>(
  'write',
  async ({ caller, params, request }) => {
    const { text } = checklistCreate.parse(await readJson(request));
    await caller.kanban.addChecklistItem({ taskId: params.id, text });
    return cardDetail(caller, params.id);
  },
  { status: 201 },
);
