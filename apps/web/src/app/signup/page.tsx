import Link from 'next/link';
import { redirect } from 'next/navigation';
import { signUp } from '@/app/actions';
import { AuthForm } from '@/components/auth-form';
import { AuthShell } from '@/components/auth-shell';
import { getCurrentUser } from '@/server/auth/session';

export default async function SignupPage() {
  if (await getCurrentUser()) redirect('/today');

  return (
    <AuthShell subtitle="Plan the day you actually have.">
      <AuthForm
        action={signUp}
        submitLabel="Create account"
        autoComplete="new-password"
        // Length, not character classes: length is what correlates with
        // strength, and class rules push people toward predictable
        // substitutions.
        passwordHint="At least 12 characters. A few unrelated words works well."
      />

      <p className="text-base-content/60 mt-2 text-center text-sm">
        Already have an account?{' '}
        <Link href="/login" className="link link-primary">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
