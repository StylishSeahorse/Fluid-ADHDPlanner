'use client';

/**
 * The interactive pieces of the card panel. The panel itself is a server
 * component; these are the bits that need a click handler.
 */
import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';
import { commitTaskToDay, moveBoardCard, updateCard } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { ActionForm } from './action-form';

/** Escape closes the panel, like every other drawer. */
export function CloseOnEscape({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName);
      if (event.key === 'Escape' && !typing) router.push(href, { scroll: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [href, router]);
  return null;
}

/** Pick the column from the panel — the same move a drag makes. */
export function ColumnPicker({
  taskId,
  current,
  columns,
}: {
  taskId: string;
  current: string | null;
  columns: Array<{ id: string; name: string }>;
}) {
  const [pending, start] = useTransition();
  return (
    <select
      aria-label="Column"
      disabled={pending}
      defaultValue={current ?? ''}
      onChange={(event) => {
        const columnId = event.target.value;
        start(async () => {
          const result = await moveBoardCard({ taskId, columnId });
          if (result.error) logAction(result.error, 'error');
          else logAction(`Moved to ${columns.find((column) => column.id === columnId)?.name ?? 'column'}.`);
        });
      }}
      className="select select-sm select-ghost h-7 min-h-7 w-auto font-medium"
    >
      {columns.map((column) => (
        <option key={column.id} value={column.id}>
          {column.name}
        </option>
      ))}
    </select>
  );
}

/**
 * "Plan for…": the Sunsama gesture, from any card. It sets the day only —
 * never the deadline, the estimate or the column's meaning.
 */
export function PlanForDay({
  taskId,
  plannedKey,
  todayKey,
  tomorrowKey,
}: {
  taskId: string;
  /** The day it is committed to, as YYYY-MM-DD, or null. */
  plannedKey: string | null;
  todayKey: string;
  tomorrowKey: string;
}) {
  const [pending, start] = useTransition();

  const commit = (day: string | null, message: string) =>
    start(async () => {
      const result = await commitTaskToDay({ taskId, day });
      if (result.error) logAction(result.error, 'error');
      else logAction(message);
    });

  const chip = (key: string, label: string) => (
    <button
      type="button"
      disabled={pending}
      onClick={() => commit(key, `Planned for ${label.toLowerCase()}.`)}
      className={`btn btn-xs rounded-lg ${plannedKey === key ? 'btn-primary' : 'btn-outline'}`}
      aria-pressed={plannedKey === key}
    >
      {label}
    </button>
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {chip(todayKey, 'Today')}
      {chip(tomorrowKey, 'Tomorrow')}
      <input
        type="date"
        aria-label="Plan for a day"
        value={plannedKey && plannedKey !== todayKey && plannedKey !== tomorrowKey ? plannedKey : ''}
        min={todayKey}
        disabled={pending}
        onChange={(event) => event.target.value && commit(event.target.value, 'Planned.')}
        className="input input-xs w-36 rounded-lg"
      />
      {plannedKey ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => commit(null, 'Taken off the day.')}
          className="btn btn-ghost btn-xs rounded-lg"
        >
          Clear
        </button>
      ) : null}
    </div>
  );
}

/** The card title: edit in place, saved when focus leaves it. */
export function TitleEditor({ taskId, title, done }: { taskId: string; title: string; done: boolean }) {
  return (
    <ActionForm action={updateCard} reset={false}>
      <input type="hidden" name="id" value={taskId} />
      <textarea
        name="title"
        defaultValue={title}
        rows={1}
        maxLength={255}
        required
        aria-label="Title"
        className={`field-sizing-content w-full resize-none bg-transparent text-xl font-bold leading-snug tracking-tight outline-none focus:ring-0 ${
          done ? 'text-base-content/60 line-through' : ''
        }`}
        onBlur={(event) => {
          if (event.currentTarget.value.trim() !== title) event.currentTarget.form?.requestSubmit();
        }}
        onKeyDown={(event) => {
          // Enter saves; a title is one line.
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
    </ActionForm>
  );
}
