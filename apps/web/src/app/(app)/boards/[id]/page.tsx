import Link from 'next/link';
import { notFound } from 'next/navigation';
import { startOfLocalDay } from '@fluid/core';
import { env } from '@fluid/env';
import { renameBoard, saveBoardTemplate, setBoardArchived } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { ActionForm } from '@/components/kanban/action-form';
import { BoardView, type Destination } from '@/components/kanban/board-view';
import { CardPanel, TrashList } from '@/components/kanban/card-panel';
import { CardTable, parseSort, sortRows, type TableRow } from '@/components/kanban/card-table';
import { ViewBar } from '@/components/kanban/view-bar';
import { CalendarShortcut, SideCalendar, type SideCalendarDay } from '@/components/kanban/side-calendar';
import { dayKeyOf, plannedMinutes } from '@/components/day-load';
import { formatTime } from '@/components/format';
import { CalendarIcon, ChevronLeftIcon, DotsIcon, SearchIcon } from '@/components/icons';
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
 * card survives a refresh and can be sent to someone. `?view=table` shows
 * the same cards as rows, sorted by `?sort=` (`due`, `-priority`, …).
 */
export default async function BoardPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; card?: string; view?: string; sort?: string; cal?: string }>;
}) {
  const user = await requireUser();
  const caller = await getCaller();
  const { id } = await params;
  const { q = '', card: cardId, view, sort: sortParam, cal } = await searchParams;
  const layout = view === 'table' ? 'table' : 'board';
  // The side calendar is for dragging cards onto days, so it belongs to the board layout.
  const showCalendar = cal === '1' && layout === 'board';

  const board = await caller.kanban.board({ id, q }).catch(() => null);
  if (!board) notFound();

  const [boards, card, views, week] = await Promise.all([
    caller.kanban.boards(),
    cardId ? caller.kanban.card({ id: cardId }) : Promise.resolve(undefined),
    caller.kanban.views({ boardId: board.id }),
    showCalendar ? caller.board.week({ weekStart: new Date(), includeBacklog: false }) : Promise.resolve(null),
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

  /** This board's URL with the filter and layout kept, plus whatever is passed. */
  const hrefWith = (extra: Record<string, string>) => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (layout === 'table') query.set('view', 'table');
    if (layout === 'table' && sortParam) query.set('sort', sortParam);
    if (showCalendar) query.set('cal', '1');
    for (const [key, value] of Object.entries(extra)) {
      if (value === '') query.delete(key);
      else query.set(key, value);
    }
    const text = query.toString();
    return text ? `/boards/${board.id}?${text}` : `/boards/${board.id}`;
  };
  const closeHref = hrefWith({});
  const sort = parseSort(sortParam);
  const rows: TableRow[] =
    layout === 'table'
      ? sortRows(
          board.columns.flatMap((column) => column.cards.map((card) => ({ ...card, boardId: board.id, columnName: column.name }))),
          sort,
        )
      : [];
  const hiddenDone = board.columns.reduce((sum, column) => sum + (column.total - column.cards.length), 0);

  const calendarToggleHref = hrefWith({ cal: showCalendar ? '' : '1', card: '' });
  const linkQuery = (() => {
    const text = hrefWith({}).split('?')[1];
    return text ? `${text}&` : '';
  })();
  const weekdayFormat = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short' });
  const dayNumberFormat = new Intl.DateTimeFormat('en-GB', { timeZone, day: 'numeric', month: 'short' });
  const calendarDays: SideCalendarDay[] = (week?.days ?? []).map(({ day, shape, tasks }) => {
    const key = dayKeyOf(day, timeZone);
    return {
      key,
      weekday: weekdayFormat.format(day),
      dayNumber: dayNumberFormat.format(day),
      isToday: key === todayKey,
      capacityMinutes: Math.round(shape.capacity.capacityMinutes),
      plannedMinutes: Math.round(plannedMinutes(key, shape.capacity.committedMinutes, tasks, timeZone)),
      meetingMinutes: Math.round(shape.capacity.meetingMinutes),
      hasWorkingHours: shape.hasWorkingHours,
      isNonWorkingDay: shape.isNonWorkingDay,
      cards: tasks.map((task) => {
        const block = task.scheduledBlocks.find((candidate) => dayKeyOf(candidate.startsAt, timeZone) === key);
        return {
          id: task.id,
          title: task.title,
          estimateMinutes: task.estimateMinutes,
          estimateAssumed: task.estimateAssumed,
          done: task.status === 'DONE',
          time: block ? formatTime(block.startsAt, timeZone) : null,
          href: task.boardId === board.id ? hrefWith({ card: task.id }) : task.boardId ? `/boards/${task.boardId}?card=${task.id}` : null,
        };
      }),
    };
  });
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
            {layout === 'table' ? <input type="hidden" name="view" value="table" /> : null}
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

              <ActionForm action={saveBoardTemplate} success="Saved as a template — pick it when you create a board." className="border-base-200 space-y-2 border-t pt-3">
                <input type="hidden" name="boardId" value={board.id} />
                <label className="block text-xs font-medium">
                  Save as template
                  <input name="name" required maxLength={80} placeholder="Template name" className="input input-sm mt-1 w-full" />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input type="checkbox" name="includeCards" className="checkbox checkbox-xs" />
                  Include the open cards as starter cards
                </label>
                <button type="submit" className="btn btn-ghost btn-xs rounded-lg">
                  Save template
                </button>
              </ActionForm>

              <div className="border-base-200 border-t pt-3">
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
          <Link href={layout === 'table' ? `/boards/${board.id}?view=table` : `/boards/${board.id}`} className="link link-primary">
            Clear filter
          </Link>
        </p>
      ) : null}

      <ViewBar basePath={`/boards/${board.id}`} boardId={board.id} q={q} layout={layout} sort={sortParam} views={views}>
        {layout === 'board' ? (
          <>
            <Link
              href={calendarToggleHref}
              scroll={false}
              className={`btn btn-sm gap-1.5 rounded-xl ${showCalendar ? 'btn-primary btn-soft' : 'btn-ghost'}`}
              aria-pressed={showCalendar}
              title="Show this week beside the board (C)"
            >
              <CalendarIcon className="size-4" /> Calendar
              <kbd className="kbd kbd-xs hidden sm:inline-flex">C</kbd>
            </Link>
            <CalendarShortcut href={calendarToggleHref} />
          </>
        ) : null}
      </ViewBar>

      {layout === 'table' ? (
        <>
          <CardTable
            rows={rows}
            sort={sort}
            hrefFor={(next) => {
              const query = new URLSearchParams({ view: 'table', sort: next });
              if (q) query.set('q', q);
              return `/boards/${board.id}?${query.toString()}`;
            }}
            cardHref={(row) => hrefWith({ card: row.id })}
            timeZone={timeZone}
          />
          {hiddenDone > 0 ? (
            <p className="text-base-content/45 mt-3 text-xs">
              Older done cards are left out ({hiddenDone}). Search <code>status:done</code> on the Boards page to see them all.
            </p>
          ) : null}
        </>
      ) : (
        <div className={showCalendar ? 'flex flex-col xl:flex-row-reverse xl:items-start xl:gap-4' : ''}>
          {showCalendar ? <SideCalendar days={calendarDays} closeHref={calendarToggleHref} /> : null}
          {/*
            The board bleeds to the page edges on purpose. Beside the calendar
            it must stop at the calendar instead, or it scrolls underneath it.
          */}
          <div className={`min-w-0 xl:grow ${showCalendar ? 'xl:[&>div]:!mr-0 xl:[&>div]:!pr-1' : ''}`}>
            <BoardView
              boardId={board.id}
              columns={board.columns}
              destinations={destinations}
              timeZone={timeZone}
              todayKey={todayKey}
              filtered={board.filtered}
              linkQuery={linkQuery}
            />
          </div>
        </div>
      )}

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
          maxUploadMb={env.MAX_UPLOAD_MB}
        />
      ) : null}
    </>
  );
}
