/** Sorting the card table. Pure, so it is unit-tested on its own. */

export interface TableRow {
  id: string;
  title: string;
  boardId: string;
  boardName?: string;
  columnName: string;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
  estimateMinutes: number;
  deadline: Date | null;
  plannedFor: Date | null;
  completedAt: Date | null;
  labels: Array<{ id: string; name: string; color: string }>;
  checklist: { done: number; total: number };
}

export const SORT_KEYS = ['title', 'board', 'column', 'priority', 'estimate', 'due', 'planned'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

const PRIORITY_RANK = { URGENT: 0, HIGH: 1, MEDIUM: 2, LOW: 3 } as const;

/** Parse `sort=due` / `sort=-due`. Unknown keys fall back to deadline order. */
export function parseSort(value: string | undefined): { key: SortKey; descending: boolean } {
  const descending = value?.startsWith('-') ?? false;
  const key = (value?.replace(/^-/, '') ?? 'due') as SortKey;
  return SORT_KEYS.includes(key) ? { key, descending } : { key: 'due', descending: false };
}

export function sortRows(rows: TableRow[], sort: { key: SortKey; descending: boolean }): TableRow[] {
  const time = (date: Date | null) => (date ? new Date(date).getTime() : Number.POSITIVE_INFINITY);
  const compare = (a: TableRow, b: TableRow): number => {
    switch (sort.key) {
      case 'title':
        return a.title.localeCompare(b.title);
      case 'board':
        return (a.boardName ?? '').localeCompare(b.boardName ?? '');
      case 'column':
        return a.columnName.localeCompare(b.columnName);
      case 'priority':
        return PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
      case 'estimate':
        return a.estimateMinutes - b.estimateMinutes;
      case 'due':
        return time(a.deadline) - time(b.deadline);
      case 'planned':
        return time(a.plannedFor) - time(b.plannedFor);
    }
  };
  // Stable, and undated rows stay last whichever way the sort runs.
  return [...rows].sort((a, b) => (sort.descending ? -compare(a, b) : compare(a, b)) || a.title.localeCompare(b.title));
}
