import 'server-only';
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { prisma } from '@fluid/db';
import { protectedProcedure, router } from '../trpc';
import { describeUserAgent, isAllowedPushEndpoint } from '../services/push-endpoint';
import { sendToUser, vapidPublicKey } from '../services/push';

const timeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a 24-hour time like 22:00.')
  .nullable();

export const notificationRouter = router({
  /** Everything the settings card needs in one round trip. */
  settings: protectedProcedure.query(async ({ ctx }) => {
    const [publicKey, preferences, devices] = await Promise.all([
      vapidPublicKey(),
      prisma.userPreferences.findUnique({ where: { userId: ctx.user.id } }),
      prisma.pushSubscription.findMany({
        where: { userId: ctx.user.id },
        orderBy: { createdAt: 'asc' },
        select: { id: true, endpoint: true, userAgent: true, createdAt: true, lastSuccessAt: true },
      }),
    ]);

    return {
      publicKey,
      preferences: {
        enabled: preferences?.nudgesEnabled ?? true,
        blockReminders: preferences?.pushBlockReminders ?? true,
        dayPrompts: preferences?.pushDayPrompts ?? true,
        leadMinutes: preferences?.reminderLeadMinutes ?? 5,
        quietHoursStart: preferences?.quietHoursStart ?? null,
        quietHoursEnd: preferences?.quietHoursEnd ?? null,
      },
      devices: devices.map((device) => ({
        id: device.id,
        endpoint: device.endpoint,
        label: describeUserAgent(device.userAgent),
        createdAt: device.createdAt,
        lastSuccessAt: device.lastSuccessAt,
      })),
    };
  }),

  /** Register this device. Re-subscribing the same device updates its row. */
  subscribe: protectedProcedure
    .input(
      z.object({
        endpoint: z.string().url().max(2048),
        keys: z.object({ p256dh: z.string().min(1).max(256), auth: z.string().min(1).max(256) }),
        userAgent: z.string().max(512).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (!isAllowedPushEndpoint(input.endpoint)) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'This browser uses a push service Fluid does not deliver to.',
        });
      }

      // A device that signs into a different account moves with it: the
      // endpoint belongs to the browser, and the browser now belongs to them.
      await prisma.pushSubscription.upsert({
        where: { endpoint: input.endpoint },
        create: {
          userId: ctx.user.id,
          endpoint: input.endpoint,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
        },
        update: {
          userId: ctx.user.id,
          p256dh: input.keys.p256dh,
          auth: input.keys.auth,
          userAgent: input.userAgent ?? null,
          failureCount: 0,
        },
      });

      return { ok: true };
    }),

  unsubscribe: protectedProcedure
    .input(z.object({ endpoint: z.string().max(2048) }))
    .mutation(async ({ ctx, input }) => {
      await prisma.pushSubscription.deleteMany({
        where: { userId: ctx.user.id, endpoint: input.endpoint },
      });
      return { ok: true };
    }),

  removeDevice: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      await prisma.pushSubscription.deleteMany({ where: { userId: ctx.user.id, id: input.id } });
      return { ok: true };
    }),

  /** "Did that work?" — answered by the phone buzzing, not by a toast. */
  test: protectedProcedure.mutation(async ({ ctx }) => {
    const result = await sendToUser(ctx.user.id, {
      title: 'Notifications are on',
      body: 'This is what a reminder from Fluid looks like.',
      url: '/today',
      tag: 'test',
    });
    return result;
  }),

  updatePreferences: protectedProcedure
    .input(
      z.object({
        enabled: z.boolean(),
        blockReminders: z.boolean(),
        dayPrompts: z.boolean(),
        leadMinutes: z.number().int().min(0).max(60),
        quietHoursStart: timeOfDay,
        quietHoursEnd: timeOfDay,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Half a quiet-hours window is no window at all.
      const quiet =
        input.quietHoursStart && input.quietHoursEnd
          ? { quietHoursStart: input.quietHoursStart, quietHoursEnd: input.quietHoursEnd }
          : { quietHoursStart: null, quietHoursEnd: null };

      const values = {
        nudgesEnabled: input.enabled,
        pushBlockReminders: input.blockReminders,
        pushDayPrompts: input.dayPrompts,
        reminderLeadMinutes: input.leadMinutes,
        ...quiet,
      };

      await prisma.userPreferences.upsert({
        where: { userId: ctx.user.id },
        create: { userId: ctx.user.id, ...values },
        update: values,
      });

      return { ok: true };
    }),
});
