import { env, features } from '@fluid/env';
import { prisma } from '@fluid/db';
import { setAutonomy, updateAccessibility, updateFocusRhythm, updateTimeZone } from '@/app/actions';
import { PageHeader, SectionTitle } from '@/components/page-header';
import { AiProviderForm } from '@/components/ai-provider-form';
import { Areas } from '@/components/areas';
import { RoutinesSection } from '@/components/routines-section';
import { CalendarConnections } from '@/components/calendar-connections';
import { NotificationSettings } from '@/components/pwa/notification-settings';
import { ApiTokens } from '@/components/api-tokens';
import { getCaller } from '@/server/caller';
import { requireUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

const AUTONOMY_OPTIONS = [
  {
    value: 'PROPOSE_THEN_CONFIRM',
    title: 'Ask me first',
    detail: 'The AI drafts changes. Nothing is written until you agree.',
  },
  {
    value: 'AUTO_WITH_UNDO',
    title: 'Act, but keep undo open',
    detail: 'Changes apply immediately and stay one tap from being reversed.',
  },
  {
    value: 'FULL_AUTO',
    title: 'Just do it',
    detail:
      'Changes apply immediately. Deleting, double-booking and scheduling outside your hours still need your say-so.',
  },
] as const;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ calendar?: string }> }) {
  const { calendar: calendarFlash } = await searchParams;
  const user = await requireUser();
  const caller = await getCaller();

  const [preferences, calendars, autonomy, aiSettings, cliStatus, areas, routines, notifications, apiTokens] =
    await Promise.all([
      prisma.userPreferences.findUnique({ where: { userId: user.id } }),
      caller.calendar.connections(),
      caller.agent.autonomy(),
      caller.ai.settings(),
      caller.ai.cliStatus(),
      caller.area.list(),
      caller.routine.list(),
      caller.notification.settings(),
      caller.apiToken.list(),
    ]);

  const zones = Intl.supportedValuesOf('timeZone');
  if (!zones.includes(user.timeZone)) zones.unshift(user.timeZone);

  return (
    <>
      <PageHeader
        eyebrow="Your workspace"
        title="Settings"
        subtitle="How Fluid reaches you, how your day is shaped, and what the AI may do."
      />

      {/*
        One long page, grouped by the question each part answers, with a jump
        bar. Separate sub-pages would hide the thing someone came for one
        level deeper; a jump bar keeps it all one scroll and one tap away.
      */}
      <nav
        aria-label="Settings sections"
        className="bg-base-200/85 sticky top-14 z-20 -mx-4 mb-2 flex gap-1.5 overflow-x-auto px-4 py-2 backdrop-blur lg:top-0 lg:mx-0 lg:rounded-2xl lg:px-2"
      >
        {SECTIONS.map((section) => (
          <a
            key={section.id}
            href={`#${section.id}`}
            className="btn btn-ghost btn-sm text-base-content/70 shrink-0 rounded-xl font-medium"
          >
            {section.label}
          </a>
        ))}
      </nav>

      <section id="notifications" className="scroll-mt-32">
        <SectionTitle>Notifications &amp; app</SectionTitle>
        <NotificationSettings
          publicKey={notifications.publicKey}
          preferences={notifications.preferences}
          devices={notifications.devices}
        />
      </section>

      <section id="day" className="scroll-mt-32">
        <SectionTitle>Your day</SectionTitle>
        <form action={updateTimeZone} className="card bg-base-100 border-base-200 mb-4 border shadow-sm">
          <div className="card-body flex-row flex-wrap items-end gap-3">
            <fieldset className="fieldset min-w-0 grow basis-64">
              <legend className="fieldset-legend">Time zone</legend>
              <select name="timeZone" defaultValue={user.timeZone} className="select w-full">
                {zones.map((zone) => (
                  <option key={zone} value={zone}>
                    {zone.replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
              <p className="label text-xs">
                Working hours, reminders and what counts as &ldquo;today&rdquo; all follow this.
              </p>
            </fieldset>
            <button type="submit" className="btn btn-primary btn-sm mb-6 rounded-xl">
              Save
            </button>
          </div>
        </form>

        <h3 id="routines" className="mb-2 scroll-mt-32 text-sm font-semibold">
          Routines
        </h3>
        <RoutinesSection routines={routines} />

        <h3 className="mb-2 mt-6 text-sm font-semibold">Focus rhythm</h3>
        <FocusRhythmForm
          enabled={preferences?.pomodoroEnabled ?? true}
          workMinutes={preferences?.pomodoroWorkMinutes ?? 50}
          breakMinutes={preferences?.pomodoroBreakMinutes ?? 10}
        />
      </section>

      <section id="areas" className="scroll-mt-32">
        <SectionTitle>Areas</SectionTitle>
        <Areas areas={areas} />
      </section>

      <section id="calendars" className="scroll-mt-32">
        <SectionTitle>Calendars</SectionTitle>
        <CalendarConnections
          connections={calendars.connections}
          undeliveredWrites={calendars.undeliveredWrites}
          timeZone={user.timeZone}
          google={{ configured: features.googleCalendar, push: features.googlePush }}
          flash={calendarFlash?.slice(0, 300)}
        />
      </section>

      <section id="ai" className="scroll-mt-32">
        <SectionTitle>How much the AI may do on its own</SectionTitle>
        <AutonomyForm autonomy={autonomy} />

        <SectionTitle>AI provider</SectionTitle>
        {features.ai ? (
          <AiProviderForm
            providers={aiSettings.providers}
            current={aiSettings.current}
            cliStatus={cliStatus}
          />
        ) : (
          <div className="card bg-base-100 border-base-200 border shadow-sm">
            <div className="card-body">
              <p className="text-base-content/70 text-sm">
                AI is switched off entirely (AI_DISABLED=1). Everything still works — the
                deterministic scheduler runs on its own.
              </p>
            </div>
          </div>
        )}
      </section>

      <section id="api" className="scroll-mt-32">
        <SectionTitle>API tokens</SectionTitle>
        <ApiTokens tokens={apiTokens} timeZone={user.timeZone} apiBase={`${env.APP_URL}/api/v1`} />
      </section>

      <section id="accessibility" className="scroll-mt-32">
        <SectionTitle>Accessibility</SectionTitle>
        <form action={updateAccessibility} className="card bg-base-100 border-base-200 border shadow-sm">
          <div className="card-body gap-1">
            {[
              { name: 'highContrast', label: 'High contrast', on: preferences?.highContrast },
              { name: 'reducedMotion', label: 'Reduce motion', on: preferences?.reducedMotion },
              {
                name: 'dyslexiaFont',
                label: 'Dyslexia-friendly text spacing',
                on: preferences?.dyslexiaFont,
              },
              { name: 'largeText', label: 'Larger text', on: preferences?.largeText },
            ].map((option) => (
              <label key={option.name} className="flex cursor-pointer items-center justify-between gap-4 py-2">
                <span className="text-sm">{option.label}</span>
                <input
                  type="checkbox"
                  name={option.name}
                  defaultChecked={option.on ?? false}
                  className="toggle toggle-primary"
                />
              </label>
            ))}

            <div className="card-actions mt-2">
              <button type="submit" className="btn btn-primary btn-sm rounded-xl">
                Save
              </button>
            </div>
          </div>
        </form>
      </section>
    </>
  );
}

const SECTIONS = [
  { id: 'notifications', label: 'Notifications' },
  { id: 'day', label: 'Your day' },
  { id: 'areas', label: 'Areas' },
  { id: 'calendars', label: 'Calendars' },
  { id: 'ai', label: 'AI' },
  { id: 'api', label: 'API' },
  { id: 'accessibility', label: 'Accessibility' },
] as const;

function FocusRhythmForm({
  enabled,
  workMinutes,
  breakMinutes,
}: {
  enabled: boolean;
  workMinutes: number;
  breakMinutes: number;
}) {
  return (
    <form action={updateFocusRhythm} className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <label className="flex cursor-pointer items-start justify-between gap-4">
          <span className="min-w-0">
            <span className="block text-sm font-medium">Offer breaks while I work</span>
            <span className="text-base-content/60 block text-sm">
              A prompt in focus mode, never an interruption — push it back or ignore it. Taking
              the break stops the timer, so time away is not logged as work.
            </span>
          </span>
          <input
            type="checkbox"
            name="pomodoroEnabled"
            defaultChecked={enabled}
            className="toggle toggle-primary mt-0.5 shrink-0"
          />
        </label>

        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">Work for (minutes)</legend>
            <input
              type="number"
              name="pomodoroWorkMinutes"
              min={10}
              max={180}
              step={5}
              defaultValue={workMinutes}
              className="input w-full"
            />
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Then break for (minutes)</legend>
            <input
              type="number"
              name="pomodoroBreakMinutes"
              min={1}
              max={60}
              step={1}
              defaultValue={breakMinutes}
              className="input w-full"
            />
          </fieldset>
        </div>

        <div className="card-actions">
          <button type="submit" className="btn btn-primary btn-sm rounded-xl">
            Save
          </button>
        </div>
      </div>
    </form>
  );
}

function AutonomyForm({
  autonomy,
}: {
  autonomy: { level: string; scope: string; undoWindowSeconds: number };
}) {
  return (
    <form action={setAutonomy} className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <div className="space-y-2">
          {AUTONOMY_OPTIONS.map((option) => (
            <label
              key={option.value}
              className="border-base-200 hover:bg-base-200 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-box border p-3"
            >
              <input
                type="radio"
                name="level"
                value={option.value}
                defaultChecked={autonomy.level === option.value}
                className="radio radio-primary radio-sm mt-0.5"
              />
              <span>
                <span className="block text-sm font-medium">{option.title}</span>
                <span className="text-base-content/60 block text-sm">{option.detail}</span>
              </span>
            </label>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">How much it may rewrite at once</legend>
            <select name="scope" defaultValue={autonomy.scope} className="select w-full">
              <option value="TODAY">Today only</option>
              <option value="THIS_WEEK">This week</option>
            </select>
            <p className="label text-xs">A cap so one bad plan cannot quietly restructure a month.</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Undo window (seconds)</legend>
            <input
              type="number"
              name="undoWindowSeconds"
              min={5}
              max={300}
              step={5}
              defaultValue={autonomy.undoWindowSeconds}
              className="input w-full"
            />
          </fieldset>
        </div>

        {/*
          Stated plainly, because a tiered autonomy control is only meaningful
          if the ceiling is visible from the same screen.
        */}
        <div role="note" className="alert alert-info alert-soft text-sm">
          <span>
            Whatever you choose here, the AI never touches events it did not create, never
            schedules over protected time, and always asks before deleting something.
          </span>
        </div>

        <div className="card-actions">
          <button type="submit" className="btn btn-primary btn-sm rounded-xl">
            Save
          </button>
        </div>
      </div>
    </form>
  );
}
