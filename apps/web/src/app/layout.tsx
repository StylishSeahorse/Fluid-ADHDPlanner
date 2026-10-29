import type { Metadata, Viewport } from 'next';
import { env } from '@fluid/env';
import { prisma } from '@fluid/db';
import { ServiceWorkerRegistrar } from '@/components/pwa/pwa';
import { getCurrentUser } from '@/server/auth/session';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Fluid', template: '%s · Fluid' },
  description: 'A calendar that negotiates with you.',
  applicationName: 'Fluid',
  // The manifest itself comes from app/manifest.ts; these cover iOS, which
  // still reads its own tags for home-screen installs.
  appleWebApp: { capable: true, title: 'Fluid', statusBarStyle: 'default' },
  icons: { apple: '/icons/apple-touch-icon.png' },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Lets the installed app draw under the Android gesture bar; the dock pads
  // itself with the safe-area inset so nothing ends up beneath it.
  viewportFit: 'cover',
  // Matches the page wash, so the status bar of the installed app is part of
  // the screen rather than a stripe across the top of it.
  themeColor: '#f6f7fb',
};

/**
 * Accessibility preferences are resolved server-side and stamped on <html>
 * before first paint. Doing this in an effect would flash the default theme
 * first, which for someone who asked for high contrast or reduced motion is
 * precisely the thing they asked to avoid.
 */
export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();

  const preferences = user
    ? await prisma.userPreferences.findUnique({ where: { userId: user.id } })
    : null;

  return (
    <html
      lang="en"
      data-theme={preferences?.highContrast ? 'fluidcontrast' : 'fluid'}
      data-motion={preferences?.reducedMotion ? 'reduced' : undefined}
      data-dyslexia={preferences?.dyslexiaFont ? 'on' : undefined}
      data-text={preferences?.largeText ? 'large' : undefined}
    >
      <body className="min-h-dvh bg-base-200 antialiased">
        <ServiceWorkerRegistrar dev={env.NODE_ENV === 'development'} />
        {children}
      </body>
    </html>
  );
}
