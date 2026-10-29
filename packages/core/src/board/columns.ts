/**
 * What a column means for the work in it.
 *
 * A column's category maps onto the task status the scheduler already reads,
 * so moving a card on a board changes what gets scheduled without the
 * scheduler knowing boards exist: To do and Doing are schedulable, Backlog is
 * not, Done is finished.
 */
import type { ColumnCategory } from './query';

export type TaskStatusName = 'BACKLOG' | 'READY' | 'IN_PROGRESS' | 'BLOCKED' | 'DONE' | 'CANCELLED';

export const DEFAULT_COLUMNS: Array<{ name: string; category: ColumnCategory }> = [
  { name: 'Backlog', category: 'BACKLOG' },
  { name: 'To do', category: 'TODO' },
  { name: 'Doing', category: 'IN_PROGRESS' },
  { name: 'Done', category: 'DONE' },
];

/** What dropping a card into a column of this category does to its status. */
export function statusForCategory(category: ColumnCategory): TaskStatusName {
  switch (category) {
    case 'BACKLOG':
      return 'BACKLOG';
    case 'TODO':
      return 'READY';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'DONE':
      return 'DONE';
  }
}

/**
 * Which column a task with this status starts in when it is first placed on
 * a board. Blocked work waits in To do — "blocked" is a fact about its
 * dependencies, shown on the card, not a place on the board.
 */
export function categoryForStatus(status: TaskStatusName): ColumnCategory {
  switch (status) {
    case 'BACKLOG':
      return 'BACKLOG';
    case 'IN_PROGRESS':
      return 'IN_PROGRESS';
    case 'DONE':
    case 'CANCELLED':
      return 'DONE';
    case 'READY':
    case 'BLOCKED':
      return 'TODO';
  }
}
