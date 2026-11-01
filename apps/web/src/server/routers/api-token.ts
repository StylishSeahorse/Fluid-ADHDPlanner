/**
 * Managing personal access tokens, from Settings.
 *
 * Only a signed-in session reaches these: the REST API has no route to them,
 * so a token cannot mint more tokens or outlive its own revocation.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { protectedProcedure, router } from '../trpc';
import { createApiToken, listApiTokens, revokeApiToken } from '../services/api-tokens';

export const apiTokenRouter = router({
  list: protectedProcedure.query(({ ctx }) => listApiTokens(ctx.user.id)),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().trim().min(1).max(60),
        write: z.boolean().default(false),
        expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).nullable().default(90),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await createApiToken(ctx.user.id, {
          name: input.name,
          scopes: input.write ? ['read', 'write'] : ['read'],
          expiresInDays: input.expiresInDays,
        });
      } catch (error) {
        throw new TRPCError({ code: 'CONFLICT', message: error instanceof Error ? error.message : 'Could not make a token.' });
      }
    }),

  revoke: protectedProcedure.input(z.object({ id: z.string().min(1).max(64) })).mutation(async ({ ctx, input }) => {
    await revokeApiToken(ctx.user.id, input.id);
  }),
});
