'use client';

import { useActionState, useEffect, useState } from 'react';
import type { ActionState } from '@/app/actions';

interface Props {
  action: (state: ActionState, formData: FormData) => Promise<ActionState>;
  submitLabel: string;
  autoComplete: 'current-password' | 'new-password';
  passwordHint?: string;
}

export function AuthForm({ action, submitLabel, autoComplete, passwordHint }: Props) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, undefined);
  // Read after mount: the server has no idea which zone the device is in.
  const [timeZone, setTimeZone] = useState('');
  useEffect(() => setTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone ?? ''), []);

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="timeZone" value={timeZone} />
      {state?.error ? (
        // role="alert" so it is announced as it appears, not merely rendered.
        <div role="alert" className="alert alert-error text-sm">
          <span>{state.error}</span>
        </div>
      ) : null}

      <fieldset className="fieldset">
        <legend className="fieldset-legend">Email</legend>
        <input
          name="email"
          type="email"
          autoComplete="email"
          required
          className="input w-full"
          placeholder="you@example.com"
        />
      </fieldset>

      <fieldset className="fieldset">
        <legend className="fieldset-legend">Password</legend>
        <input
          name="password"
          type="password"
          autoComplete={autoComplete}
          required
          className="input w-full"
        />
        {passwordHint ? <p className="label text-xs">{passwordHint}</p> : null}
      </fieldset>

      <button type="submit" className="btn btn-primary w-full rounded-xl" disabled={pending}>
        {pending ? <span className="loading loading-spinner loading-sm" /> : null}
        {pending ? 'Working…' : submitLabel}
      </button>
    </form>
  );
}
