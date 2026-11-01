/**
 * Attachments: files on cards.
 *
 * The rules that keep them safe:
 *   - Only the card's owner can add, read or remove its files (checked on
 *     every request, not just when a link is shown).
 *   - Storage keys are ours; the original filename is display text only.
 *   - Raster images may be shown inline. Everything else downloads — an
 *     uploaded HTML or SVG file must never run as a page on this origin.
 */
import 'server-only';
import { TRPCError } from '@trpc/server';
import { prisma } from '@fluid/db';
import { logActivity } from './boards';
import { newStorageKey, putObject, readObject, removeObject } from './storage';

/** Types a browser may render inline. Notably not SVG (it can carry script). */
export const INLINE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** A display name safe for headers and the UI: no paths, no control characters. */
export function cleanFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200);
  return cleaned || 'file';
}

async function ownCard(userId: string, taskId: string) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, userId },
    select: { id: true, title: true, boardId: true, board: { select: { workspaceId: true } } },
  });
  if (!task) throw new TRPCError({ code: 'NOT_FOUND', message: 'That card no longer exists.' });
  return task;
}

export async function addAttachment(
  userId: string,
  taskId: string,
  file: { name: string; type: string; stream: ReadableStream<Uint8Array> },
) {
  const task = await ownCard(userId, taskId);
  const storageKey = newStorageKey();
  const { size, sha256 } = await putObject(storageKey, file.stream);
  const filename = cleanFilename(file.name);

  try {
    const attachment = await prisma.attachment.create({
      data: {
        taskId: task.id,
        uploaderId: userId,
        storageKey,
        filename,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: size,
        sha256,
      },
    });
    if (task.board) {
      await logActivity(prisma, {
        workspaceId: task.board.workspaceId,
        boardId: task.boardId,
        taskId: task.id,
        actorId: userId,
        verb: 'attached',
        summary: `Attached “${filename}” to “${task.title}”`,
      });
    }
    return attachment;
  } catch (error) {
    await removeObject(storageKey); // no row, no file
    throw error;
  }
}

export async function openAttachment(userId: string, attachmentId: string) {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, task: { userId } },
  });
  if (!attachment) return null;
  const object = await readObject(attachment.storageKey).catch(() => null);
  return object ? { attachment, ...object } : null;
}

export async function deleteAttachment(userId: string, attachmentId: string): Promise<void> {
  const attachment = await prisma.attachment.findFirst({
    where: { id: attachmentId, task: { userId } },
    include: { task: { select: { title: true, boardId: true, board: { select: { workspaceId: true } } } } },
  });
  if (!attachment) throw new TRPCError({ code: 'NOT_FOUND', message: 'That file is already gone.' });

  await prisma.attachment.delete({ where: { id: attachment.id } });
  await removeObject(attachment.storageKey);
  if (attachment.task.board) {
    await logActivity(prisma, {
      workspaceId: attachment.task.board.workspaceId,
      boardId: attachment.task.boardId,
      taskId: attachment.taskId,
      actorId: userId,
      verb: 'detached',
      summary: `Removed “${attachment.filename}” from “${attachment.task.title}”`,
    });
  }
}
