/**
 * An estimate, honestly labelled.
 *
 * An estimate nobody chose — the default, filled in so the work could still be
 * scheduled — reads `~30m` with a dotted underline, and says why on hover and
 * to screen readers. Small on purpose: it is a nudge to set a real number, not
 * a warning that something is wrong.
 */
import { formatDuration } from '@/components/format';

export const ASSUMED_ESTIMATE_HINT = 'Estimate assumed — nobody set one, so your default is used. Set a real one on the task.';

export function Estimate({ minutes, assumed, className = '' }: { minutes: number; assumed?: boolean; className?: string }) {
  if (!assumed) return <span className={`tabular-nums ${className}`}>{formatDuration(minutes)}</span>;
  return (
    <span
      className={`decoration-base-content/40 tabular-nums underline decoration-dotted underline-offset-2 ${className}`}
      title={ASSUMED_ESTIMATE_HINT}
      data-estimate-assumed=""
    >
      ~{formatDuration(minutes)}
      <span className="sr-only"> (estimate assumed)</span>
    </span>
  );
}
