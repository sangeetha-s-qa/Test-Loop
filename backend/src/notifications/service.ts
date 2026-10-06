import type { NotificationType, Prisma } from "@prisma/client";

/**
 * In-app notifications. Written in the same transaction as the change they describe, so a bug can
 * never be assigned without its assignee being told, and nobody is told about a change that rolled
 * back. The person who made a change is never notified about it.
 */
export async function notify(
  tx: Prisma.TransactionClient,
  input: { organizationId: string; actorId: string; recipients: (string | null | undefined)[]; type: NotificationType; bugId: string; title: string; body?: string },
) {
  const recipients = [...new Set(input.recipients.filter((id): id is string => Boolean(id) && id !== input.actorId))];
  if (!recipients.length) return 0;
  // Only people still in the workspace hear about its bugs.
  const members = await tx.organizationMembership.findMany({ where: { organizationId: input.organizationId, userId: { in: recipients } }, select: { userId: true } });
  if (!members.length) return 0;
  const { count } = await tx.notification.createMany({
    data: members.map(member => ({ userId: member.userId, organizationId: input.organizationId, actorId: input.actorId, type: input.type, bugId: input.bugId, title: input.title.slice(0, 200), body: (input.body ?? "").slice(0, 500) })),
  });
  return count;
}
