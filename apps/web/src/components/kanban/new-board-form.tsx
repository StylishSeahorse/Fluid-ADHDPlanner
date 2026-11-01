'use client';

import { useActionState, useState } from 'react';
import { createBoard, type ActionState } from '@/app/actions';
import { PlusIcon } from '@/components/icons';

export interface TemplateOption {
  id: string;
  name: string;
  description: string | null;
  columns: string[];
}

/**
 * A board is named and created, then you are on it. The template picker is
 * there but already set to Simple, so the one-field path stays one field.
 */
export function NewBoardForm({ templates }: { templates?: { builtIn: TemplateOption[]; saved: TemplateOption[] } }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createBoard, undefined);
  const all = [...(templates?.builtIn ?? []), ...(templates?.saved ?? [])];
  const [templateId, setTemplateId] = useState(all[0]?.id ?? '');
  const chosen = all.find((template) => template.id === templateId);

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
      {all.length > 0 ? (
        <div className="flex basis-full flex-wrap items-center gap-2">
          <label className="text-base-content/60 text-xs" htmlFor="new-board-template">
            Start from
          </label>
          <select
            id="new-board-template"
            name="templateId"
            value={templateId}
            onChange={(event) => setTemplateId(event.target.value)}
            className="select select-xs w-auto rounded-lg"
          >
            <optgroup label="Built in">
              {templates?.builtIn.map((template) => (
                <option key={template.id} value={template.id}>
                  {template.name}
                </option>
              ))}
            </optgroup>
            {templates && templates.saved.length > 0 ? (
              <optgroup label="Your templates">
                {templates.saved.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          {chosen ? (
            <span className="text-base-content/45 min-w-0 text-xs">
              {chosen.description ? `${chosen.description} ` : ''}
              <span className="text-base-content/35">({chosen.columns.join(' · ')})</span>
            </span>
          ) : null}
        </div>
      ) : null}
      {state?.error ? (
        <p role="alert" className="text-error basis-full text-xs">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}
