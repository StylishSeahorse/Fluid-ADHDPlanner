/**
 * Cards as a table: the same cards and the same filters as the board, read
 * as rows. Sorting is a URL parameter, so a sorted table survives a refresh
 * and can be saved as a view.
 */
import Link from 'next/link';
import { formatDuration, relativeDays } from '@/components/format';
import { CheckIcon } from '@/components/icons';
import { chipClass } from '@/components/label-colors';
import { type SortKey, type TableRow } from './card-sort';

export { parseSort, sortRows, SORT_KEYS, type SortKey, type TableRow } from './card-sort';

function shortDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short' }).format(new Date(date));
}

export function CardTable({
  rows,
  sort,
  hrefFor,
  cardHref,
  timeZone,
  showBoard,
}: {
  rows: TableRow[];
  sort: { key: SortKey; descending: boolean };
  /** The current URL with a different sort. */
  hrefFor: (sort: string) => string;
  cardHref: (row: TableRow) => string;
  timeZone: string;
  showBoard?: boolean;
}) {
  const header = (key: SortKey, label: string, className = '') => {
    const active = sort.key === key;
    const next = active && !sort.descending ? `-${key}` : key;
    return (
      <th className={className} aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}>
        <Link href={hrefFor(next)} scroll={false} className={`inline-flex items-center gap-1 ${active ? 'text-base-content' : ''}`}>
          {label}
          {active ? <span aria-hidden="true">{sort.descending ? '↓' : '↑'}</span> : null}
        </Link>
      </th>
    );
  };

  if (rows.length === 0) {
    return <p className="text-base-content/55 py-10 text-center text-sm">No cards match.</p>;
  }

  return (
    <div className="border-base-200 bg-base-100 overflow-x-auto rounded-2xl border shadow-sm">
      <table className="table-sm table">
        <thead className="text-base-content/55">
          <tr>
            {header('title', 'Card', 'min-w-56')}
            {showBoard ? header('board', 'Board') : null}
            {header('column', 'Column')}
            {header('priority', 'Priority')}
            {header('estimate', 'Estimate')}
            {header('due', 'Due')}
            {header('planned', 'Planned')}
            <th>Labels</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const done = row.completedAt !== null;
            const overdue = !done && row.deadline !== null && new Date(row.deadline).getTime() < Date.now();
            return (
              <tr key={row.id} className="hover:bg-base-200/50">
                <td>
                  <Link href={cardHref(row)} scroll={false} className={`flex items-center gap-1.5 font-medium ${done ? 'text-base-content/50 line-through' : ''}`}>
                    {done ? <CheckIcon className="text-success size-3.5 shrink-0" /> : null}
                    {row.title}
                  </Link>
                  {row.checklist.total > 0 ? (
                    <span className="text-base-content/45 text-xs">
                      {row.checklist.done}/{row.checklist.total} checklist
                    </span>
                  ) : null}
                </td>
                {showBoard ? <td className="text-base-content/70 whitespace-nowrap">{row.boardName}</td> : null}
                <td className="text-base-content/70 whitespace-nowrap">{row.columnName}</td>
                <td className="whitespace-nowrap">
                  <span className={row.priority === 'URGENT' ? 'text-error font-semibold' : row.priority === 'HIGH' ? 'font-semibold' : 'text-base-content/60'}>
                    {row.priority.charAt(0) + row.priority.slice(1).toLowerCase()}
                  </span>
                </td>
                <td className="text-base-content/70 whitespace-nowrap">{formatDuration(row.estimateMinutes)}</td>
                <td className={`whitespace-nowrap ${overdue ? 'text-error font-semibold' : 'text-base-content/70'}`}>
                  {row.deadline ? relativeDays(row.deadline) : '—'}
                </td>
                <td className="text-base-content/70 whitespace-nowrap">{row.plannedFor ? shortDate(row.plannedFor, timeZone) : '—'}</td>
                <td>
                  <span className="flex flex-wrap gap-1">
                    {row.labels.map((label) => (
                      <span key={label.id} className={`rounded-md px-1.5 py-0.5 text-[0.65rem] font-semibold ${chipClass(label.color)}`}>
                        {label.name}
                      </span>
                    ))}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
