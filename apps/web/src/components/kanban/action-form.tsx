'use client';

/**
 * A form that calls a server action and says what happened.
 *
 * Board actions return `{ error }` rather than throwing (see app/actions.ts),
 * and a plain `<form action>` would drop that on the floor. This reads it,
 * writes it to the activity log, and resets the form only on success — so a
 * comment that failed to post is still in the box, not lost.
 */
import { useRef, useTransition } from 'react';
import { logAction } from '@/components/action-log';

export function ActionForm({
  action,
  success,
  reset = true,
  className,
  children,
  onDone,
}: {
  action: (formData: FormData) => Promise<{ error?: string } | void>;
  /** Logged on success. Omit for edits too small to announce. */
  success?: string;
  reset?: boolean;
  className?: string;
  children: React.ReactNode;
  onDone?: () => void;
}) {
  const form = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();

  return (
    <form
      ref={form}
      className={className}
      aria-busy={pending}
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        start(async () => {
          const result = await action(data);
          if (result && result.error) {
            logAction(result.error, 'error');
            return;
          }
          if (success) logAction(success);
          if (reset) form.current?.reset();
          onDone?.();
        });
      }}
    >
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
    </form>
  );
}
