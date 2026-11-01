/**
 * `replanAfter(trigger)`: a protected procedure that, once it succeeds, asks
 * for a (debounced) replan. Mutations that can change the schedule use it
 * instead of `protectedProcedure`, so "edit a task, the plan follows" needs
 * no extra line in each one — and cannot be forgotten in the next one.
 */
import 'server-only';
import { protectedProcedure } from './trpc';
import type { ReplanTrigger } from './services/planning';

export function replanAfter(trigger: ReplanTrigger) {
  return protectedProcedure.use(async ({ ctx, next }) => {
    const result = await next();
    if (result.ok) {
      // Imported lazily: the job module pulls in BullMQ and the calendar
      // worker, which nothing on the request path should wait for.
      void import('./jobs/replan-jobs')
        .then(({ requestReplan }) => requestReplan(ctx.user.id, trigger, { userInitiated: true }))
        .catch((error) => console.warn('[replan] could not queue:', error));
    }
    return result;
  });
}
