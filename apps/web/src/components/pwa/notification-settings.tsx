'use client';

/**
 * Notifications, per device.
 *
 * Permission and subscription belong to *this* browser or installed app, so
 * they are driven from the client; what to send and when is an account
 * setting, saved on the server, and applies to every device at once.
 */
import { useActionState, useEffect, useState, useTransition } from 'react';
import {
  removePushDevice,
  removePushSubscription,
  savePushSubscription,
  sendTestNotification,
  updateNotificationSettings,
  type ActionState,
} from '@/app/actions';
import { logAction } from '@/components/action-log';
import { BellIcon, PhoneIcon } from '@/components/icons';
import { InstallAppButton } from './install-button';
import { useInstallState } from './pwa';

export interface NotificationPreferences {
  enabled: boolean;
  blockReminders: boolean;
  dayPrompts: boolean;
  leadMinutes: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface NotificationDevice {
  id: string;
  endpoint: string;
  label: string;
  createdAt: Date;
  lastSuccessAt: Date | null;
}

type DeviceState =
  | { kind: 'checking' }
  | { kind: 'unsupported' }
  | { kind: 'blocked' }
  | { kind: 'off' }
  | { kind: 'on'; endpoint: string };

/** VAPID keys travel as URL-safe base64; the Push API wants raw bytes. */
function keyBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

function supported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const LEAD_OPTIONS = [0, 2, 5, 10, 15, 30];

export function NotificationSettings({
  publicKey,
  preferences,
  devices,
}: {
  publicKey: string;
  preferences: NotificationPreferences;
  devices: NotificationDevice[];
}) {
  const [device, setDevice] = useState<DeviceState>({ kind: 'checking' });
  const [busy, startBusy] = useTransition();
  const [formState, saveAction, saving] = useActionState<ActionState, FormData>(
    updateNotificationSettings,
    undefined,
  );
  const { state: installState } = useInstallState();

  useEffect(() => {
    if (!supported()) {
      setDevice({ kind: 'unsupported' });
      return;
    }
    if (Notification.permission === 'denied') {
      setDevice({ kind: 'blocked' });
      return;
    }
    navigator.serviceWorker.ready
      .then((registration) => registration.pushManager.getSubscription())
      .then((subscription) =>
        setDevice(subscription ? { kind: 'on', endpoint: subscription.endpoint } : { kind: 'off' }),
      )
      .catch(() => setDevice({ kind: 'off' }));
  }, []);

  useEffect(() => {
    if (formState && !formState.error) logAction('Saved notification settings.');
    if (formState?.error) logAction(formState.error, 'error');
  }, [formState]);

  const turnOn = () =>
    startBusy(async () => {
      // Must run inside the tap: Android only shows the permission prompt in
      // response to a user gesture.
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') {
        setDevice(permission === 'denied' ? { kind: 'blocked' } : { kind: 'off' });
        if (permission === 'denied') logAction('Notifications are blocked for Fluid on this device.', 'error');
        return;
      }

      try {
        const registration = await navigator.serviceWorker.ready;
        const subscription =
          (await registration.pushManager.getSubscription()) ??
          (await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: keyBytes(publicKey),
          }));

        const json = subscription.toJSON();
        const result = await savePushSubscription({
          endpoint: subscription.endpoint,
          keys: { p256dh: json.keys?.p256dh ?? '', auth: json.keys?.auth ?? '' },
          userAgent: navigator.userAgent,
        });

        if (result.error) {
          await subscription.unsubscribe().catch(() => {});
          logAction(result.error, 'error');
          setDevice({ kind: 'off' });
          return;
        }

        setDevice({ kind: 'on', endpoint: subscription.endpoint });
        logAction('Notifications are on for this device.');
      } catch {
        logAction('This browser could not set up notifications. Try again, or install the app first.', 'error');
        setDevice({ kind: 'off' });
      }
    });

  const turnOff = () =>
    startBusy(async () => {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await removePushSubscription(subscription.endpoint);
        await subscription.unsubscribe().catch(() => {});
      }
      setDevice({ kind: 'off' });
      logAction('Notifications are off for this device.', 'info');
    });

  const test = () =>
    startBusy(async () => {
      const result = await sendTestNotification();
      if (result.error) logAction(result.error, 'error');
      else logAction(`Sent a test to ${result.sent} device${result.sent === 1 ? '' : 's'}.`);
    });

  const thisEndpoint = device.kind === 'on' ? device.endpoint : null;

  return (
    <div className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-5">
        {/* --- This device ------------------------------------------------ */}
        <div className="flex flex-wrap items-start gap-4">
          <span
            className={`grid size-11 shrink-0 place-items-center rounded-2xl ${
              device.kind === 'on' ? 'bg-primary/10 text-primary' : 'bg-base-200 text-base-content/50'
            }`}
            aria-hidden="true"
          >
            <BellIcon className="size-5" />
          </span>

          <div className="min-w-0 grow basis-60">
            <p className="font-semibold">
              {device.kind === 'on'
                ? 'Notifications are on for this device'
                : device.kind === 'blocked'
                  ? 'Notifications are blocked here'
                  : device.kind === 'unsupported'
                    ? 'This browser can’t show notifications'
                    : 'Get a nudge before each session'}
            </p>
            <p className="text-base-content/60 mt-0.5 text-sm">
              {device.kind === 'on'
                ? 'You’ll hear from Fluid just before sessions start, and at the start and end of your working day.'
                : device.kind === 'blocked'
                  ? 'Android: long-press the Fluid icon → App info → Notifications. In Chrome: tap the icon left of the address → Permissions → Notifications.'
                  : device.kind === 'unsupported'
                    ? 'On Android, open Fluid in Chrome and install it to your home screen, then turn notifications on from there.'
                    : 'A reminder a few minutes before a session starts — the moment it’s easiest to lose track of time.'}
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap gap-2">
            {device.kind === 'off' ? (
              <button type="button" onClick={turnOn} disabled={busy} className="btn btn-primary btn-sm rounded-xl">
                {busy ? 'Turning on…' : 'Turn on'}
              </button>
            ) : null}
            {device.kind === 'on' ? (
              <>
                <button type="button" onClick={test} disabled={busy} className="btn btn-outline btn-sm rounded-xl">
                  Send a test
                </button>
                <button type="button" onClick={turnOff} disabled={busy} className="btn btn-ghost btn-sm rounded-xl">
                  Turn off
                </button>
              </>
            ) : null}
          </div>
        </div>

        {installState !== 'installed' ? (
          <div className="bg-base-200/60 flex flex-wrap items-center gap-3 rounded-2xl px-4 py-3">
            <PhoneIcon className="text-base-content/50 size-5 shrink-0" />
            <p className="text-base-content/70 min-w-0 grow basis-52 text-sm">
              {installState === 'available'
                ? 'Install Fluid to get it on your home screen, full-screen, with reminders that feel like an app’s.'
                : 'On Android, open the Chrome menu ⋮ and choose “Install app” (or “Add to Home screen”).'}
            </p>
            <InstallAppButton className="btn btn-primary btn-sm gap-1.5 rounded-xl" />
          </div>
        ) : null}

        {/* --- What to send ---------------------------------------------- */}
        <form action={saveAction} className="border-base-200 space-y-1 border-t pt-4">
          <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
            <span>
              <span className="block text-sm font-medium">Send me notifications</span>
              <span className="text-base-content/55 block text-xs">Applies to every device you’ve turned them on for.</span>
            </span>
            <input type="checkbox" name="enabled" defaultChecked={preferences.enabled} className="toggle toggle-primary shrink-0" />
          </label>

          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-2">
            <label className="flex min-w-0 grow cursor-pointer items-center justify-between gap-4">
              <span>
                <span className="block text-sm font-medium">Up next</span>
                <span className="text-base-content/55 block text-xs">Before each scheduled session.</span>
              </span>
              <input
                type="checkbox"
                name="blockReminders"
                defaultChecked={preferences.blockReminders}
                className="toggle toggle-primary shrink-0"
              />
            </label>
            <select
              name="leadMinutes"
              defaultValue={String(preferences.leadMinutes)}
              className="select select-sm w-auto"
              aria-label="How long before a session"
            >
              {LEAD_OPTIONS.map((minutes) => (
                <option key={minutes} value={minutes}>
                  {minutes === 0 ? 'When it starts' : `${minutes} min before`}
                </option>
              ))}
            </select>
          </div>

          <label className="flex cursor-pointer items-center justify-between gap-4 py-2">
            <span>
              <span className="block text-sm font-medium">Plan and wrap up</span>
              <span className="text-base-content/55 block text-xs">
                When your working day starts (if it isn’t planned) and when it ends.
              </span>
            </span>
            <input type="checkbox" name="dayPrompts" defaultChecked={preferences.dayPrompts} className="toggle toggle-primary shrink-0" />
          </label>

          <fieldset className="py-2">
            <legend className="text-sm font-medium">Quiet hours</legend>
            <p className="text-base-content/55 mb-2 text-xs">Nothing is sent in this window. Leave empty for none.</p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="time"
                name="quietHoursStart"
                defaultValue={preferences.quietHoursStart ?? ''}
                className="input input-sm w-32"
                aria-label="Quiet from"
              />
              <span className="text-base-content/50 text-sm">to</span>
              <input
                type="time"
                name="quietHoursEnd"
                defaultValue={preferences.quietHoursEnd ?? ''}
                className="input input-sm w-32"
                aria-label="Quiet until"
              />
            </div>
          </fieldset>

          <div className="pt-2">
            <button type="submit" disabled={saving} className="btn btn-primary btn-sm rounded-xl">
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </form>

        {/* --- Devices --------------------------------------------------- */}
        {devices.length > 0 ? (
          <div className="border-base-200 border-t pt-4">
            <p className="mb-2 text-sm font-medium">Devices</p>
            <ul className="divide-base-200 divide-y">
              {devices.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 py-2">
                  <PhoneIcon className="text-base-content/40 size-4 shrink-0" />
                  <span className="min-w-0 grow truncate text-sm">
                    {entry.label}
                    {entry.endpoint === thisEndpoint ? (
                      <span className="badge badge-xs badge-soft badge-primary ml-2">this device</span>
                    ) : null}
                  </span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      startBusy(async () => {
                        const result = await removePushDevice(entry.id);
                        if (result.error) logAction(result.error, 'error');
                        else {
                          if (entry.endpoint === thisEndpoint) setDevice({ kind: 'off' });
                          logAction(`Stopped notifications on ${entry.label}.`, 'info');
                        }
                      })
                    }
                    className="btn btn-ghost btn-xs rounded-lg"
                  >
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
