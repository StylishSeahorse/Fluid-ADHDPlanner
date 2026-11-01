import { apiRoute } from '@/server/api/handler';

export const dynamic = 'force-dynamic';

/** Every board, with its columns in order. */
export const GET = apiRoute('read', async ({ caller }) => {
  const boards = await caller.kanban.boards();
  return {
    boards: boards.map((board) => ({
      id: board.id,
      name: board.name,
      isInbox: board.isInbox,
      archivedAt: board.archivedAt,
      open: board.open,
      done: board.done,
      overdue: board.overdue,
      columns: board.columns.map(({ id, name, category }) => ({ id, name, category })),
    })),
  };
});
