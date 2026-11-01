/**
 * Download (or, for plain images, view) an attachment.
 *
 * Every response is locked down: nosniff so the browser cannot reinterpret
 * the bytes, and a sandboxing CSP so that even a file opened directly cannot
 * run script on this origin. Only raster images are served inline.
 */
import { INLINE_IMAGE_TYPES, openAttachment } from '@/server/services/attachments';
import { getCurrentUser } from '@/server/auth/session';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return new Response('Sign in to continue.', { status: 401 });

  const { id } = await params;
  const found = await openAttachment(user.id, id);
  if (!found) return new Response('Not found.', { status: 404 });

  const { attachment, stream, size } = found;
  const inline = INLINE_IMAGE_TYPES.has(attachment.contentType) && !new URL(request.url).searchParams.has('download');
  const asciiName = attachment.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');

  return new Response(stream, {
    headers: {
      'Content-Type': inline ? attachment.contentType : 'application/octet-stream',
      'Content-Length': String(size),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; sandbox",
      'Cache-Control': 'private, max-age=3600',
    },
  });
}
