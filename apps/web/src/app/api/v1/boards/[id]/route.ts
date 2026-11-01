import { apiRoute } from '@/server/api/handler';
import { cardSummary } from '@/server/api/cards';

export const dynamic = 'force-dynamic';

/** One board, its columns, and their cards. `?q=` filters with the search grammar. */
export const GET = apiRoute<{ id: string }>('read', async ({ caller, params, request }) => {
  const q = new URL(request.url).searchParams.get('q') ?? undefined;
  const board = await caller.kanban.board({ id: params.id, ...(q ? { q } : {}) });
  return {
    id: board.id,
    name: board.name,
    isInbox: board.isInbox,
    archivedAt: board.archivedAt,
    filtered: board.filtered,
    columns: board.columns.map((column) => ({
      id: column.id,
      name: column.name,
      category: column.category,
      wipLimit: column.wipLimit,
      total: column.total,
      cards: column.cards.map((card) => cardSummary(card, board.id)),
    })),
  };
});
