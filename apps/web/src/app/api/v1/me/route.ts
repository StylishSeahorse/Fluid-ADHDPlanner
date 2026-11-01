import { apiRoute } from '@/server/api/handler';

export const dynamic = 'force-dynamic';

/** Who the token acts as. Handy for checking a token works. */
export const GET = apiRoute('read', async ({ user }) => ({
  id: user.id,
  email: user.email,
  timeZone: user.timeZone,
}));
