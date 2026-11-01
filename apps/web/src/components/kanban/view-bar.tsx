/**
 * Above a board or the all-cards list: Board/Table switch, saved views, and
 * "save this view" when there is something worth saving.
 */
import Link from 'next/link';
import { deleteView, saveView } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { BoardIcon, ListIcon, XIcon } from '@/components/icons';
import { ActionForm } from './action-form';

export function ViewBar({
  basePath,
  boardId,
  q,
  layout,
  sort,
  views,
  showLayoutSwitch = true,
  children,
}: {
  basePath: string;
  boardId: string | null;
  q: string;
  layout: 'board' | 'table';
  sort?: string;
  views: Array<{ id: string; name: string; query: string; layout: string }>;
  showLayoutSwitch?: boolean;
  /** Extra controls at the end of the bar. */
  children?: React.ReactNode;
}) {
  const href = (params: { q?: string; view?: string; sort?: string }) => {
    const query = new URLSearchParams();
    if (params.q) query.set('q', params.q);
    if (params.view && params.view !== 'board') query.set('view', params.view);
    if (params.sort) query.set('sort', params.sort);
    const text = query.toString();
    return text ? `${basePath}?${text}` : basePath;
  };
  const active = views.find((view) => view.query === q && view.layout === layout);

  return (
    <div className="mb-4 flex flex-wrap items-center gap-2">
      {showLayoutSwitch ? (
        <div className="join" role="group" aria-label="Layout">
          <Link
            href={href({ q, view: 'board' })}
            className={`btn btn-sm join-item gap-1.5 ${layout === 'board' ? 'btn-primary btn-soft' : 'btn-ghost'}`}
            aria-current={layout === 'board' ? 'page' : undefined}
          >
            <BoardIcon className="size-4" /> Board
          </Link>
          <Link
            href={href({ q, view: 'table', ...(sort ? { sort } : {}) })}
            className={`btn btn-sm join-item gap-1.5 ${layout === 'table' ? 'btn-primary btn-soft' : 'btn-ghost'}`}
            aria-current={layout === 'table' ? 'page' : undefined}
          >
            <ListIcon className="size-4" /> Table
          </Link>
        </div>
      ) : null}

      {views.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-1.5" aria-label="Saved views">
          {views.map((view) => (
            <li key={view.id} className="group flex items-center">
              <Link
                href={href({ q: view.query, view: view.layout })}
                className={`btn btn-xs rounded-lg ${active?.id === view.id ? 'btn-primary' : 'btn-outline'}`}
              >
                {view.name}
              </Link>
              <LoggedActionButton
                action={deleteView}
                fields={{ id: view.id }}
                successMessage={`Removed the view “${view.name}”.`}
                className="btn btn-ghost btn-xs btn-square text-base-content/40 rounded-lg opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
              >
                <XIcon className="size-3" />
                <span className="sr-only">Remove view {view.name}</span>
              </LoggedActionButton>
            </li>
          ))}
        </ul>
      ) : null}

      {(q || layout === 'table') && !active ? (
        <details className="dropdown">
          <summary className="btn btn-ghost btn-xs list-none rounded-lg [&::-webkit-details-marker]:hidden">Save this view…</summary>
          <div className="dropdown-content bg-base-100 border-base-200 z-30 mt-1 w-64 rounded-2xl border p-3 shadow-xl">
            <ActionForm action={saveView} success="View saved." className="space-y-2">
              <input type="hidden" name="boardId" value={boardId ?? ''} />
              <input type="hidden" name="query" value={q} />
              <input type="hidden" name="layout" value={layout} />
              <input name="name" required maxLength={60} placeholder="e.g. Client work this week" className="input input-sm w-full" />
              <p className="text-base-content/50 text-xs">{q ? `Filter: ${q}` : 'All cards'} · {layout}</p>
              <button type="submit" className="btn btn-primary btn-xs rounded-lg">
                Save view
              </button>
            </ActionForm>
          </div>
        </details>
      ) : null}

      {children ? <div className="ml-auto flex items-center gap-2">{children}</div> : null}
    </div>
  );
}
