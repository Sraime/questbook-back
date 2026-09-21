/// Pousse un plateau au nom du MJ d'une seance, pour regarder l'ecran d'un
/// joueur le suivre. Voir `seat-a-player.ts` et le README.
///
///   npx tsx scripts/push-as-gm.ts <sessionId> [nombre de pions] [carte]
///
/// Les identifiants de carte se lisent dans `board_catalog.dart` de l'app :
/// `manoir`, `grille`. Sans argument, le plateau garde la carte par defaut.
import 'dotenv/config';
import { createSigner } from 'fast-jwt';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Un compte de controle n'a pas de compte Google derriere lui : rien ne le
// connecterait autrement.
const sign = createSigner({ key: process.env.JWT_SECRET!, expiresIn: 600_000 });

const kinds = ['character', 'environment', 'effect', 'zone_disc'];
const colors = ['red', 'green', 'blue', 'yellow'];

const main = async () => {
  const [sessionId, count = '1', mapId] = process.argv.slice(2);
  if (!sessionId) throw new Error('Donner l’identifiant de la séance');

  const gm = await prisma.tableMember.findFirstOrThrow({
    where: { role: 'gm', table: { sessions: { some: { id: sessionId } } } },
    select: { userId: true, user: { select: { displayName: true } } },
  });

  // Quatre par ligne, de formes et de couleurs differentes : de quoi voir
  // d'un coup d'oeil si tout est arrive et rien n'a bouge de place.
  const tokens = Array.from({ length: Number(count) }, (_, i) => ({
    id: `pion-${i}`,
    kind: kinds[i % kinds.length],
    color: colors[i % colors.length],
    x: 0.2 + (i % 4) * 0.2,
    y: 0.25 + Math.floor(i / 4) * 0.25,
    size: 0.09,
  }));

  const response = await fetch(
    `http://127.0.0.1:3000/api/v1/sessions/${sessionId}/board`,
    {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${sign({ sub: gm.userId })}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ tokens: JSON.stringify(tokens), mapId }),
    },
  );

  const body = (await response.json()) as { revision?: number; mapId?: string };
  console.log(`${response.status} — poussé par ${gm.user.displayName}`);
  console.log(
    `révision ${body.revision}, carte ${body.mapId ?? '(défaut)'}, ${tokens.length} pion(s)`,
  );
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
