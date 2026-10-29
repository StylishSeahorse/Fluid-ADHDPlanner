import type { MetadataRoute } from 'next';

/**
 * The web app manifest — what makes Fluid installable.
 *
 * Android's install criteria are: served over HTTPS, a registered service
 * worker, and a manifest with a name, a start URL, `display: standalone`, and
 * 192px and 512px icons. Everything here is static on purpose: it is fetched
 * without cookies, before anyone has signed in.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/today',
    name: 'Fluid — ADHD Planner',
    short_name: 'Fluid',
    description: 'A calendar that negotiates with you. Plan the day, then get nudged through it.',
    start_url: '/today',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#f6f7fb',
    theme_color: '#f6f7fb',
    categories: ['productivity', 'lifestyle'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/maskable-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
      { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    // Long-press on the home-screen icon. The four moments the app is opened
    // for, straight to the right screen.
    shortcuts: [
      {
        name: 'Today',
        url: '/today',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Plan my day',
        short_name: 'Plan',
        url: '/plan-day',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Focus',
        url: '/focus',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
      {
        name: 'Add tasks',
        short_name: 'Add',
        url: '/projects#capture',
        icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
      },
    ],
  };
}
