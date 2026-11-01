import { apiRoute } from '@/server/api/handler';
import { cardCreate, cardDetail, cardSummary, toUpdateInput } from '@/server/api/cards';
import { readJson } from '@/server/api/handler';

export const dynamic = 'force-dynamic';

/** Cards from every board. `?q=` uses the search grammar; no `q` means every open card. */
export const GET = apiRoute('read', async ({ caller, request }) => {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 200));
  const cards = await caller.kanban.search({ q: params.get('q') ?? '', limit });
  return { cards: cards.map((card) => cardSummary(card)) };
});

/** Add a card to a column. Any of the PATCH fields may be set at the same time. */
export const POST = apiRoute(
  'write',
  async ({ caller, request }) => {
    const { columnId, title, ...rest } = cardCreate.parse(await readJson(request));
    const { id } = await caller.kanban.createCard({ columnId, title });
    if (Object.keys(rest).length > 0) await caller.kanban.updateCard(toUpdateInput(id, rest));
    return cardDetail(caller, id);
  },
  { status: 201 },
);
