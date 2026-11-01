/**
 * Settings → Scheduling: how much Fluid may do on its own.
 *
 * The four modes are described by what the person will notice, not by how
 * the gate works. The always-ask list is stated plainly on the same screen,
 * because a ceiling only reassures if it is visible.
 */
import { updateSchedulingSettings } from '@/app/actions';
import { ActionForm } from '@/components/kanban/action-form';

const MODES = [
  { value: 'MANUAL', title: 'Manual', detail: 'Fluid plans only when you press “Schedule my day” or “Find time”.' },
  { value: 'ASSISTED', title: 'Assisted', detail: 'Fluid replans as things change, and shows you the new plan to accept or ignore.' },
  { value: 'HYBRID', title: 'Hybrid', detail: 'Small adjustments happen on their own, with undo. Bigger ones ask first.' },
  { value: 'AUTOMATIC', title: 'Automatic', detail: 'Fluid keeps the plan up to date by itself, with undo.' },
] as const;

export function SchedulingSettings({
  preferences,
}: {
  preferences: {
    schedulingMode: string;
    hybridThreshold: number;
    horizonDays: number;
    maxDailyWorkMinutes: number | null;
    maxDailyReshuffles: number;
    autoAcceptSeconds: number;
  };
}) {
  return (
    <ActionForm action={updateSchedulingSettings} reset={false} success="Saved. Replanning with the new settings." className="card bg-base-100 border-base-200 border shadow-sm">
      <div className="card-body gap-4">
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">How Fluid replans</legend>
          {MODES.map((mode) => (
            <label
              key={mode.value}
              className="border-base-200 hover:bg-base-200 has-[:checked]:border-primary/40 has-[:checked]:bg-primary/5 rounded-box flex cursor-pointer items-start gap-3 border p-3"
            >
              <input type="radio" name="schedulingMode" value={mode.value} defaultChecked={preferences.schedulingMode === mode.value} className="radio radio-primary radio-sm mt-0.5" />
              <span>
                <span className="block text-sm font-medium">{mode.title}</span>
                <span className="text-base-content/60 block text-sm">{mode.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <fieldset className="fieldset">
            <legend className="fieldset-legend">In Hybrid, how much may move without asking?</legend>
            <select name="hybridThreshold" defaultValue={String(preferences.hybridThreshold)} className="select w-full">
              <option value="2">Cautious — about one move</option>
              <option value="4">Balanced — a couple of moves</option>
              <option value="8">Relaxed — a handful</option>
            </select>
            <p className="label text-xs whitespace-normal">Moves to another day, or of a session starting within the hour, count for more.</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Accept proposals automatically</legend>
            <select name="autoAcceptSeconds" defaultValue={String(preferences.autoAcceptSeconds)} className="select w-full">
              <option value="0">Never — always wait for me</option>
              <option value="30">After 30 seconds</option>
              <option value="120">After 2 minutes</option>
            </select>
            <p className="label text-xs whitespace-normal">Assisted mode only. Never for anything on the always-ask list.</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Plan this many days ahead</legend>
            <input type="number" name="horizonDays" min={1} max={90} defaultValue={preferences.horizonDays} className="input w-full" />
            <p className="label text-xs whitespace-normal">Work due later is planned as the window moves — not flagged as a problem.</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Most work in one day (minutes)</legend>
            <input
              type="number"
              name="maxDailyWorkMinutes"
              min={30}
              max={1440}
              step={15}
              defaultValue={preferences.maxDailyWorkMinutes ?? ''}
              placeholder="No limit beyond working hours"
              className="input w-full"
            />
            <p className="label text-xs whitespace-normal">For “I only have five real hours in me”. Personal areas don’t count.</p>
          </fieldset>

          <fieldset className="fieldset">
            <legend className="fieldset-legend">Most changes to one day per replan</legend>
            <input type="number" name="maxDailyReshuffles" min={1} max={20} defaultValue={preferences.maxDailyReshuffles} className="input w-full" />
            <p className="label text-xs whitespace-normal">Above this, Fluid always asks — however small each change is.</p>
          </fieldset>
        </div>

        <div role="note" className="alert alert-info alert-soft text-sm">
          <span>
            In every mode Fluid asks before it: suggests working outside your hours, finds a new time for a session you placed
            yourself, moves work off the day you planned it for, or removes a session you logged time on. Pinned sessions and
            meetings never move.
          </span>
        </div>

        <div className="card-actions">
          <button type="submit" className="btn btn-primary btn-sm rounded-xl">
            Save
          </button>
        </div>
      </div>
    </ActionForm>
  );
}
