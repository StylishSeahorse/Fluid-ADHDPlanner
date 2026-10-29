/**
 * The card search grammar.
 *
 * One small language for every filter box in the app, modelled on Nextcloud
 * Deck's documented search operators (`tag:`, `list:`, `date:overdue`) with a
 * few planner-specific additions (`planned:`, `estimate:`):
 *
 *     report label:client -status:done due:<2026-11-07 "exact phrase"
 *
 * Words are ANDed. `-` negates. Quotes keep spaces. Anything that is not a
 * known `key:` is plain text, so typing a URL or "10:30" never errors — a
 * search box that rejects input is one people stop using.
 *
 * Pure: the result is a structure, not SQL. Turning it into a query (and
 * resolving "today" in the user's time zone) is the caller's job.
 */

export type ColumnCategory = 'BACKLOG' | 'TODO' | 'IN_PROGRESS' | 'DONE';
export type QueryPriority = 'LOW' | 'MEDIUM' | 'HIGH' | 'URGENT';
export type Comparison = '<' | '<=' | '>' | '>=' | '=';

export type DueFilter =
  | { kind: 'overdue' | 'today' | 'tomorrow' | 'week' | 'month' | 'none' | 'any' }
  | { kind: 'compare'; op: Comparison; date: string };

export type PlannedFilter = { kind: 'today' | 'tomorrow' | 'week' | 'none' | 'any' };

export interface CardQuery {
  text: string[];
  excludeText: string[];
  labels: string[];
  excludeLabels: string[];
  columns: string[];
  boards: string[];
  projects: string[];
  status: ColumnCategory[];
  excludeStatus: ColumnCategory[];
  priority: { op: Comparison; value: QueryPriority } | null;
  due: DueFilter | null;
  planned: PlannedFilter | null;
  estimate: { kind: 'none' } | { kind: 'compare'; op: Comparison; minutes: number } | null;
  blocked: boolean | null;
}

export const PRIORITY_ORDER: QueryPriority[] = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'];

const STATUS_WORDS: Record<string, ColumnCategory> = {
  backlog: 'BACKLOG',
  todo: 'TODO',
  'to-do': 'TODO',
  ready: 'TODO',
  doing: 'IN_PROGRESS',
  progress: 'IN_PROGRESS',
  'in-progress': 'IN_PROGRESS',
  done: 'DONE',
  complete: 'DONE',
  completed: 'DONE',
};

export function emptyQuery(): CardQuery {
  return {
    text: [],
    excludeText: [],
    labels: [],
    excludeLabels: [],
    columns: [],
    boards: [],
    projects: [],
    status: [],
    excludeStatus: [],
    priority: null,
    due: null,
    planned: null,
    estimate: null,
    blocked: null,
  };
}

/** Is there anything to filter on at all? */
export function isEmptyQuery(query: CardQuery): boolean {
  return JSON.stringify(query) === JSON.stringify(emptyQuery());
}

interface Token {
  negated: boolean;
  key: string | null;
  value: string;
}

/** Split on spaces, keeping `"quoted phrases"` and `key:"quoted values"` whole. */
function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  const pattern = /(-)?(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

  for (const match of input.matchAll(pattern)) {
    const [, minus, key, quoted, bare] = match;
    const value = (quoted ?? bare ?? '').trim();
    if (!value && !key) continue;
    tokens.push({ negated: Boolean(minus), key: key ? key.toLowerCase() : null, value });
  }
  return tokens;
}

function comparison(value: string): { op: Comparison; rest: string } {
  const match = /^(<=|>=|<|>|=)?(.*)$/.exec(value)!;
  return { op: (match[1] as Comparison | undefined) ?? '=', rest: match[2]!.trim() };
}

/** "90", "90m", "1h", "1h30", "1.5h" → minutes. */
export function parseMinutes(value: string): number | null {
  const text = value.trim().toLowerCase();
  const hours = /^(\d+(?:\.\d+)?)h(?:(\d+)m?)?$/.exec(text);
  if (hours) return Math.round(Number(hours[1]) * 60 + Number(hours[2] ?? 0));
  const minutes = /^(\d+)m?(?:in)?$/.exec(text);
  return minutes ? Number(minutes[1]) : null;
}

export function parseCardQuery(input: string): CardQuery {
  const query = emptyQuery();

  for (const token of tokenize(input)) {
    const { key, value, negated } = token;
    const lower = value.toLowerCase();

    switch (key) {
      case 'label':
      case 'tag':
        (negated ? query.excludeLabels : query.labels).push(lower);
        continue;

      case 'column':
      case 'list':
      case 'stack':
        query.columns.push(lower);
        continue;

      case 'board':
        query.boards.push(lower);
        continue;

      case 'project':
        query.projects.push(lower);
        continue;

      case 'status':
      case 'is': {
        const category = STATUS_WORDS[lower];
        if (category) {
          (negated ? query.excludeStatus : query.status).push(category);
          continue;
        }
        if (key === 'is' && lower === 'blocked') {
          query.blocked = !negated;
          continue;
        }
        break; // unknown value: fall through to text
      }

      case 'priority': {
        const { op, rest } = comparison(lower);
        const priority = rest.toUpperCase() as QueryPriority;
        if (PRIORITY_ORDER.includes(priority)) {
          query.priority = { op, value: priority };
          continue;
        }
        break;
      }

      case 'due':
      case 'date': {
        if (['overdue', 'today', 'tomorrow', 'week', 'month', 'none', 'any'].includes(lower)) {
          query.due = { kind: lower as 'overdue' };
          continue;
        }
        const { op, rest } = comparison(lower);
        if (/^\d{4}-\d{2}-\d{2}$/.test(rest)) {
          query.due = { kind: 'compare', op, date: rest };
          continue;
        }
        break;
      }

      case 'planned':
        if (['today', 'tomorrow', 'week', 'none', 'any'].includes(lower)) {
          query.planned = { kind: lower as 'today' };
          continue;
        }
        break;

      case 'estimate': {
        if (lower === 'none') {
          query.estimate = { kind: 'none' };
          continue;
        }
        const { op, rest } = comparison(lower);
        const minutes = parseMinutes(rest);
        if (minutes !== null) {
          query.estimate = { kind: 'compare', op, minutes };
          continue;
        }
        break;
      }

      case 'blocked':
        if (['yes', 'true', 'no', 'false'].includes(lower)) {
          query.blocked = (lower === 'yes' || lower === 'true') !== negated;
          continue;
        }
        break;

      default:
        break;
    }

    // Plain text — including any `key:value` we did not recognise, kept whole.
    const text = key ? `${key}:${value}` : value;
    if (text) (negated ? query.excludeText : query.text).push(text.toLowerCase());
  }

  return query;
}
