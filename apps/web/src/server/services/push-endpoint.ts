/**
 * Which push endpoints the server will deliver to.
 *
 * A Web Push subscription is a URL the *browser* hands us, and the server then
 * POSTs to it on a timer. Accepted blindly, that is an SSRF primitive: anyone
 * signed in could register `http://169.254.169.254/…` and have the server poke
 * the cloud metadata service every minute. So delivery is restricted to the
 * push services real browsers use, over https, on the default port.
 *
 * Pure on purpose — no server-only import — so the rule is unit-tested.
 */

/** Exact hosts, or a suffix starting with a dot to allow subdomains. */
const PUSH_SERVICE_HOSTS = [
  // Chrome, Edge-on-Android, Samsung Internet, Opera — Firebase Cloud Messaging.
  'fcm.googleapis.com',
  'android.googleapis.com',
  // Firefox.
  'updates.push.services.mozilla.com',
  // Edge on Windows (wns2-*.notify.windows.com).
  '.notify.windows.com',
  // Safari, including installed web apps on iOS.
  'web.push.apple.com',
] as const;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }

  if (url.protocol !== 'https:') return false;
  if (url.port !== '' && url.port !== '443') return false;
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) =>
    allowed.startsWith('.') ? host.endsWith(allowed) && host.length > allowed.length : host === allowed,
  );
}

/**
 * What a failed delivery means for the subscription.
 *
 * 404 and 410 are the push service saying the subscription no longer exists —
 * the app was uninstalled, or permission was revoked. Keeping it would mean
 * POSTing into the void forever. Everything else might be transient.
 */
export function classifyPushFailure(statusCode: number | undefined): 'GONE' | 'RETRY' {
  return statusCode === 404 || statusCode === 410 ? 'GONE' : 'RETRY';
}

/** A device that fails this many times in a row is dropped. */
export const MAX_PUSH_FAILURES = 5;

/** A short, human label for a device in settings — "Chrome on Android". */
export function describeUserAgent(userAgent: string | null | undefined): string {
  if (!userAgent) return 'Unknown device';

  const browser = /Edg\//.test(userAgent)
    ? 'Edge'
    : /SamsungBrowser\//.test(userAgent)
      ? 'Samsung Internet'
      : /Firefox\//.test(userAgent)
        ? 'Firefox'
        : /Chrome\//.test(userAgent)
          ? 'Chrome'
          : /Safari\//.test(userAgent)
            ? 'Safari'
            : 'Browser';

  const os = /Android/.test(userAgent)
    ? 'Android'
    : /iPhone|iPad|iPod/.test(userAgent)
      ? 'iOS'
      : /Windows/.test(userAgent)
        ? 'Windows'
        : /Mac OS X/.test(userAgent)
          ? 'macOS'
          : /Linux/.test(userAgent)
            ? 'Linux'
            : null;

  return os ? `${browser} on ${os}` : browser;
}
