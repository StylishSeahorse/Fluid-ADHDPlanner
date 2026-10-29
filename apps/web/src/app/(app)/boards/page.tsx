import Link from 'next/link';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { NewBoardForm } from '@/components/kanban/new-board-form';
import { relativeDays } from '@/components/format';
import { BoardIcon, SearchIcon } from '@/components/icons';
import { chipClass } from '@/components/label-colors';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Boards' };

/**
 * Every project as a board, plus search across all of them.
 *
 * Boards answer "where is this work in its workflow?". Which *day* it happens
 * on is a separate decision, made from any card ("Plan for…") or on the Week
 * board — the two never fight over one field.
 */
export default async function BoardsPage({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  await requireUser();
  const caller = await getCaller();
  const q = ((await searchParams).q ?? '').trim();

  const [boards, results] = await Promise.all([caller.kanban.boards(), q ? caller.kanban.search({ q }) : []]);
  const active = boards.filter((board) => !board.archivedAt);
  const archived = boards.filter((board) => board.archivedAt);

  return (
    <>
      <PageHeader
        eyebrow="Every project"
        title="Boards"
        subtitle="Where each piece of work is. Plan any card into a day from the card itself."
      />

      <div className="mb-6 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <form action="/boards" className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-2 p-4">
            <label className="input input-sm w-full">
              <SearchIcon className="text-base-content/40 size-4" />
              <input
                type="search"
                name="q"
                defaultValue={q}
                placeholder="Search every board"
                className="grow"
                aria-label="Search every board"
              />
            </label>
            <p className="text-base-content/50 text-xs">
              Try <code>label:client</code> <code>due:week</code> <code>-status:done</code>{' '}
              <code>planned:none</code> <code>priority:&gt;=high</code>
            </p>
          </div>
        </form>

        <div className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body p-4">
            <NewBoardForm />
          </div>
        </div>
      </div>

      {q ? (
        <>
          <SectionTitle>
            {results.length === 0 ? 'No cards match' : `${results.length} card${results.length === 1 ? '' : 's'} match`}
          </SectionTitle>
          {results.length > 0 ? (
            <ul className="card bg-base-100 border-base-200 divide-base-200 mb-8 divide-y border shadow-sm">
              {results.map((card) => (
                <li key={card.id}>
                  <Link
                    href={`/boards/${card.board?.id}?card=${card.id}`}
                    className="hover:bg-base-200/50 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3"
                  >
                    <span className={`min-w-0 grow text-sm font-medium ${card.completedAt ? 'text-base-content/50 line-through' : ''}`}>
                      {card.title}
                    </span>
                    {card.labels.map((label) => (
                      <span key={label.id} className={`rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold ${chipClass(label.color)}`}>
                        {label.name}
                      </span>
                    ))}
                    <span className="text-base-content/50 text-xs">
                      {card.board?.name} › {card.column?.name}
                      {card.deadline ? ` · due ${relativeDays(card.deadline)}` : ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-base-content/55 mb-8 text-sm">Nothing on any board matches “{q}”.</p>
          )}
        </>
      ) : null}

      <SectionTitle>Your boards</SectionTitle>
      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {active.map((board) => (
          <li key={board.id}>
            <Link
              href={`/boards/${board.id}`}
              className="card bg-base-100 border-base-200 hover:border-primary/40 h-full border shadow-sm transition-colors"
            >
              <div className="card-body gap-3 p-4">
                <div className="flex items-center gap-2.5">
                  <span
                    className="grid size-8 shrink-0 place-items-center rounded-lg text-white"
                    style={{ backgroundColor: board.isInbox ? 'var(--color-base-content)' : (board.color ?? 'var(--color-primary)') }}
                    aria-hidden="true"
                  >
                    <BoardIcon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold">{board.name}</h3>
                    <p className="text-base-content/50 text-xs">
                      {board.isInbox ? 'Where new tasks land' : `${board.open} open · ${board.done} done`}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap gap-1.5 text-xs">
                  {board.isInbox ? <span className="badge badge-sm badge-ghost">{board.open} open</span> : null}
                  {board.overdue > 0 ? (
                    <span className="badge badge-sm badge-soft badge-error">{board.overdue} overdue</span>
                  ) : null}
                  {board.deadline ? <span className="badge badge-sm badge-ghost">due {relativeDays(board.deadline)}</span> : null}
                  <span className="text-base-content/40">{board.columns.map((column) => column.name).join(' · ')}</span>
                </div>
              </div>
            </Link>
          </li>
        ))}
      </ul>

      {archived.length > 0 ? (
        <details className="mt-8">
          <summary className="text-base-content/55 cursor-pointer text-sm font-medium">
            {archived.length} archived board{archived.length === 1 ? '' : 's'}
          </summary>
          <ul className="mt-3 space-y-1">
            {archived.map((board) => (
              <li key={board.id}>
                <Link href={`/boards/${board.id}`} className="link link-hover text-sm">
                  {board.name}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      <p className="text-base-content/40 mt-10 text-xs">
        Cards on boards are the same tasks you see on Today and Week — nothing is copied.
      </p>
    </>
  );
}
