/**
 * Upload a file to a card. Multipart: `taskId` and `file`.
 *
 * A route handler rather than a server action: actions are capped at 1 MB on
 * purpose, and files are not small.
 */
import { TRPCError } from '@trpc/server';
import { addAttachment } from '@/server/services/attachments';
import { MAX_UPLOAD_BYTES, UploadTooLargeError } from '@/server/services/storage';
import { getCurrentUser } from '@/server/auth/session';
import { notifyBoardChange } from '@/server/live-notify';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: 'Sign in to continue.' }, { status: 401 });

  // Refuse an oversize body before reading it, when the client says how big it is.
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES + 64 * 1024) {
    return Response.json({ error: new UploadTooLargeError().message }, { status: 413 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json({ error: 'That upload did not arrive in one piece. Try again.' }, { status: 400 });
  }

  const taskId = String(form.get('taskId') ?? '');
  const file = form.get('file');
  if (!taskId || !(file instanceof File) || file.size === 0) {
    return Response.json({ error: 'Choose a file to attach.' }, { status: 400 });
  }
  if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: new UploadTooLargeError().message }, { status: 413 });

  try {
    const attachment = await addAttachment(user.id, taskId, { name: file.name, type: file.type, stream: file.stream() });
    await notifyBoardChange(user.id);
    return Response.json({ id: attachment.id, filename: attachment.filename }, { status: 201 });
  } catch (error) {
    if (error instanceof UploadTooLargeError) return Response.json({ error: error.message }, { status: 413 });
    if (error instanceof TRPCError) return Response.json({ error: error.message }, { status: 404 });
    console.error('[attachments] upload failed', error);
    return Response.json({ error: 'Could not save that file.' }, { status: 500 });
  }
}
