'use client';

import { DownloadIcon } from '@/components/icons';
import { logAction } from '@/components/action-log';
import { useInstallState } from './pwa';

/**
 * "Install app", shown only when the browser has said it can — never a button
 * that does nothing when tapped.
 */
export function InstallAppButton({ className, label = 'Install app' }: { className?: string; label?: string }) {
  const { state, install } = useInstallState();
  if (state !== 'available') return null;

  return (
    <button
      type="button"
      onClick={async () => {
        if (await install()) logAction('Installing Fluid on this device.', 'success');
      }}
      className={className ?? 'btn btn-primary btn-sm gap-1.5 rounded-xl'}
    >
      <DownloadIcon className="size-4" />
      {label}
    </button>
  );
}
