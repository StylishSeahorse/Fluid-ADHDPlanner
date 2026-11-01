/**
 * The live-updates stream for one tab (server-sent events).
 *
 * Sends `refresh` whenever something this user can see changed, and a comment
 * every 25 seconds so proxies do not close an idle connection. Messages say
 * only *that* something changed; the page re-reads the data itself.
 */
import { prisma } from '@fluid/db';
import { subscribe, userChannel, workspaceChannel } from '@/server/live';
import { getCurrentUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const HEARTBEAT_MS = 25_000;

export async function GET(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response(null, { status: 401 });

  const memberships = await prisma.workspaceMember.findMany({ where: { userId: user.id }, select: { workspaceId: true } });
  const channels = [userChannel(user.id), ...memberships.map((membership) => workspaceChannel(membership.workspaceId))];

  const encoder = new TextEncoder();
  let cleanup = () => {};

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup();
        }
      };

      // Tell the browser how long to wait before reconnecting after a drop.
      send('retry: 5000\n\n');
      const unsubscribe = subscribe(channels, (message) => send(`event: refresh\ndata: ${JSON.stringify(message)}\n\n`));
      const heartbeat = setInterval(() => send(': keep-alive\n\n'), HEARTBEAT_MS);

      cleanup = () => {
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      request.signal.addEventListener('abort', () => cleanup());
    },
    cancel() {
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Tells nginx-style proxies not to buffer the stream.
      'X-Accel-Buffering': 'no',
    },
  });
}
