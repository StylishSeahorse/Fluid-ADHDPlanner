'use client';

/**
 * The Kanban board.
 *
 * Drag is the fast path and never the only one: every card has a "Move to…"
 * dialog, because native drag-and-drop is invisible to keyboards and awkward
 * on a phone — and a phone, one-handed, is where this gets used.
 *
 * Moves are optimistic. The card jumps immediately; the server confirms by
 * re-rendering the page; a failure puts the card back and says why. Waiting
 * for a round trip before a dropped card lands feels like the drop did not
 * take, which is exactly the doubt this app exists to remove.
 */
import { Estimate } from '@/components/estimate';
import Link from 'next/link';
import { useEffect, useRef, useState, useTransition } from 'react';
import {
  addColumn,
  completeTask,
  createCard,
  deleteColumn,
  moveBoardCard,
  shiftColumn,
  uncompleteTask,
  updateColumn,
} from '@/app/actions';
import { logAction } from '@/components/action-log';
import { relativeDays } from '@/components/format';
import {
  CalendarIcon,
  ChatIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  DotsIcon,
  LockIcon,
  PaperclipIcon,
  PlusIcon,
  SubtaskIcon,
  TimerIcon,
} from '@/components/icons';
import { chipClass } from '@/components/label-colors';
import { ActionForm } from './action-form';

export type Category = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE';

export interface BoardCard {
  id: string;
  title: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  estimateMinutes: number;
  estimateAssumed: boolean;
  deadline: Date | null;
  plannedFor: Date | null;
  completedAt: Date | null;
  labels: Array<{ id: string; name: string; color: string }>;
  checklist: { done: number; total: number };
  commentCount: number;
  attachmentCount: number;
  subtaskCount: number;
  blocked: boolean;
  nextSession: { startsAt: Date; state: string } | null;
}

export interface BoardColumnData {
  id: string;
  name: string;
  category: Category | null;
  wipLimit: number | null;
  total: number;
  estimateMinutes: number;
  cards: BoardCard[];
}

export interface Destination {
  boardId: string;
  boardName: string;
  columns: Array<{ id: string; name: string }>;
}

const CATEGORY_LABEL: Record<Category, string> = {
  BACKLOG: 'Backlog',
  TODO: 'To do',
  IN_PROGRESS: 'Doing',
  DONE: 'Done',
};

interface DropTarget {
  columnId: string;
  index: number;
}

