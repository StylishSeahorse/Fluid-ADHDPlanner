import Link from 'next/link';
import { redirect } from 'next/navigation';
import { env } from '@fluid/env';
import { signIn } from '@/app/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { ClearOfflinePages } from '@/components/pwa/pwa';
import { getCurrentUser } from '@/server/auth/session';

export default async function LoginPage() {
  if (await getCurrentUser()) redirect('/today');

  return (
    <AuthShell
      subtitle="A calendar that negotiates with you."
      footer={
        // The seeded account only exists where someone ran the seed script,
        // which is a development step — advertising it in production would
        // point people at credentials that are not there.
        env.NODE_ENV !== 'production' ? (
          <p className="text-base-content/50 mt-4 text-center text-xs">
            Demo: <code className="font-mono">demo@fluid.local</code> /{' '}
            <code className="font-mono">demo-password-1234</code>
          </p>
        ) : null
      }
    >
      <ClearOfflinePages />
      <AuthForm action={signIn} submitLabel="Sign in" autoComplete="current-password" />

      <p className="text-base-content/60 mt-2 text-center text-sm">
        No account yet?{' '}
        <Link href="/signup" className="link link-primary">
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}
