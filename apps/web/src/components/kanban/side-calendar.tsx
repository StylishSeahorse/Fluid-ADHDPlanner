'use client';

/**
 * The side calendar: this week beside a project board, so work can be put on
 * a day without leaving the board.
 *
 * Each day is a drop target. Dropping a card plans it for that day — the same
 * `plannedFor` the Week board and "Plan for…" set, never a copy — and the
 * day's bar moves at once, which is the moment the number is being read.
 * Cards already on a day can be dragged to another. Keyboards and touch use
 * "Plan for…" on the card itself; this panel is the fast path, not the only one.
 */
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState, useTransition } from 'react';
import { commitTaskToDay } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { Estimate } from '@/components/estimate';
import { formatDuration } from '@/components/format';
import { CalendarIcon, XIcon } from '@/components/icons';

/** A calendar chip's drag type. Not text/plain, so the board's columns ignore it. */
const DAY_CARD_TYPE = 'application/x-fluid-day-card';

export interface SideCalendarCard {
  id: string;
  title: string;
  estimateMinutes: number;
  estimateAssumed: boolean;
  done: boolean;
  /** "09:30" when the scheduler has placed it on this day. */
  time: string | null;
  href: string | null;
}

export interface SideCalendarDay {
  key: string;
  weekday: string;
  dayNumber: string;
  isToday: boolean;
  capacityMinutes: number;
  plannedMinutes: number;
  meetingMinutes: number;
  hasWorkingHours: boolean;
  isNonWorkingDay: boolean;
  cards: SideCalendarCard[];
}

export function SideCalendar({ days, closeHref }: { days: SideCalendarDay[]; closeHref: string }) {
  const router = useRouter();
  const [over, setOver] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const plan = (taskId: string, day: SideCalendarDay, title?: string) => {
    startTransition(async () => {
      const result = await commitTaskToDay({ taskId, day: day.key });
      if (result.error) {
        logAction(result.error, 'error');
        return;
      }
      logAction(`Planned ${title ? `“${title}”` : 'it'} for ${day.isToday ? 'today' : `${day.weekday} ${day.dayNumber}`}.`, 'success');
      router.refresh();
    });
  };

  return (
    <aside
      aria-label="This week"
      aria-busy={pending}
      className="border-base-200 bg-base-100 mb-4 rounded-2xl border p-3 shadow-sm xl:sticky xl:top-4 xl:mb-0 xl:w-72 xl:shrink-0"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold">
          <CalendarIcon className="size-4" /> This week
        </h2>
        <Link href={closeHref} scroll={false} className="btn btn-ghost btn-xs btn-square rounded-lg" aria-label="Hide the calendar (C)">
          <XIcon className="size-3.5" />
        </Link>
      </div>
      <p className="text-base-content/50 mb-3 text-xs">Drag a card onto a day to plan it.</p>

      <ol className="flex gap-2 overflow-x-auto pb-1 xl:flex-col xl:overflow-visible xl:pb-0">
        {days.map((day) => {
          const over100 = day.hasWorkingHours && !day.isNonWorkingDay && day.plannedMinutes > day.capacityMinutes;
          const fill = day.capacityMinutes > 0 ? Math.min(100, (day.plannedMinutes / day.capacityMinutes) * 100) : 0;
          const open = day.cards.filter((card) => !card.done);
          return (
            <li
              key={day.key}
              data-day={day.key}
              className={`min-w-44 shrink-0 rounded-xl border p-2 transition-colors xl:min-w-0 ${
                over === day.key ? 'border-primary bg-primary/5 ring-primary/20 ring-2' : day.isToday ? 'border-primary/40' : 'border-base-200'
              }`}
              onDragOver={(event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                if (over !== day.key) setOver(day.key);
              }}
              onDragLeave={() => setOver((current) => (current === day.key ? null : current))}
              onDrop={(event) => {
                event.preventDefault();
                setOver(null);
                const taskId = event.dataTransfer.getData(DAY_CARD_TYPE) || event.dataTransfer.getData('text/plain');
                if (!taskId) return;
                if (day.cards.some((card) => card.id === taskId)) return;
                plan(taskId, day);
              }}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold">
                  {day.isToday ? 'Today' : day.weekday} <span className="text-base-content/45 font-normal">{day.dayNumber}</span>
                </p>
                <p className={`text-xs tabular-nums ${over100 ? 'text-error font-semibold' : 'text-base-content/50'}`}>
                  {day.isNonWorkingDay
                    ? day.plannedMinutes > 0
                      ? `${formatDuration(day.plannedMinutes)} · day off`
                      : 'Day off'
                    : day.hasWorkingHours
                      ? `${formatDuration(day.plannedMinutes)} of ${formatDuration(day.capacityMinutes)}`
                      : formatDuration(day.plannedMinutes)}
                </p>
              </div>
              {day.hasWorkingHours && !day.isNonWorkingDay ? (
                <div className="bg-base-200 mt-1 h-1.5 overflow-hidden rounded-full" aria-hidden="true">
                  <div className={`h-full rounded-full ${over100 ? 'bg-error' : 'bg-primary'}`} style={{ width: `${fill}%` }} />
                </div>
              ) : null}
              {day.meetingMinutes > 0 ? (
                <p className="text-base-content/45 mt-1 text-[0.68rem]">{formatDuration(day.meetingMinutes)} of meetings</p>
              ) : null}

              {open.length > 0 ? (
                <ul className="mt-2 space-y-1">
                  {open.map((card) => (
                    <li
                      key={card.id}
                      draggable
                      onDragStart={(event) => {
                        event.dataTransfer.setData(DAY_CARD_TYPE, card.id);
                        event.dataTransfer.effectAllowed = 'move';
                      }}
                      className="bg-base-200/60 flex cursor-grab items-center gap-1.5 rounded-lg px-2 py-1 text-xs"
                    >
                      {card.time ? <span className="text-base-content/45 font-mono tabular-nums">{card.time}</span> : null}
                      {card.href ? (
                        <Link href={card.href} scroll={false} className="min-w-0 grow truncate hover:underline">
                          {card.title}
                        </Link>
                      ) : (
                        <span className="min-w-0 grow truncate">{card.title}</span>
                      )}
                      <Estimate minutes={card.estimateMinutes} assumed={card.estimateAssumed} className="text-base-content/45 shrink-0" />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-base-content/35 mt-2 text-xs">Nothing planned</p>
              )}
            </li>
          );
        })}
      </ol>
    </aside>
  );
}

/** `C` shows or hides the calendar, as long as nobody is typing. */
export function CalendarShortcut({ href }: { href: string }) {
  const router = useRouter();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'c' && event.key !== 'C') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof HTMLElement && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return;
      event.preventDefault();
      router.replace(href, { scroll: false });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [href, router]);
  return null;
}