export function BoardView({
  boardId,
  columns: initial,
  destinations,
  timeZone,
  todayKey,
  filtered,
  linkQuery = '',
}: {
  boardId: string;
  columns: BoardColumnData[];
  destinations: Destination[];
  timeZone: string;
  /** The user's local date, for "Today" chips. */
  todayKey: string;
  filtered: boolean;
  /** Query string kept when a card is opened (the filter, the side calendar), ending in `&`. */
  linkQuery?: string;
}) {
  const [columns, setColumns] = useState(initial);
  const [dragging, setDragging] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [moving, setMoving] = useState<BoardCard | null>(null);
  const [, startTransition] = useTransition();

  // The server's version wins whenever it arrives.
  useEffect(() => setColumns(initial), [initial]);

  const move = (cardId: string, toColumnId: string, toIndex: number | null) => {
    const before = columns;
    const fromColumn = columns.find((column) => column.cards.some((card) => card.id === cardId));
    const card = fromColumn?.cards.find((candidate) => candidate.id === cardId);
    if (!fromColumn || !card) return;

    // Where it lands, in the destination's order without the card itself.
    const destination = columns.find((column) => column.id === toColumnId);
    const remaining = (destination?.cards ?? []).filter((candidate) => candidate.id !== cardId);
    const index = toIndex === null ? remaining.length : Math.min(toIndex, remaining.length);
    const afterId = remaining[index - 1]?.id ?? null;
    const beforeId = remaining[index]?.id ?? null;

    if (fromColumn.id === toColumnId) {
      const current = fromColumn.cards.findIndex((candidate) => candidate.id === cardId);
      if (current === index) return; // dropped where it was
    }

    setColumns((previous) =>
      previous.map((column) => {
        let cards = column.cards.filter((candidate) => candidate.id !== cardId);
        if (column.id === toColumnId) cards = [...cards.slice(0, index), card, ...cards.slice(index)];
        const delta = (column.id === toColumnId ? 1 : 0) - (column.id === fromColumn.id ? 1 : 0);
        return { ...column, cards, total: column.total + delta };
      }),
    );

    startTransition(async () => {
      const result = await moveBoardCard({ taskId: cardId, columnId: toColumnId, beforeId, afterId });
      if (result.error) {
        setColumns(before);
        logAction(result.error, 'error');
      }
    });
  };

  // ---- Drag and drop ---------------------------------------------------------

  const indexFromPointer = (list: HTMLElement, clientY: number): number => {
    const cards = [...list.querySelectorAll<HTMLElement>('[data-card-id]')].filter(
      (element) => element.dataset.cardId !== dragging,
    );
    const index = cards.findIndex((element) => {
      const box = element.getBoundingClientRect();
      return clientY < box.top + box.height / 2;
    });
    return index < 0 ? cards.length : index;
  };

  return (
    <>
      <div
        className="-mx-4 flex snap-x snap-mandatory items-start gap-4 overflow-x-auto px-4 pb-6 lg:-mx-10 lg:snap-none lg:px-10"
        aria-label="Board columns"
      >
        {columns.map((column, columnIndex) => {
          const over = column.wipLimit !== null && column.total > column.wipLimit;
          const showDrop = (index: number) =>
            dragging !== null && target?.columnId === column.id && target.index === index;
          const visible = column.cards.filter((card) => card.id !== dragging || target === null);

          return (
            <section
              key={column.id}
              className="bg-base-200/70 border-base-300/60 flex max-h-[calc(100dvh-13rem)] w-[85vw] shrink-0 snap-center flex-col rounded-2xl border sm:w-72"
              aria-labelledby={`col-${column.id}`}
              onDragOver={(event) => {
                if (!dragging) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const list = event.currentTarget.querySelector<HTMLElement>('[data-card-list]');
                if (list) setTarget({ columnId: column.id, index: indexFromPointer(list, event.clientY) });
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTarget(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                const cardId = event.dataTransfer.getData('text/plain') || dragging;
                if (cardId) move(cardId, column.id, target?.columnId === column.id ? target.index : null);
                setDragging(null);
                setTarget(null);
              }}
            >
              <ColumnHeader
                column={column}
                columns={columns}
                first={columnIndex === 0}
                last={columnIndex === columns.length - 1}
                over={over}
              />

              <ol data-card-list className="flex min-h-12 grow flex-col gap-2 overflow-y-auto px-2 pb-2">
                {visible.map((card, index) => (
                  <li key={card.id} className="relative">
                    {showDrop(index) ? <DropLine /> : null}
                    <Card
                      card={card}
                      boardId={boardId}
                      linkQuery={linkQuery}
                      timeZone={timeZone}
                      todayKey={todayKey}
                      dimmed={dragging === card.id}
                      onDragStart={() => setDragging(card.id)}
                      onDragEnd={() => {
                        setDragging(null);
                        setTarget(null);
                      }}
                      onMove={() => setMoving(card)}
                    />
                  </li>
                ))}
                {showDrop(visible.length) ? (
                  <li className="relative h-2">
                    <DropLine />
                  </li>
                ) : null}

                {column.cards.length === 0 && !dragging ? (
                  <li className="text-base-content/40 px-2 py-4 text-center text-xs">
                    {filtered ? 'Nothing here matches.' : 'Drop a card here'}
                  </li>
                ) : null}
                {column.category === 'DONE' && column.total > column.cards.length ? (
                  <li className="text-base-content/45 px-2 py-1 text-center text-xs">
                    {column.total - column.cards.length} older finished cards not shown
                  </li>
                ) : null}
              </ol>

              <QuickAdd columnId={column.id} />
            </section>
          );
        })}

        <AddColumn boardId={boardId} />
      </div>

      {moving ? (
        <MoveDialog
          card={moving}
          destinations={destinations}
          currentBoardId={boardId}
          onClose={() => setMoving(null)}
          onMove={(columnId) => {
            const local = columns.some((column) => column.id === columnId);
            if (local) move(moving.id, columnId, null);
            else
              startTransition(async () => {
                const result = await moveBoardCard({ taskId: moving.id, columnId });
                if (result.error) logAction(result.error, 'error');
                else logAction(`Moved “${moving.title}” to another board.`);
              });
            setMoving(null);
          }}
        />
      ) : null}
    </>
  );
}

function DropLine() {
  return <div className="bg-primary pointer-events-none absolute -top-1.5 left-1 right-1 h-0.5 rounded-full" />;
}

// ---------------------------------------------------------------------------
// Card face
// ---------------------------------------------------------------------------

function dayKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

function shortDate(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(instant);
}

function Card({
  card,
  boardId,
  linkQuery,
  timeZone,
  todayKey,
  dimmed,
  onDragStart,
  onDragEnd,
  onMove,
}: {
  card: BoardCard;
  boardId: string;
  linkQuery: string;
  timeZone: string;
  todayKey: string;
  dimmed: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onMove: () => void;
}) {
  const done = card.completedAt !== null;
  const [pending, start] = useTransition();
  const now = Date.now();
  const deadline = card.deadline ? new Date(card.deadline) : null;
  const overdue = !done && deadline !== null && deadline.getTime() < now;
  const soon = !done && !overdue && deadline !== null && deadline.getTime() - now < 36 * 3_600_000;
  const planned = card.plannedFor ? dayKey(new Date(card.plannedFor), timeZone) : null;

  return (
    <article
      data-card-id={card.id}
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', card.id);
        event.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      className={`group bg-base-100 border-base-300/70 hover:border-primary/40 relative cursor-grab rounded-xl border p-3 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,opacity] active:cursor-grabbing ${
        dimmed ? 'opacity-40' : ''
      } ${done ? 'opacity-70' : ''}`}
    >
      {card.labels.length > 0 ? (
        <div className="mb-1.5 flex flex-wrap gap-1">
          {card.labels.map((label) => (
            <span key={label.id} className={`rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold ${chipClass(label.color)}`}>
              {label.name}
            </span>
          ))}
        </div>
      ) : null}

      <div className="flex items-start gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() =>
            start(async () => {
              if (done) {
                const result = await uncompleteTask(card.id);
                if (result.error) logAction(result.error, 'error');
                else logAction(`Reopened “${card.title}”.`, 'info');
              } else {
                const data = new FormData();
                data.set('id', card.id);
                await completeTask(data);
                logAction(`Finished “${card.title}”.`, 'success', { action: uncompleteTask, arg: card.id, label: 'Undo' });
              }
            })
          }
          className={`relative z-10 mt-0.5 grid size-[1.1rem] shrink-0 place-items-center rounded-full border-2 transition-colors ${
            done ? 'bg-primary border-primary text-white' : 'border-base-300 hover:border-primary hover:bg-primary/10'
          }`}
          aria-label={done ? `Reopen “${card.title}”` : `Mark “${card.title}” done`}
        >
          {done ? <CheckIcon className="size-2.5" /> : null}
        </button>

        {/* The whole title opens the card; scroll stays put so the board does not jump. */}
        <Link
          href={`/boards/${boardId}?${linkQuery}card=${card.id}`}
          scroll={false}
          className={`min-w-0 grow text-sm font-medium leading-snug after:absolute after:inset-0 after:content-[''] ${
            done ? 'text-base-content/60 line-through' : ''
          }`}
        >
          {card.title}
        </Link>

        <button
          type="button"
          onClick={onMove}
          className="btn btn-ghost btn-xs btn-square text-base-content/40 relative z-10 -mr-1 -mt-0.5 shrink-0 rounded-lg opacity-100 lg:opacity-0 lg:focus-visible:opacity-100 lg:group-hover:opacity-100"
          aria-label={`Move “${card.title}”`}
          title="Move to…"
        >
          <DotsIcon className="size-4" />
        </button>
      </div>

      <div className="text-base-content/55 mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-[0.7rem]">
        {card.priority === 'URGENT' || card.priority === 'HIGH' ? (
          <span className={card.priority === 'URGENT' ? 'text-error font-semibold' : 'text-warning-content font-semibold'}>
            {card.priority === 'URGENT' ? 'Urgent' : 'High'}
          </span>
        ) : null}
        <Estimate minutes={card.estimateMinutes} assumed={card.estimateAssumed} />
        {deadline ? (
          <span
            className={`rounded px-1 ${overdue ? 'bg-error/12 text-error font-semibold' : soon ? 'bg-warning/20 text-warning-content' : ''}`}
          >
            due {relativeDays(deadline)}
          </span>
        ) : null}
        {planned ? (
          <span className="bg-primary/10 text-primary inline-flex items-center gap-1 rounded px-1 font-medium">
            <CalendarIcon className="size-3" />
            {planned === todayKey ? 'Today' : shortDate(new Date(card.plannedFor!), timeZone)}
          </span>
        ) : null}
        {card.nextSession && !done ? (
          <span className="inline-flex items-center gap-1" title="Next scheduled session">
            <TimerIcon className="size-3" />
            {new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(card.nextSession.startsAt))}
          </span>
        ) : null}
        {card.checklist.total > 0 ? (
          <span
            className={`inline-flex items-center gap-0.5 ${card.checklist.done === card.checklist.total ? 'text-success font-medium' : ''}`}
            title="Checklist"
          >
            <CheckIcon className="size-3" />
            {card.checklist.done}/{card.checklist.total}
          </span>
        ) : null}
        {card.subtaskCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title="Subtasks">
            <SubtaskIcon className="size-3" />
            {card.subtaskCount}
          </span>
        ) : null}
        {card.attachmentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title="Attachments">
            <PaperclipIcon className="size-3" />
            {card.attachmentCount}
          </span>
        ) : null}
        {card.commentCount > 0 ? (
          <span className="inline-flex items-center gap-0.5" title="Comments">
            <ChatIcon className="size-3" />
            {card.commentCount}
          </span>
        ) : null}
        {card.blocked ? (
          <span className="text-error inline-flex items-center gap-0.5 font-medium" title="Waiting on another task">
            <LockIcon className="size-3" />
            waiting
          </span>
        ) : null}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Column header and menu
