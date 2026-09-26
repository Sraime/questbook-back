// Fait passer une vraie invitation par le service, sur la base de dev, et
// imprime le mail tel qu'il partirait. Sert a lire de ses yeux ce qu'un
// invite recoit, ce que ni un test ni les journaux de `npm run dev` ne
// montrent en entier.
//
//   npx tsx scripts/voir-mail-invitation.ts

import { PrismaClient } from '@prisma/client';
import { TableService } from '../src/modules/tables/table.service.js';
import { NotificationService } from '../src/modules/notifications/notification.service.js';
import type { EmailMessage, EmailSender } from '../src/lib/email-sender.js';

const prisma = new PrismaClient();

if (process.argv.includes('--nettoyer')) {
  const tables = await prisma.gameTable.findMany({
    where: { owner: { email: 'mj@demo.questbook.test' } },
    select: { id: true },
  });
  const ids = tables.map((t) => t.id);
  await prisma.tableInvitation.deleteMany({ where: { tableId: { in: ids } } });
  await prisma.tableMember.deleteMany({ where: { tableId: { in: ids } } });
  await prisma.gameTable.deleteMany({ where: { id: { in: ids } } });
  await prisma.user.deleteMany({ where: { email: 'mj@demo.questbook.test' } });
  console.log(`${ids.length} table(s) de demonstration retiree(s).`);
  await prisma.$disconnect();
  process.exit(0);
}

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refus : DATABASE_URL ne pointe pas sur une base locale.');
  process.exit(1);
}

const envoyes: EmailMessage[] = [];
const collecteur: EmailSender = {
  async send(message) {
    envoyes.push(message);
  },
};

const notifications = new NotificationService(prisma, {
  async send() {
    /* pas de push ici */
  },
} as never);

const service = new TableService(prisma, notifications, collecteur, {
  publicBaseUrl: 'http://localhost:3000',
  invitationTtlDays: 7,
});

const mj = await prisma.user.upsert({
  where: { email: 'mj@demo.questbook.test' },
  update: {},
  create: {
    email: 'mj@demo.questbook.test',
    displayName: 'La Voix du Donjon',
    googleSub: `demo-mj-${Date.now()}`,
  },
});

// Par le service, et non par Prisma : creer la ligne de table ne fait pas du
// MJ un membre, et `invite` refuse alors sa propre table.
const table = await service.create(mj.id, { title: 'Les Caves de Ravenloft' });

const inconnu = `invite-${Date.now()}@example.com`;
await service.invite(mj.id, table.id, { email: inconnu });

const mail = envoyes.at(-1);
console.log('\n=============== ce que recoit une adresse sans compte ===============');
console.log(`A         : ${mail?.to}`);
console.log(`Objet     : ${mail?.subject}`);
console.log('---------------------------------------------------------------------');
console.log(mail?.text);
console.log('=====================================================================');

const fautif = /Google|Apple/.exec(`${mail?.text}${mail?.html}`);
console.log(fautif ? `\nATTENTION : le mail dit « ${fautif[0]} »` : '\nAucun fournisseur nomme.');
console.log(
  mail?.html?.includes('<strong>cette adresse</strong>')
    ? 'Le gras du HTML porte bien sur « cette adresse ».'
    : 'ATTENTION : le gras du HTML ne porte pas sur « cette adresse ».',
);

// `--garder` laisse l'invitation vivante, sans quoi le lien ci-dessus est
// mort a la seconde ou on veut l'ouvrir.
if (process.argv.includes('--garder')) {
  console.log('\nInvitation laissee en base : le lien ci-dessus est ouvrable.');
  console.log(`Pour retirer la table ensuite : --nettoyer`);
} else {
  await prisma.tableInvitation.deleteMany({ where: { tableId: table.id } });
  await prisma.gameTable.delete({ where: { id: table.id } });
  await prisma.user.delete({ where: { id: mj.id } });
  console.log('\nLa table et le compte de demonstration ont ete retires.');
}

await prisma.$disconnect();
