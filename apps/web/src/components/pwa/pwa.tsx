'use client';

/**
 * The installable-app plumbing: service worker registration and Android's
 * install prompt.
 *
 * Chrome fires `beforeinstallprompt` once, early, and only to listeners that
 * already exist — so the listener is attached when this module loads (it is
 * imported by the root layout), not inside some component that mounts later.
 * The event is parked in a tiny store and any component can offer "Install"
 * from it.
 */
import { useEffect, useSyncExternalStore } from 'react';

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

let deferredPrompt: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    // Keep Chrome's mini-infobar from appearing at a random moment; the app
    // offers installing where it makes sense instead.
    event.preventDefault();
    deferredPrompt = event as InstallPromptEvent;
    emit();
  });
  window.addEventListener('appinstalled', () => {
    deferredPrompt = null;
    emit();
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia('(display-mode: standalone)');
  media.addEventListener('change', listener);
  return () => {
    listeners.delete(listener);
    media.removeEventListener('change', listener);
  };
}

/** Running as the installed app, not in a browser tab. */
function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    // iOS Safari's pre-standard flag.
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

type InstallState = 'installed' | 'available' | 'unavailable';

function snapshot(): InstallState {
  if (isStandalone()) return 'installed';
  return deferredPrompt ? 'available' : 'unavailable';
}

export function useInstallState(): { state: InstallState; install: () => Promise<boolean> } {
  const state = useSyncExternalStore(subscribe, snapshot, () => 'unavailable' as const);

  const install = async (): Promise<boolean> => {
    const prompt = deferredPrompt;
    if (!prompt) return false;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    // The event is single-use either way.
    deferredPrompt = null;
    emit();
    return outcome === 'accepted';
  };

  return { state, install };
}

/** Registers /sw.js once per page load. Renders nothing. */
export function ServiceWorkerRegistrar({ dev }: { dev: boolean }) {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker
      .register(dev ? '/sw.js?dev=1' : '/sw.js', { scope: '/', updateViaCache: 'none' })
      .catch((error: unknown) => console.warn('Service worker registration failed', error));
  }, [dev]);

  return null;
}

/**
 * Mounted on the sign-in screen: a signed-out device must not keep showing the
 * previous person's day from the offline cache.
 */
export function ClearOfflinePages() {
  useEffect(() => {
    navigator.serviceWorker?.ready
      .then((registration) => registration.active?.postMessage({ type: 'clear-pages' }))
      .catch(() => {});
  }, []);

  return null;
}
