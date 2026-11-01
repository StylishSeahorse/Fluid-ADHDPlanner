import Link from 'next/link';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { NewBoardForm } from '@/components/kanban/new-board-form';
import { relativeDays } from '@/components/format';
import { BoardIcon, ListIcon, SearchIcon, XIcon } from '@/components/icons';
import { deleteBoardTemplate } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { CardTable, parseSort, sortRows } from '@/components/kanban/card-table';
import { ViewBar } from '@/components/kanban/view-bar';
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
 *
 * A search, or `?view=table`, shows matching cards from every board as one
 * sortable table; with no search that is every open card.
 */
export default async function BoardsPage({ searchParams }: { searchParams: Promise<{ q?: string; view?: string; sort?: string }> }) {
  const user = await requireUser();
  const caller = await getCaller();
  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const showTable = Boolean(q) || params.view === 'table';

  const [boards, results, templates, views] = await Promise.all([
    caller.kanban.boards(),
    showTable ? caller.kanban.search({ q }) : [],
    caller.kanban.templates(),
    caller.kanban.views({ boardId: null }),
  ]);
  const sort = parseSort(params.sort);
  const rows = sortRows(
    results.map((card) => ({ ...card, boardId: card.board?.id ?? '', boardName: card.board?.name ?? '', columnName: card.column?.name ?? '' })),
    sort,
  );
  const tableHref = (extra: Record<string, string>) => {
    const query = new URLSearchParams({ view: 'table' });
    if (q) query.set('q', q);
    if (params.sort) query.set('sort', params.sort);
    for (const [key, value] of Object.entries(extra)) query.set(key, value);
    return `/boards?${query.toString()}`;
  };
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
            <input type="hidden" name="view" value="table" />
            <p className="text-base-content/50 text-xs">
              Try <code>label:client</code> <code>due:week</code> <code>-status:done</code>{' '}
              <code>planned:none</code> <code>priority:&gt;=high</code>
            </p>
          </div>
        </form>

        <div className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body p-4">
            <NewBoardForm templates={templates} />
            {templates.saved.length > 0 ? (
              <details className="mt-1">
                <summary className="text-base-content/50 cursor-pointer text-xs">Manage your templates</summary>
                <ul className="mt-2 space-y-1">
                  {templates.saved.map((template) => (
                    <li key={template.id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="min-w-0 truncate">
                        {template.name} <span className="text-base-content/40 text-xs">{template.columns.join(' · ')}</span>
                      </span>
                      <LoggedActionButton
                        action={deleteBoardTemplate}
                        fields={{ id: template.id }}
                        successMessage={`Deleted the template “${template.name}”.`}
                        className="btn btn-ghost btn-xs btn-square rounded-lg"
                      >
                        <XIcon className="size-3" />
                        <span className="sr-only">Delete template {template.name}</span>
                      </LoggedActionButton>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        </div>
      </div>

      {!showTable ? (
        <div className="mb-6 flex flex-wrap items-center gap-2">
          <Link href="/boards?view=table" className="btn btn-ghost btn-sm gap-1.5 rounded-xl">
            <ListIcon className="size-4" /> Every open card as a table
          </Link>
          {views.map((view) => (
            <Link key={view.id} href={`/boards?view=table${view.query ? `&q=${encodeURIComponent(view.query)}` : ''}`} className="btn btn-outline btn-xs rounded-lg">
              {view.name}
            </Link>
          ))}
        </div>
      ) : null}

      {showTable ? (
        <section className="mb-8">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <SectionTitle>
              {q
                ? results.length === 0
                  ? 'No cards match'
                  : `${results.length} card${results.length === 1 ? '' : 's'} match`
                : `${results.length} open card${results.length === 1 ? '' : 's'} on every board`}
            </SectionTitle>
            <Link href="/boards" className="link link-hover text-base-content/55 text-xs">
              Close table
            </Link>
          </div>
          <ViewBar basePath="/boards" boardId={null} q={q} layout="table" sort={params.sort} views={views} showLayoutSwitch={false} />
          <CardTable
            rows={rows}
            sort={sort}
            hrefFor={(next) => tableHref({ sort: next })}
            cardHref={(row) => `/boards/${row.boardId}?card=${row.id}`}
            timeZone={user.timeZone}
            showBoard
          />
          {results.length >= 200 ? <p className="text-base-content/45 mt-2 text-xs">Showing the first 200. Narrow the search to see the rest.</p> : null}
        </section>
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
