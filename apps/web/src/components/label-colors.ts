/**
 * The label palette.
 *
 * Labels store a palette *name*, never a hex value, so every label stays
 * legible in every theme — high contrast included — and nobody can pick pale
 * yellow text on white. Class strings are written out in full because the
 * Tailwind compiler only sees literal class names.
 *
 * Shared by the server (to validate) and the client (to draw); no server-only.
 */
export const LABEL_COLORS = ['indigo', 'sky', 'teal', 'green', 'amber', 'orange', 'rose', 'purple', 'slate'] as const;

export type LabelColor = (typeof LABEL_COLORS)[number];

/** Chip on a card and in the label picker. */
export const LABEL_CHIP: Record<LabelColor, string> = {
  indigo: 'bg-indigo-100 text-indigo-800',
  sky: 'bg-sky-100 text-sky-800',
  teal: 'bg-teal-100 text-teal-800',
  green: 'bg-green-100 text-green-800',
  amber: 'bg-amber-100 text-amber-900',
  orange: 'bg-orange-100 text-orange-900',
  rose: 'bg-rose-100 text-rose-800',
  purple: 'bg-purple-100 text-purple-800',
  slate: 'bg-slate-200 text-slate-800',
};

/** Solid swatch for the colour picker. */
export const LABEL_SWATCH: Record<LabelColor, string> = {
  indigo: 'bg-indigo-500',
  sky: 'bg-sky-500',
  teal: 'bg-teal-500',
  green: 'bg-green-500',
  amber: 'bg-amber-500',
  orange: 'bg-orange-500',
  rose: 'bg-rose-500',
  purple: 'bg-purple-500',
  slate: 'bg-slate-500',
};

export function chipClass(color: string): string {
  return LABEL_CHIP[(LABEL_COLORS as readonly string[]).includes(color) ? (color as LabelColor) : 'slate'];
}
