/// Pose quelques mesures dans la base de dev, pour que l'ecran des comptes
/// suspendus ait de quoi se regarder.
///
///   npx tsx scripts/seed-suspensions.ts
///   npx tsx scripts/seed-suspensions.ts --nettoyer
///
/// Les tests couvrent le tri et le filtre, mais ils travaillent sur une base
/// qu'ils vident aussitot. Rien ne peuple celle de dev, et un ecran de
/// moderation vide ne dit pas grand-chose de ce qu'il vaut une fois plein.
///
/// Un des comptes porte une mesure **deja expiree**, et c'est le plus utile du
/// lot : il ne doit pas apparaitre. `suspended_at` reste pose apres
/// l'echeance, et l'ecran qui le montrerait listerait des gens deja revenus.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/// Ce qui distingue ces comptes de vrais joueurs, et permet de les reprendre
/// tous au nettoyage sans toucher a rien d'autre.
const MARQUEUR = '@demo.questbook.test';

const days = (n: number) => new Date(Date.now() + n * 86_400_000);

const measures = [
  {
    name: 'Gorbak le Hurleur',
    reason: 'Insultes repetees envers deux joueuses de sa table, apres un premier rappel.',
    until: null,
    since: -19,
  },
  {
    name: 'Mirelle',
    reason: 'Titre de seance a caractere sexuel, visible depuis la liste publique.',
    until: days(1),
    since: -1,
  },
  {
    name: 'Tancrede',
    reason: "Partage d'un scenario achete, hors du cadre de la licence.",
    until: days(6),
    since: -2,
  },
  {
    name: 'Vex',
    reason: 'Mesure expiree : ce compte est revenu, et ne doit pas apparaitre.',
    until: days(-1),
    since: -8,
  },
];

const main = async (): Promise<void> => {
  // Le meme garde-fou que `totp-code.ts` : ce script ecrit des comptes
  // fictifs, et la base des vrais joueurs n'en veut pas.
  const host = (process.env.DATABASE_URL ?? '').match(/@([^:/?]+)/)?.[1] ?? '';

  if (!['localhost', '127.0.0.1', 'db', '::1'].includes(host)) {
    console.error(`Refus : cette base n'est pas locale (hote "${host || 'inconnu'}").`);
    process.exitCode = 1;
    return;
  }

  if (process.argv.includes('--nettoyer')) {
    const { count } = await prisma.user.deleteMany({
      where: { email: { endsWith: MARQUEUR } },
    });
    console.log(`${count} comptes de demonstration supprimes.`);
    return;
  }

  for (const measure of measures) {
    const handle = measure.name.split(' ')[0]!.toLowerCase();

    await prisma.user.upsert({
      where: { email: `${handle}${MARQUEUR}` },
      update: {
        suspendedAt: days(measure.since),
        suspendedUntil: measure.until,
        suspensionReason: measure.reason,
      },
      create: {
        email: `${handle}${MARQUEUR}`,
        displayName: measure.name,
        googleSub: `demo-${randomUUID()}`,
        suspendedAt: days(measure.since),
        suspendedUntil: measure.until,
        suspensionReason: measure.reason,
      },
    });
  }

  console.log(`\n${measures.length} comptes poses, dont un dont la mesure a expire.`);
  console.log("L'ecran doit en montrer trois, la mesure sans terme en tete.\n");
  console.log('Pour les retirer :  npx tsx scripts/seed-suspensions.ts --nettoyer\n');
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
