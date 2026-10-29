import { LogoMark } from './icons';

/**
 * The frame around sign-in and sign-up: the same mark and colours as the app
 * itself, so the first screen someone sees — often the installed app opening
 * for the first time — already looks like the thing they installed.
 */
export function AuthShell({
  subtitle,
  children,
  footer,
}: {
  subtitle: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  return (
    <main className="from-page-from to-page-to grid min-h-dvh place-items-center bg-gradient-to-b px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-7 flex flex-col items-center text-center">
          <span className="from-primary to-secondary mb-4 grid size-14 place-items-center rounded-2xl bg-gradient-to-br text-white shadow-md">
            <LogoMark className="size-7" />
          </span>
          <h1 className="text-[1.7rem] font-extrabold tracking-tight">Fluid</h1>
          <p className="text-base-content/55 mt-1 text-sm">{subtitle}</p>
        </div>

        <div className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body">{children}</div>
        </div>

        {footer}
      </div>
    </main>
  );
}
