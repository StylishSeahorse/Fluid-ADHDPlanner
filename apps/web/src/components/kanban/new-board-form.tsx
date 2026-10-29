'use client';

import { useActionState } from 'react';
import { createBoard, type ActionState } from '@/app/actions';
import { PlusIcon } from '@/components/icons';

/** One field: a board is named and created, then you are on it. */
export function NewBoardForm() {
  const [state, action, pending] = useActionState<ActionState, FormData>(createBoard, undefined);

  return (
    <form action={action} className="flex flex-wrap items-start gap-2">
      <input
        name="name"
        required
        maxLength={120}
        placeholder="New board — a project, a client, a goal"
        className="input input-sm min-w-0 grow basis-56"
        aria-label="New board name"
      />
      <button type="submit" disabled={pending} className="btn btn-primary btn-sm gap-1 rounded-xl">
        <PlusIcon className="size-4" />
        {pending ? 'Creating…' : 'Create board'}
      </button>
      {state?.error ? (
        <p role="alert" className="text-error basis-full text-xs">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
