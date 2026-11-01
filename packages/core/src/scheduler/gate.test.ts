import { describe, expect, it } from 'vitest';
import { disruptionScore, gatePlan, type GateChange, type GateInput, type SchedulingMode } from './gate';

const NOW = new Date('2026-06-16T10:00:00Z'); // a Tuesday
const at = (iso: string) => new Date(`2026-06-${iso}:00Z`);
const MODES: SchedulingMode[] = ['MANUAL', 'ASSISTED', 'HYBRID', 'AUTOMATIC'];

const move = (from: string, to: string, extra: Partial<GateChange> = {}): GateChange => ({
  kind: 'MOVED',
  taskId: 'a',
  previous: { start: at(from), end: new Date(at(from).getTime() + 30 * 60_000) },
  next: { start: at(to), end: new Date(at(to).getTime() + 30 * 60_000) },
  ...extra,
});

function input(overrides: Partial<GateInput> = {}): GateInput {
  return {
    mode: 'HYBRID',
    changes: [move('16T15:00', '16T16:00')],
    now: NOW,
    timeZone: 'UTC',
    requested: false,
    userInitiated: false,
    hybridThreshold: 4,
    maxDailyReshuffles: 3,
    autoAcceptSeconds: 30,
    overtimeProposals: 0,
    spillsCommitment: false,
    recoversMissedPin: false,
    staleCalendar: false,
    granularityMinutes: 15,
    ...overrides,
  };
}

describe('disruptionScore', () => {
  const options = { now: NOW, timeZone: 'UTC', userInitiated: false };

  it('weighs a move within the day 1 and to another day 2', () => {
    expect(disruptionScore([move('16T15:00', '16T16:00')], options)).toBe(1);
    expect(disruptionScore([move('16T15:00', '17T09:00')], options)).toBe(2);
  });

  it('adds 2 for a session starting within the hour, and 1 when shared', () => {
    expect(disruptionScore([move('16T10:30', '16T16:00')], options)).toBe(3);
    expect(disruptionScore([move('16T15:00', '16T16:00', { externallyShared: true })], options)).toBe(2);
  });

  it('counts adding into free time as nothing, removing an accepted session as 2', () => {
    expect(disruptionScore([{ kind: 'ADDED', taskId: 'a', next: { start: at('16T15:00'), end: at('16T16:00') } }], options)).toBe(0);
    expect(disruptionScore([{ kind: 'REMOVED', taskId: 'a', previous: { start: at('16T15:00'), end: at('16T16:00') } }], options)).toBe(2);
    expect(
      disruptionScore([{ kind: 'REMOVED', taskId: 'a', previousAccepted: false, previous: { start: at('16T15:00'), end: at('16T16:00') } }], options),
    ).toBe(0);
  });

  it('halves everything caused by the user’s own action', () => {
    expect(disruptionScore([move('16T15:00', '17T09:00')], { ...options, userInitiated: true })).toBe(1);
  });
});

describe('gatePlan', () => {
  it('discards a replan that changes nothing, in every mode (AC-3.4)', () => {
    for (const mode of MODES) {
      const unchanged: GateChange = { kind: 'UNCHANGED', taskId: 'a', previous: { start: at('16T15:00'), end: at('16T16:00') } };
      expect(gatePlan(input({ mode, requested: true, changes: [unchanged] })).action).toBe('DISCARD');
    }
  });

  it('treats a resize smaller than the grid as no change', () => {
    const resize: GateChange = {
      kind: 'RESIZED',
      taskId: 'a',
      previous: { start: at('16T15:00'), end: at('16T16:00') },
      next: { start: at('16T15:00'), end: at('16T16:05') },
    };
    expect(gatePlan(input({ changes: [resize] })).action).toBe('DISCARD');
  });

  it('Manual plans only when asked, and never auto-accepts', () => {
    expect(gatePlan(input({ mode: 'MANUAL' })).action).toBe('DISCARD');
    const asked = gatePlan(input({ mode: 'MANUAL', requested: true }));
    expect(asked.action).toBe('PROPOSE');
    expect(asked.autoAcceptAt).toBeNull();
  });

  it('Assisted proposes, with the auto-accept countdown when nothing is always-ask', () => {
    const decision = gatePlan(input({ mode: 'ASSISTED' }));
    expect(decision.action).toBe('PROPOSE');
    expect(decision.autoAcceptAt).toEqual(new Date(NOW.getTime() + 30_000));
    expect(gatePlan(input({ mode: 'ASSISTED', autoAcceptSeconds: 0 })).autoAcceptAt).toBeNull();
  });

  it('Hybrid applies under the threshold and proposes over it', () => {
    expect(gatePlan(input({ mode: 'HYBRID' })).action).toBe('APPLY');
    const big = [move('16T10:30', '17T09:00'), { ...move('16T10:45', '17T10:00'), taskId: 'b' }];
    const decision = gatePlan(input({ mode: 'HYBRID', changes: big }));
    expect(decision.disruption).toBe(8);
    expect(decision.action).toBe('PROPOSE');
    expect(gatePlan(input({ mode: 'HYBRID', changes: big, hybridThreshold: 8 })).action).toBe('APPLY');
  });

  it('Automatic applies big changes too', () => {
    const big = [move('16T10:30', '17T09:00'), { ...move('16T10:45', '17T10:00'), taskId: 'b' }];
    expect(gatePlan(input({ mode: 'AUTOMATIC', changes: big })).action).toBe('APPLY');
  });

  describe('no mode applies an always-ask change (AC-3.3)', () => {
    const cases: Array<[string, Partial<GateInput>]> = [
      ['an overtime proposal', { overtimeProposals: 1 }],
      ['recovering a missed pinned session', { recoversMissedPin: true }],
      ['moving work off its committed day', { spillsCommitment: true }],
      [
        'deleting a session with logged time',
        { changes: [{ kind: 'REMOVED', taskId: 'a', loggedMinutes: 20, previous: { start: at('16T15:00'), end: at('16T16:00') } }] },
      ],
      [
        'more than the per-day reshuffle cap',
        {
          changes: ['a', 'b', 'c', 'd'].map((taskId, index) => ({
            ...move(`16T${12 + index}:00`, `16T${12 + index}:30`),
            taskId,
          })),
          hybridThreshold: 100,
        },
      ],
    ];
    for (const [label, overrides] of cases) {
      it(label, () => {
        for (const mode of MODES) {
          const decision = gatePlan(input({ mode, requested: true, ...overrides }));
          expect(decision.action, `${mode}: ${label}`).toBe('PROPOSE');
          expect(decision.autoAcceptAt, `${mode}: ${label}`).toBeNull();
          expect(decision.alwaysAsk.length).toBeGreaterThan(0);
        }
      });
    }
  });

  it('a stale calendar turns Hybrid and Automatic into Assisted', () => {
    for (const mode of ['HYBRID', 'AUTOMATIC'] as const) {
      const decision = gatePlan(input({ mode, staleCalendar: true }));
      expect(decision.effectiveMode).toBe('ASSISTED');
      expect(decision.action).toBe('PROPOSE');
    }
  });
});
