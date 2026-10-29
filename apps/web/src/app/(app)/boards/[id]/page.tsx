import Link from 'next/link';
import { notFound } from 'next/navigation';
import { startOfLocalDay } from '@fluid/core';
import { renameBoard, setBoardArchived } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { ActionForm } from '@/components/kanban/action-form';
import { BoardView, type Destination } from '@/components/kanban/board-view';
import { CardPanel, TrashList } from '@/components/kanban/card-panel';
import { ChevronLeftIcon, DotsIcon, SearchIcon } from '@/components/icons';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

function dayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/**
 * One board.
 *
 * `?q=` filters the cards with the shared search grammar; `?card=` opens a
 * card beside the board. Both live in the URL, so a filtered board or an open
 * card survives a refresh and can be sent to someone.
 */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; card?: string }>;
}) {
  const user = await requireUser();
  const caller = await getCaller();
  const { id } = await params;
  const { q = '', card: cardId } = await searchParams;

  const board = await caller.kanban.board({ id, q }).catch(() => null);
  if (!board) notFound();

  const [boards, card] = await Promise.all([
    caller.kanban.boards(),
    cardId ? caller.kanban.card({ id: cardId }) : Promise.resolve(undefined),
  ]);

  const timeZone = user.timeZone;
  const now = new Date();
  const todayKey = dayKey(now, timeZone);
  const tomorrowKey = dayKey(startOfLocalDay(now, timeZone, 1), timeZone);

  const destinations: Destination[] = boards
    .filter((candidate) => !candidate.archivedAt || candidate.id === board.id)
    .map((candidate) => ({
      boardId: candidate.id,
      boardName: candidate.name,
      columns: candidate.columns.map((column) => ({ id: column.id, name: column.name })),
    }));

  const closeHref = q ? `/boards/${board.id}?q=${encodeURIComponent(q)}` : `/boards/${board.id}`;
  const open = board.columns.reduce((sum, column) => sum + (column.category === 'DONE' ? 0 : column.total), 0);

  return (
    <>
      <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <Link href="/boards" className="text-base-content/45 hover:text-base-content mb-1 inline-flex items-center gap-1 text-xs font-medium">
            <ChevronLeftIcon className="size-3.5" /> Boards
          </Link>
          <h1 className="truncate text-[1.7rem] font-extrabold leading-none tracking-tight sm:text-[2.1rem]">{board.name}</h1>
          <p className="text-base-content/55 mt-1.5 text-sm">
            {open} open card{open === 1 ? '' : 's'}
            {board.archivedAt ? ' · archived' : ''}
            {board.isInbox ? ' · new tasks from anywhere land here' : ''}
          </p>
        </div>

        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <form action={`/boards/${board.id}`} className="min-w-0 grow sm:grow-0">
            <label className="input input-sm w-full sm:w-72">
              <SearchIcon className="text-base-content/40 size-4" />
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Filter: label:client due:week"
                className="grow"
                aria-label="Filter this board"
              />
            </label>
          </form>

          <details className="dropdown dropdown-end">
            <summary className="btn btn-ghost btn-sm btn-square list-none rounded-xl [&::-webkit-details-marker]:hidden" aria-label="Board options">
              <DotsIcon />
            </summary>
            <div className="dropdown-content bg-base-100 border-base-200 z-30 mt-1 w-80 space-y-4 rounded-2xl border p-4 shadow-xl">
              {!board.isInbox ? (
                <ActionForm action={renameBoard} reset={false} success="Board renamed." className="space-y-2">
                  <input type="hidden" name="id" value={board.id} />
                  <label className="block text-xs font-medium">
                    Name
                    <input name="name" required maxLength={120} defaultValue={board.name} className="input input-sm mt-1 w-full" />
                  </label>
                  <button type="submit" className="btn btn-primary btn-xs rounded-lg">
                    Rename
                  </button>
                </ActionForm>
              ) : null}

              <div>
                <p className="mb-1 text-xs font-medium">Recently deleted</p>
                <TrashList items={board.trash} timeZone={timeZone} />
              </div>

              {!board.isInbox ? (
                <div className="border-base-200 border-t pt-3">
                  <LoggedActionButton
                    action={setBoardArchived}
                    fields={{ id: board.id, archived: board.archivedAt ? 'false' : 'true' }}
                    successMessage={board.archivedAt ? 'Board restored.' : 'Board archived — its cards are out of the plan.'}
                    className="btn btn-ghost btn-xs rounded-lg"
                  >
                    {board.archivedAt ? 'Restore board' : 'Archive board'}
                  </LoggedActionButton>
                </div>
              ) : null}
            </div>
          </details>
        </div>
      </header>

      {board.filtered ? (
        <p className="text-base-content/60 mb-3 text-sm">
          Showing cards matching “{q}”.{' '}
          <Link href={`/boards/${board.id}`} className="link link-primary">
            Clear filter
          </Link>
        </p>
      ) : null}

      <BoardView
        boardId={board.id}
        columns={board.columns}
        destinations={destinations}
        timeZone={timeZone}
        todayKey={todayKey}
        filtered={board.filtered}
      />

      {cardId ? (
        <CardPanel
          card={card ?? null}
          closeHref={closeHref}
          columns={board.columns.map((column) => ({ id: column.id, name: column.name }))}
          labels={board.labels}
          timeZone={timeZone}
          todayKey={todayKey}
          tomorrowKey={tomorrowKey}
          userId={user.id}
        />
      ) : null}
    </>
  );
}
