/**
 * The card panel: everything about one card, beside the board.
 *
 * Opened by `?card=…`, so a card has a URL — shareable, bookmarkable, and the
 * back button closes it. The board stays visible behind it on a laptop; on a
 * phone it takes the screen.
 */
import Link from 'next/link';
import {
  addChecklistItem,
  addComment,
  createLabel,
  deleteChecklistItem,
  deleteComment,
  promoteChecklistItem,
  restoreBoardCard,
  toggleCardLabel,
  toggleChecklistItem,
  trashBoardCard,
  updateCard,
} from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { ConfirmButton } from '@/components/confirm-button';
import { formatDuration } from '@/components/format';
import { CheckIcon, XIcon } from '@/components/icons';
import { LABEL_COLORS, LABEL_SWATCH, chipClass } from '@/components/label-colors';
import type { getCaller } from '@/server/caller';
import { ActionForm } from './action-form';
import { Attachments } from './attachments';
import { CloseOnEscape, ColumnPicker, PlanForDay, TitleEditor } from './card-controls';

/** The card as the server caller returns it — Dates intact, no serialisation. */
type Caller = Awaited<ReturnType<typeof getCaller>>;
type CardData = NonNullable<Awaited<ReturnType<Caller['kanban']['card']>>>;

const PRIORITIES = [
  { value: 'LOW', label: 'Low' },
  { value: 'MEDIUM', label: 'Medium' },
  { value: 'HIGH', label: 'High' },
  { value: 'URGENT', label: 'Urgent' },
] as const;

function dateKey(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(instant);
}

/** Deadlines are stored as the start of the day after; show the day itself. */
function deadlineKey(deadline: Date, timeZone: string): string {
  return dateKey(new Date(deadline.getTime() - 60_000), timeZone);
}

function stamp(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(instant);
}

export function CardPanel({
  card,
  closeHref,
  columns,
  labels,
  timeZone,
  todayKey,
  tomorrowKey,
  userId,
  maxUploadMb,
}: {
  maxUploadMb: number;
  card: CardData | null;
  closeHref: string;
  columns: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  timeZone: string;
  todayKey: string;
  tomorrowKey: string;
  userId: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label="Card">
      <CloseOnEscape href={closeHref} />
      <Link href={closeHref} scroll={false} className="absolute inset-0 bg-black/20 backdrop-blur-[1px]" aria-label="Close card" />

      <aside className="bg-base-100 relative flex h-full w-full max-w-xl flex-col shadow-2xl sm:rounded-l-3xl">
        {card ? (
          <Body
            card={card}
            closeHref={closeHref}
            columns={columns}
            labels={labels}
            timeZone={timeZone}
            todayKey={todayKey}
            tomorrowKey={tomorrowKey}
            userId={userId}
            maxUploadMb={maxUploadMb}
          />
        ) : (
          <div className="p-6">
            <div className="flex justify-end">
              <Link href={closeHref} scroll={false} className="btn btn-ghost btn-sm btn-square rounded-xl" aria-label="Close">
                <XIcon />
              </Link>
            </div>
            <p className="mt-6 font-semibold">This card isn’t here any more.</p>
            <p className="text-base-content/60 mt-1 text-sm">
              If it was deleted, it’s in the board’s trash for 30 days and can be restored from there.
            </p>
          </div>
        )}
      </aside>
    </div>
  );
}

