'use client';

import { useActionState, useState } from 'react';
import { createApiTokenAction, revokeApiTokenAction, type TokenState } from '@/app/actions';
import { LoggedActionButton } from '@/components/action-log';
import { formatDay } from '@/components/format';

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
}

/**
 * Personal access tokens for scripts and other tools. A new token is shown
 * once, right here, with a copy button — it cannot be looked up again.
 */
export function ApiTokens({ tokens, timeZone, apiBase }: { tokens: TokenSummary[]; timeZone: string; apiBase: string }) {
  const [state, action, pending] = useActionState<TokenState, FormData>(createApiTokenAction, undefined);
  const [copied, setCopied] = useState(false);

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <p className="text-base-content/65 text-sm">
          A token lets a script or another app read and change your boards through the REST API at{' '}
          <code className="text-xs">{apiBase}</code>. It acts as you, so keep it as private as a password.
        </p>

        {state?.token ? (
          <div role="status" className="alert alert-success alert-soft flex-col items-start gap-2">
            <p className="text-sm font-semibold">“{state.name}” is ready. Copy it now — it will not be shown again.</p>
            <div className="flex w-full flex-wrap items-center gap-2">
              <code className="bg-base-100 min-w-0 grow break-all rounded-lg px-2 py-1 font-mono text-xs" data-testid="new-token">
                {state.token}
              </code>
              <button
                type="button"
                className="btn btn-sm rounded-lg"
                onClick={() => {
                  void navigator.clipboard?.writeText(state.token ?? '').then(() => setCopied(true));
                }}
              >
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
          </div>
        ) : null}

        <form action={action} className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end" onSubmit={() => setCopied(false)}>
          <label className="text-xs font-medium">
            Name
            <input name="name" required maxLength={60} placeholder="e.g. Home Assistant" className="input input-sm mt-1 w-full" />
          </label>
          <label className="text-xs font-medium">
            Expires
            <select name="expiresInDays" defaultValue="90" className="select select-sm mt-1 w-full">
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In a year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <button type="submit" disabled={pending} className="btn btn-primary btn-sm rounded-xl">
            {pending ? 'Making…' : 'Make token'}
          </button>
          <label className="flex items-center gap-2 text-sm sm:col-span-3">
            <input type="checkbox" name="write" className="checkbox checkbox-sm" />
            Allow changes (create, edit, move and complete cards). Without this the token can only read.
          </label>
          {state?.error ? (
            <p role="alert" className="text-error text-xs sm:col-span-3">
              {state.error}
            </p>
          ) : null}
        </form>

        {tokens.length > 0 ? (
          <ul className="divide-base-200 border-base-200 divide-y rounded-xl border">
            {tokens.map((token) => (
              <li key={token.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <div className="min-w-0 grow">
                  <p className="text-sm font-medium">
                    {token.name}{' '}
                    <span className={`badge badge-xs ${token.scopes.includes('write') ? 'badge-warning badge-soft' : 'badge-ghost'}`}>
                      {token.scopes.includes('write') ? 'read & write' : 'read only'}
                    </span>
                  </p>
                  <p className="text-base-content/50 text-xs">
                    <code>{token.prefix}…</code> · made {formatDay(token.createdAt, timeZone)} ·{' '}
                    {token.lastUsedAt ? `last used ${formatDay(token.lastUsedAt, timeZone)}` : 'never used'} ·{' '}
                    {token.expiresAt ? `expires ${formatDay(token.expiresAt, timeZone)}` : 'never expires'}
                  </p>
                </div>
                <LoggedActionButton
                  action={revokeApiTokenAction}
                  fields={{ id: token.id }}
                  successMessage={`Revoked “${token.name}”. Anything using it stops working now.`}
                  className="btn btn-ghost btn-xs text-error rounded-lg"
                >
                  Revoke
                </LoggedActionButton>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-base-content/50 text-sm">No tokens yet.</p>
        )}
      </div>
    </div>
  );
}