// ---------------------------------------------------------------------------

function ColumnHeader({
  column,
  columns,
  first,
  last,
  over,
}: {
  column: BoardColumnData;
  columns: BoardColumnData[];
  first: boolean;
  last: boolean;
  over: boolean;
}) {
  const [renaming, setRenaming] = useState(false);
  const others = columns.filter((candidate) => candidate.id !== column.id);

  return (
    <header className="flex items-center gap-2 px-3 pb-2 pt-3">
      {renaming ? (
        <ActionForm action={updateColumn} reset={false} className="min-w-0 grow" onDone={() => setRenaming(false)}>
          <input type="hidden" name="id" value={column.id} />
          <input
            name="name"
            defaultValue={column.name}
            autoFocus
            maxLength={80}
            onBlur={(event) => event.currentTarget.form?.requestSubmit()}
            onKeyDown={(event) => event.key === 'Escape' && setRenaming(false)}
            className="input input-sm w-full font-semibold"
            aria-label="Column name"
          />
        </ActionForm>
      ) : (
        <h2 id={`col-${column.id}`} className="min-w-0 grow truncate text-sm font-semibold">
          <button type="button" className="hover:text-primary truncate text-left" onClick={() => setRenaming(true)} title="Rename">
            {column.name}
          </button>
        </h2>
      )}

      <span
        className={`rounded-full px-1.5 text-xs font-medium ${over ? 'bg-error/15 text-error' : 'text-base-content/45'}`}
        title={over ? 'Over the work-in-progress limit' : undefined}
      >
        {column.total}
        {column.wipLimit !== null ? `/${column.wipLimit}` : ''}
      </span>

      <details className="dropdown dropdown-end">
        <summary className="btn btn-ghost btn-xs btn-square text-base-content/50 list-none rounded-lg [&::-webkit-details-marker]:hidden" aria-label={`${column.name} options`}>
          <DotsIcon className="size-4" />
        </summary>
        <div className="dropdown-content bg-base-100 border-base-200 z-30 mt-1 w-64 space-y-3 rounded-2xl border p-3 shadow-xl">
          <ActionForm action={updateColumn} reset={false} success="Column updated." className="space-y-2">
            <input type="hidden" name="id" value={column.id} />
            <label className="block text-xs font-medium">
              What it means
              <select name="category" defaultValue={column.category ?? ''} className="select select-sm mt-1 w-full">
                <option value="">Nothing — just a column</option>
                {(Object.keys(CATEGORY_LABEL) as Category[]).map((key) => (
                  <option key={key} value={key}>
                    {CATEGORY_LABEL[key]}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-xs font-medium">
              Work-in-progress limit
              <input
                type="number"
                name="wipLimit"
                min={1}
                max={999}
                defaultValue={column.wipLimit ?? ''}
                placeholder="No limit"
                className="input input-sm mt-1 w-full"
              />
            </label>
            <button type="submit" className="btn btn-primary btn-xs rounded-lg">
              Save
            </button>
          </ActionForm>

          <div className="border-base-200 flex gap-1 border-t pt-3">
            {!first ? (
              <ActionForm action={shiftColumn}>
                <input type="hidden" name="id" value={column.id} />
                <input type="hidden" name="direction" value="left" />
                <button type="submit" className="btn btn-ghost btn-xs gap-1 rounded-lg">
                  <ChevronLeftIcon className="size-3.5" /> Move left
                </button>
              </ActionForm>
            ) : null}
            {!last ? (
              <ActionForm action={shiftColumn}>
                <input type="hidden" name="id" value={column.id} />
                <input type="hidden" name="direction" value="right" />
                <button type="submit" className="btn btn-ghost btn-xs gap-1 rounded-lg">
                  Move right <ChevronRightIcon className="size-3.5" />
                </button>
              </ActionForm>
            ) : null}
          </div>

          {others.length > 0 ? (
            <ActionForm action={deleteColumn} success={`Deleted the ${column.name} column.`} className="border-base-200 space-y-2 border-t pt-3">
              <input type="hidden" name="id" value={column.id} />
              {column.total > 0 ? (
                <label className="block text-xs font-medium">
                  Delete column — move its {column.total} card{column.total === 1 ? '' : 's'} to
                  <select name="moveCardsTo" required className="select select-sm mt-1 w-full" defaultValue="">
                    <option value="" disabled>
                      Choose a column…
                    </option>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
              <button type="submit" className="btn btn-ghost btn-xs text-error rounded-lg">
                Delete column
              </button>
            </ActionForm>
          ) : null}
        </div>
      </details>
    </header>
  );
}

function QuickAdd({ columnId }: { columnId: string }) {
  const [open, setOpen] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-base-content/50 hover:text-base-content hover:bg-base-300/40 m-2 mt-0 flex items-center gap-1.5 rounded-xl px-2 py-2 text-sm"
      >
        <PlusIcon className="size-4" /> Add a card
      </button>
    );
  }

  return (
    <ActionForm
      action={createCard}
      className="m-2 mt-0 space-y-2"
      // Stay open for the next one — adding several in a row is the common case.
      onDone={() => input.current?.focus()}
    >
      <input type="hidden" name="columnId" value={columnId} />
      <input
        ref={input}
        name="title"
        required
        autoFocus
        maxLength={255}
        placeholder="What needs doing?"
        onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
        className="input input-sm w-full"
      />
      <div className="flex gap-1.5">
        <button type="submit" className="btn btn-primary btn-xs rounded-lg">
          Add
        </button>
        <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost btn-xs rounded-lg">
          Done
        </button>
      </div>
    </ActionForm>
  );
}

function AddColumn({ boardId }: { boardId: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="w-[85vw] shrink-0 snap-center sm:w-72">
      {open ? (
        <ActionForm
          action={addColumn}
          success="Added a column."
          className="bg-base-200/70 border-base-300/60 space-y-2 rounded-2xl border p-3"
          onDone={() => setOpen(false)}
        >
          <input type="hidden" name="boardId" value={boardId} />
          <input name="name" required autoFocus maxLength={80} placeholder="Column name" className="input input-sm w-full" />
          <select name="category" defaultValue="" className="select select-sm w-full" aria-label="What it means">
            <option value="">Just a column</option>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((key) => (
              <option key={key} value={key}>
                Counts as {CATEGORY_LABEL[key]}
              </option>
            ))}
          </select>
          <div className="flex gap-1.5">
            <button type="submit" className="btn btn-primary btn-xs rounded-lg">
              Add column
            </button>
            <button type="button" onClick={() => setOpen(false)} className="btn btn-ghost btn-xs rounded-lg">
              Cancel
            </button>
          </div>
        </ActionForm>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="border-base-300 text-base-content/50 hover:text-base-content hover:border-primary/40 flex w-full items-center justify-center gap-1.5 rounded-2xl border-2 border-dashed px-3 py-3 text-sm font-medium"
        >
          <PlusIcon className="size-4" /> Add column
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Move dialog — the keyboard and touch path
// ---------------------------------------------------------------------------

function MoveDialog({
  card,
  destinations,
  currentBoardId,
  onClose,
  onMove,
}: {
  card: BoardCard;
  destinations: Destination[];
  currentBoardId: string;
  onClose: () => void;
  onMove: (columnId: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const ordered = [
    ...destinations.filter((destination) => destination.boardId === currentBoardId),
    ...destinations.filter((destination) => destination.boardId !== currentBoardId),
  ];

  return (
    <dialog ref={dialog} className="modal modal-bottom sm:modal-middle" onClose={onClose}>
      <div className="modal-box max-h-[80dvh] rounded-t-3xl sm:rounded-3xl">
        <h3 className="text-base font-semibold">Move “{card.title}”</h3>
        <div className="mt-3 space-y-4">
          {ordered.map((destination) => (
            <div key={destination.boardId}>
              <p className="text-base-content/45 mb-1.5 text-[0.68rem] font-semibold uppercase tracking-[0.12em]">
                {destination.boardId === currentBoardId ? 'This board' : destination.boardName}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {destination.columns.map((column) => (
                  <button
                    key={column.id}
                    type="button"
                    onClick={() => onMove(column.id)}
                    className="btn btn-outline btn-sm rounded-xl"
                  >
                    {column.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="modal-action">
          <button type="button" className="btn btn-ghost btn-sm rounded-xl" onClick={() => dialog.current?.close()}>
            Cancel
          </button>
        </div>
      </div>
      <form method="dialog" className="modal-backdrop">
        <button type="submit" aria-label="Close">close</button>
      </form>
    </dialog>
  );
}
