import type { Prisma } from '@prisma/client';
import type { NotificationDraft } from '../notifications/notification.service.js';
import { publicLabel } from './table.access.js';
import { answersCloseAt, sessionClosesAt } from './session.window.js';

/// Ce que devient une inscription quand son investigateur est supprimé.
///
/// Venir, c'est venir avec quelqu'un : tant que les inscriptions sont
/// ouvertes, un « oui » qui perd son investigateur est retiré, et le joueur
/// se réinscrit avec un autre s'il le souhaite. Une fois la partie lancée,
/// on ne lui retire pas sa chaise : il garde sa place et nomme un autre
/// investigateur, ce que la séance permet jusqu'à sa clôture.
///
/// Les séances passées ou annulées ne bougent pas : elles racontent ce qui
/// a eu lieu, et le DTO y lit déjà un investigateur supprimé comme absent.
///
/// Appelée dans la transaction de la suppression, et rend les notifications
/// au MJ que l'appelant enregistre puis distribue.
export async function releaseCharacterFromSessions(
  tx: Prisma.TransactionClient,
  userId: string,
  characterId: string,
  now: Date = new Date(),
): Promise<NotificationDraft[]> {
  const attendances = await tx.sessionAttendance.findMany({
    where: { userId, characterId },
    include: {
      character: { select: { name: true } },
      session: {
        select: {
          id: true,
          title: true,
          status: true,
          startsAt: true,
          createdAt: true,
          table: { select: { id: true, title: true, ownerId: true } },
        },
      },
    },
  });

  const live = attendances.filter(
    ({ session }) =>
      session.status !== 'cancelled' && now < sessionClosesAt(session),
  );
  if (live.length === 0) return [];

  const player = await tx.user.findUniqueOrThrow({ where: { id: userId } });
  const playerName = publicLabel(player);
  const drafts: NotificationDraft[] = [];

  for (const attendance of live) {
    const { session } = attendance;
    const characterName = attendance.character?.name ?? 'son investigateur';
    const answersOpen = now < answersCloseAt(session);

    if (attendance.status === 'yes' && answersOpen) {
      await tx.sessionAttendance.delete({ where: { id: attendance.id } });
    } else {
      await tx.sessionAttendance.update({
        where: { id: attendance.id },
        data: { characterId: null },
      });
    }

    // Un « non » perd un investigateur que personne n'attendait : le MJ n'a
    // rien à en apprendre.
    if (attendance.status !== 'yes') continue;

    drafts.push(
      answersOpen
        ? {
            userId: session.table.ownerId,
            type: 'attendance_changed',
            title: `Réponse · ${session.table.title}`,
            body: `${playerName} a supprimé ${characterName} et n'est plus inscrit pour « ${session.title} »`,
            tableId: session.table.id,
            sessionId: session.id,
          }
        : {
            userId: session.table.ownerId,
            type: 'attendance_character_changed',
            title: `Investigateur · ${session.table.title}`,
            body: `${playerName} a supprimé ${characterName} et n'a plus d'investigateur pour « ${session.title} »`,
            tableId: session.table.id,
            sessionId: session.id,
          },
    );
  }

  return drafts;
}