function Section({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="border-base-200 border-t px-5 py-4 sm:px-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-base-content/45 text-[0.68rem] font-semibold uppercase tracking-[0.14em]">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Body({
  card,
  closeHref,
  columns,
  labels,
  timeZone,
  todayKey,
  tomorrowKey,
  userId,
  maxUploadMb,
}: {
  maxUploadMb: number;
  card: CardData;
  closeHref: string;
  columns: Array<{ id: string; name: string }>;
  labels: Array<{ id: string; name: string; color: string }>;
  timeZone: string;
  todayKey: string;
  tomorrowKey: string;
  userId: string;
}) {
  const done = card.completedAt !== null;
  const checked = card.checklistItems.filter((item) => item.checkedAt).length;
  const onCard = new Set(card.labels.map((label) => label.id));

  return (
    <>
      {/* --- Header ----------------------------------------------------- */}
      <header className="flex items-center gap-2 px-5 pb-2 pt-4 sm:px-6">
        <span className="text-base-content/50 min-w-0 truncate text-xs">{card.board?.name ?? 'No board'}</span>
        <span className="text-base-content/30 text-xs">›</span>
        {card.board ? <ColumnPicker taskId={card.id} current={card.columnId} columns={columns} /> : null}
        <Link href={closeHref} scroll={false} className="btn btn-ghost btn-sm btn-square ml-auto rounded-xl" aria-label="Close card">
          <XIcon />
        </Link>
      </header>

      <div className="grow overflow-y-auto pb-10">
        {/* --- Title -------------------------------------------------- */}
        <div className="px-5 pb-4 sm:px-6">
          <TitleEditor taskId={card.id} title={card.title} done={done} />
          {done ? (
            <p className="text-success mt-1 inline-flex items-center gap-1 text-sm font-medium">
              <CheckIcon className="size-4" /> Finished {stamp(card.completedAt!, timeZone)}
            </p>
          ) : null}
        </div>

        {/* --- When --------------------------------------------------- */}
        <Section title="Plan">
          <div className="space-y-3">
            <div>
              <p className="text-base-content/60 mb-1.5 text-xs">Which day you’ll do it</p>
              <PlanForDay
                taskId={card.id}
                plannedKey={card.plannedFor ? dateKey(card.plannedFor, timeZone) : null}
                todayKey={todayKey}
                tomorrowKey={tomorrowKey}
              />
            </div>

            <ActionForm action={updateCard} reset={false} success="Saved." className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <input type="hidden" name="id" value={card.id} />
              <label className="text-base-content/60 text-xs">
                Due
                <input
                  type="date"
                  name="deadline"
                  defaultValue={card.deadline ? deadlineKey(card.deadline, timeZone) : ''}
                  className="input input-sm mt-1 w-full"
                />
              </label>
              <label className="text-base-content/60 text-xs">
                Estimate (min)
                <input
                  type="number"
                  name="estimateMinutes"
                  min={5}
                  max={10080}
                  step={5}
                  defaultValue={card.estimateMinutes}
                  className="input input-sm mt-1 w-full"
                />
              </label>
              <label className="text-base-content/60 text-xs">
                Priority
                <select name="priority" defaultValue={card.priority} className="select select-sm mt-1 w-full">
                  {PRIORITIES.map((priority) => (
                    <option key={priority.value} value={priority.value}>
                      {priority.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="col-span-full">
                <button type="submit" className="btn btn-primary btn-xs rounded-lg">
                  Save
                </button>
              </div>
            </ActionForm>

            {card.scheduledBlocks.length > 0 ? (
              <div>
                <p className="text-base-content/60 mb-1 text-xs">Sessions</p>
                <ul className="space-y-1">
                  {card.scheduledBlocks.map((block) => (
                    <li key={block.id} className="flex items-center gap-2 text-sm">
                      <span className="font-medium">{stamp(block.startsAt, timeZone)}</span>
                      <span className="text-base-content/50">
                        {formatDuration((block.endsAt.getTime() - block.startsAt.getTime()) / 60_000)}
                      </span>
                      {block.state === 'PROPOSED' ? <span className="badge badge-xs badge-soft badge-warning">proposed</span> : null}
                      {block.isPinned ? <span className="badge badge-xs badge-ghost">pinned</span> : null}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <p className="text-base-content/50 text-xs">
                No sessions yet. Plan it for a day, then “Find time” on Today or Week places it around your meetings.
              </p>
            )}
          </div>
        </Section>

        {/* --- Labels ------------------------------------------------- */}
        <Section title="Labels">
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label) => (
              <LoggedActionButton
                key={label.id}
                action={toggleCardLabel}
                fields={{ taskId: card.id, labelId: label.id }}
                successMessage={onCard.has(label.id) ? `Removed “${label.name}”.` : `Added “${label.name}”.`}
                className={`rounded-lg px-2 py-1 text-xs font-semibold transition-opacity ${chipClass(label.color)} ${
                  onCard.has(label.id) ? 'ring-base-content/30 ring-2' : 'opacity-45 hover:opacity-100'
                }`}
              >
                {label.name}
              </LoggedActionButton>
            ))}
          </div>
          <details className="mt-2">
            <summary className="text-base-content/55 hover:text-base-content cursor-pointer text-xs">New label…</summary>
            <ActionForm action={createLabel} success="Label added." className="mt-2 space-y-2">
              <input type="hidden" name="taskId" value={card.id} />
              <input name="name" required maxLength={40} placeholder="e.g. client, waiting, quick win" className="input input-sm w-full" />
              <fieldset className="flex flex-wrap gap-1.5" aria-label="Colour">
                {LABEL_COLORS.map((color, index) => (
                  <label key={color} className="cursor-pointer">
                    <input type="radio" name="color" value={color} defaultChecked={index === 0} className="peer sr-only" />
                    <span
                      className={`block size-6 rounded-full ${LABEL_SWATCH[color]} ring-offset-base-100 peer-checked:ring-base-content peer-checked:ring-2 peer-checked:ring-offset-2 peer-focus-visible:ring-2`}
                      title={color}
                    />
                  </label>
                ))}
              </fieldset>
              <button type="submit" className="btn btn-primary btn-xs rounded-lg">
                Add label
              </button>
            </ActionForm>
          </details>
        </Section>

        {/* --- Description -------------------------------------------- */}
        <Section title="Description">
          <ActionForm action={updateCard} reset={false} success="Description saved." className="space-y-2">
            <input type="hidden" name="id" value={card.id} />
            <textarea
              name="notes"
              defaultValue={card.notes ?? ''}
              rows={4}
              maxLength={20000}
              placeholder="Notes, links, what “done” looks like…"
              className="textarea field-sizing-content min-h-24 w-full text-sm"
            />
            <button type="submit" className="btn btn-outline btn-xs rounded-lg">
              Save description
            </button>
          </ActionForm>
        </Section>

        {/* --- Files -------------------------------------------------- */}
        <Section title="Files">
          <Attachments taskId={card.id} attachments={card.attachments} maxMb={maxUploadMb} />
        </Section>

        {/* --- Checklist ---------------------------------------------- */}
        <Section
          title="Checklist"
          aside={
            card.checklistItems.length > 0 ? (
              <span className="text-base-content/50 text-xs">
                {checked}/{card.checklistItems.length}
              </span>
            ) : null
          }
        >
          {card.checklistItems.length > 0 ? (
            <>
              <progress
                className="progress progress-primary mb-2 h-1.5 w-full"
                value={checked}
                max={card.checklistItems.length}
                aria-label="Checklist progress"
              />
              <ul className="mb-2 space-y-0.5">
                {card.checklistItems.map((item) => (
                  <li key={item.id} className="group flex items-center gap-2 rounded-lg px-1 py-1 hover:bg-base-200/60">
                    <LoggedActionButton
                      action={toggleChecklistItem}
                      fields={{ id: item.id }}
                      successMessage={item.checkedAt ? 'Unticked.' : 'Ticked.'}
                      className={`grid size-4 shrink-0 place-items-center rounded border-2 ${
                        item.checkedAt ? 'bg-primary border-primary text-white' : 'border-base-300 hover:border-primary'
                      }`}
                    >
                      {item.checkedAt ? <CheckIcon className="size-2.5" /> : <span className="sr-only">Tick</span>}
                    </LoggedActionButton>
                    <span className={`min-w-0 grow text-sm ${item.checkedAt ? 'text-base-content/50 line-through' : ''}`}>
                      {item.text}
                    </span>
                    <span className="flex shrink-0 gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                      <LoggedActionButton
                        action={promoteChecklistItem}
                        fields={{ id: item.id }}
                        successMessage={`Made “${item.text}” a subtask.`}
                        className="btn btn-ghost btn-xs rounded-lg"
                      >
                        Make subtask
                      </LoggedActionButton>
                      <LoggedActionButton
                        action={deleteChecklistItem}
                        fields={{ id: item.id }}
                        successMessage="Removed."
                        className="btn btn-ghost btn-xs btn-square rounded-lg"
                      >
                        <XIcon className="size-3.5" />
                        <span className="sr-only">Remove “{item.text}”</span>
                      </LoggedActionButton>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          <ActionForm action={addChecklistItem} className="flex gap-2">
            <input type="hidden" name="taskId" value={card.id} />
            <input name="text" required maxLength={500} placeholder="Add an item" className="input input-sm grow" />
            <button type="submit" className="btn btn-outline btn-sm rounded-lg">
              Add
            </button>
          </ActionForm>
        </Section>

        {card.subtasks.length > 0 || card.blockedBy.length > 0 ? (
          <Section title="Related work">
            {card.subtasks.length > 0 ? (
              <ul className="mb-2 space-y-1">
                {card.subtasks.map((subtask) => (
                  <li key={subtask.id} className="flex items-center gap-2 text-sm">
                    <span className={subtask.status === 'DONE' ? 'text-base-content/50 line-through' : ''}>{subtask.title}</span>
                    <span className="text-base-content/40 text-xs">{formatDuration(subtask.estimateMinutes)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {card.blockedBy.length > 0 ? (
              <p className="text-sm">
                <span className="text-base-content/60">Waiting on: </span>
                {card.blockedBy.map((dependency) => dependency.prerequisite.title).join(', ')}
              </p>
            ) : null}
          </Section>
        ) : null}

        {/* --- Comments ----------------------------------------------- */}
        <Section title="Comments">
          {card.comments.length > 0 ? (
            <ul className="mb-3 space-y-3">
              {card.comments.map((comment) => (
                <li key={comment.id} className="text-sm">
                  <div className="text-base-content/50 flex items-center gap-2 text-xs">
                    <span className="font-medium">{comment.author?.email.split('@')[0] ?? 'Former member'}</span>
                    <span>{stamp(comment.createdAt, timeZone)}</span>
                    {comment.authorId === userId ? (
                      <ConfirmButton
                        action={deleteComment}
                        fields={{ id: comment.id }}
                        label="Delete"
                        confirmLabel="Delete it?"
                        successMessage="Comment deleted."
                        className="btn btn-ghost btn-xs ml-auto rounded-lg"
                        confirmClassName="btn btn-error btn-xs ml-auto rounded-lg"
                      />
                    ) : null}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap">{comment.body}</p>
                </li>
              ))}
            </ul>
          ) : null}
          <ActionForm action={addComment} success="Comment posted." className="space-y-2">
            <input type="hidden" name="taskId" value={card.id} />
            <textarea name="body" required rows={2} maxLength={10000} placeholder="Write a comment…" className="textarea field-sizing-content w-full text-sm" />
            <button type="submit" className="btn btn-outline btn-xs rounded-lg">
              Comment
            </button>
          </ActionForm>
        </Section>

        {/* --- Activity ----------------------------------------------- */}
        <Section title="Activity">
          {card.activity.length > 0 ? (
            <ol className="space-y-1.5">
              {card.activity.map((event) => (
                <li key={event.id} className="text-base-content/70 flex gap-2 text-xs">
                  <span className="text-base-content/40 w-24 shrink-0">{stamp(event.createdAt, timeZone)}</span>
                  <span>{event.summary}</span>
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-base-content/50 text-xs">Nothing recorded yet.</p>
          )}
        </Section>

        <section className="px-5 pt-2 sm:px-6">
          <ConfirmButton
            action={trashBoardCard}
            fields={{ id: card.id }}
            label="Delete card"
            confirmLabel="Delete — restorable for 30 days"
            successMessage={`Deleted “${card.title}”. It’s in the board’s trash.`}
            className="btn btn-ghost btn-sm text-error rounded-xl"
            confirmClassName="btn btn-error btn-sm rounded-xl"
          />
        </section>
      </div>
    </>
  );
}

/** The board's trash, with one-tap restore. */
export function TrashList({ items, timeZone }: { items: Array<{ id: string; title: string; trashedAt: Date }>; timeZone: string }) {
  if (items.length === 0) return <p className="text-base-content/50 text-sm">Nothing deleted recently.</p>;
  return (
    <ul className="divide-base-200 divide-y">
      {items.map((item) => (
        <li key={item.id} className="flex items-center gap-3 py-2">
          <span className="min-w-0 grow truncate text-sm">{item.title}</span>
          <span className="text-base-content/45 shrink-0 text-xs">{stamp(item.trashedAt, timeZone)}</span>
          <LoggedActionButton
            action={restoreBoardCard}
            fields={{ id: item.id }}
            successMessage={`Restored “${item.title}”.`}
            className="btn btn-outline btn-xs shrink-0 rounded-lg"
          >
            Restore
          </LoggedActionButton>
        </li>
      ))}
    </ul>
  );
}
