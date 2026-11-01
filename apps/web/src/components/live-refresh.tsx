'use client';

/**
 * Keeps an open page current when something changes elsewhere — another tab,
 * another device, a calendar sync in the background.
 *
 * On a `refresh` message the page re-renders from the server (router.refresh),
 * which keeps scroll position and anything typed into a form. Bursts are
 * coalesced, and a hidden tab waits until it is looked at again rather than
 * refreshing in the background for nobody.
 */
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

const DEBOUNCE_MS = 400;

export function LiveRefresh() {
  const router = useRouter();

  useEffect(() => {
    if (typeof EventSource === 'undefined') return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = false;

    const refresh = () => {
      if (document.hidden) {
        pending = true;
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => router.refresh(), DEBOUNCE_MS);
    };

    const source = new EventSource('/api/live');
    source.addEventListener('refresh', refresh);

    const onVisible = () => {
      if (!document.hidden && pending) {
        pending = false;
        refresh();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      clearTimeout(timer);
      source.close();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [router]);

  return null;
}
