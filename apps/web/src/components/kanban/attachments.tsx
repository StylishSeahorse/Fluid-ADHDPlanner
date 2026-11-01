'use client';

/**
 * A card's files: thumbnails for images, a list for everything else, and an
 * upload button. Uploads go to /api/attachments (a route handler that
 * streams), then the page refreshes to show the new file.
 */
import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';
import { deleteAttachmentAction } from '@/app/actions';
import { logAction } from '@/components/action-log';
import { PaperclipIcon, XIcon } from '@/components/icons';

export interface AttachmentRow {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  createdAt: Date;
}

const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function Attachments({ taskId, attachments, maxMb }: { taskId: string; attachments: AttachmentRow[]; maxMb: number }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const upload = async (files: FileList | null) => {
    for (const file of Array.from(files ?? [])) {
      if (file.size > maxMb * 1024 * 1024) {
        logAction(`“${file.name}” is over ${maxMb} MB.`, 'error');
        continue;
      }
      setUploading(file.name);
      const form = new FormData();
      form.set('taskId', taskId);
      form.set('file', file);
      try {
        const response = await fetch('/api/attachments', { method: 'POST', body: form });
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        if (!response.ok) logAction(body.error ?? `Could not attach “${file.name}”.`, 'error');
        else logAction(`Attached “${file.name}”.`);
      } catch {
        logAction(`Could not attach “${file.name}” — check your connection.`, 'error');
      }
    }
    setUploading(null);
    if (input.current) input.current.value = '';
    router.refresh();
  };

  const images = attachments.filter((file) => IMAGE_TYPES.has(file.contentType));
  const others = attachments.filter((file) => !IMAGE_TYPES.has(file.contentType));

  return (
    <div className="space-y-3">
      {images.length > 0 ? (
        <ul className="grid grid-cols-3 gap-2">
          {images.map((file) => (
            <li key={file.id} className="group relative">
              <a href={`/api/attachments/${file.id}`} target="_blank" rel="noopener noreferrer" className="block">
                {/* A plain img: the file is authenticated and same-origin, so next/image's optimiser has nothing to add. */}
                <img
                  src={`/api/attachments/${file.id}`}
                  alt={file.filename}
                  loading="lazy"
                  className="border-base-200 aspect-[4/3] w-full rounded-xl border object-cover"
                />
              </a>
              <RemoveButton id={file.id} name={file.filename} pending={pending} start={start} onDone={() => router.refresh()} />
            </li>
          ))}
        </ul>
      ) : null}

      {others.length > 0 ? (
        <ul className="divide-base-200 divide-y">
          {others.map((file) => (
            <li key={file.id} className="group relative flex items-center gap-2 py-1.5">
              <PaperclipIcon className="text-base-content/40 size-4 shrink-0" />
              <a
                href={`/api/attachments/${file.id}?download`}
                className="link link-hover min-w-0 grow truncate text-sm"
                download={file.filename}
              >
                {file.filename}
              </a>
              <span className="text-base-content/45 shrink-0 text-xs">{size(file.sizeBytes)}</span>
              <RemoveButton id={file.id} name={file.filename} pending={pending} start={start} onDone={() => router.refresh()} inline />
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex items-center gap-2">
        <input
          ref={input}
          type="file"
          multiple
          className="sr-only"
          id={`attach-${taskId}`}
          onChange={(event) => void upload(event.target.files)}
        />
        <label htmlFor={`attach-${taskId}`} className={`btn btn-outline btn-xs gap-1 rounded-lg ${uploading ? 'btn-disabled' : ''}`}>
          <PaperclipIcon className="size-3.5" />
          {uploading ? `Uploading ${uploading}…` : 'Attach a file'}
        </label>
        <span className="text-base-content/45 text-xs">Up to {maxMb} MB</span>
      </div>
    </div>
  );
}

function RemoveButton({
  id,
  name,
  pending,
  start,
  onDone,
  inline,
}: {
  id: string;
  name: string;
  pending: boolean;
  start: (fn: () => Promise<void>) => void;
  onDone: () => void;
  inline?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => {
        if (!window.confirm(`Remove “${name}”? This deletes the file.`)) return;
        start(async () => {
          const result = await deleteAttachmentAction(id);
          if (result.error) logAction(result.error, 'error');
          else {
            logAction(`Removed “${name}”.`, 'info');
            onDone();
          }
        });
      }}
      className={
        inline
          ? 'btn btn-ghost btn-xs btn-square shrink-0 rounded-lg'
          : 'btn btn-xs btn-square bg-base-100/90 absolute right-1 top-1 rounded-lg opacity-100 sm:opacity-0 sm:group-hover:opacity-100'
      }
      aria-label={`Remove ${name}`}
    >
      <XIcon className="size-3.5" />
    </button>
  );
}
