// Joue le parcours complet d'un indice sur la base de dev, en passant par les
// services, et montre a chaque etape ce que le MJ voit et ce que chaque joueur
// voit. Sert a verifier de ses yeux qu'un indice ne fuit pas.
//
//   npx tsx scripts/voir-indices.ts

import { PrismaClient } from '@prisma/client';
import { ClueService } from '../src/modules/tables/clue.service.js';
import { TableService } from '../src/modules/tables/table.service.js';
import { NotificationService } from '../src/modules/notifications/notification.service.js';

const prisma = new PrismaClient();

if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? '')) {
  console.error('Refus : DATABASE_URL ne pointe pas sur une base locale.');
  process.exit(1);
}

const notifications = new NotificationService(prisma, { async send() {} } as never);
const tables = new TableService(prisma, notifications, { async send() {} }, {
  publicBaseUrl: 'http://localhost:3000',
  invitationTtlDays: 7,
});
const clues = new ClueService(prisma);

const compte = (nom: string, email: string) =>
  prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, displayName: nom, googleSub: `demo-${email}-${Date.now()}` },
  });

const mj = await compte('La Voix du Donjon', 'mj-indices@demo.questbook.test');
const alice = await compte('Alice', 'alice-indices@demo.questbook.test');
const bob = await compte('Bob', 'bob-indices@demo.questbook.test');

const table = await tables.create(mj.id, { title: 'Le manoir Corbitt' });
for (const joueur of [alice, bob]) {
  await prisma.tableMember.create({
    data: { tableId: table.id, userId: joueur.id, role: 'player' },
  });
}

const session = await prisma.gameSession.create({
  data: {
    tableId: table.id,
    title: 'Premiere soiree',
    startsAt: new Date(Date.now() + 86_400_000),
    location: 'Chez Robin',
  },
});

const montrer = async (etape: string) => {
  const cotéMj = await clues.list(mj.id, session.id);
  const cotéAlice = await clues.listForPlayer(alice.id, session.id);
  const cotéBob = await clues.listForPlayer(bob.id, session.id);

  console.log(`\n--- ${etape}`);
  console.log(`  Le MJ voit  : ${cotéMj.map((c) => `${c.title} (${c.sharedWith.length})`).join(', ') || 'rien'}`);
  console.log(`  Alice voit  : ${cotéAlice.map((c) => c.title).join(', ') || 'rien'}`);
  console.log(`  Bob voit    : ${cotéBob.map((c) => c.title).join(', ') || 'rien'}`);
};

const lettre = await clues.create(mj.id, session.id, {
  title: 'La lettre de Corbitt',
  contentMarkdown: '## Mon ami\n\nNe descends pas a la cave.',
});
const plan = await clues.create(mj.id, session.id, {
  title: 'Le plan du sous-sol',
  contentMarkdown: 'Trois pieces, une seule porte.',
});

await montrer('deux indices composes, rien de partage');
await clues.setAccess(mj.id, session.id, lettre.id, { userIds: [alice.id] });
await montrer('la lettre est ouverte a Alice seule');
await clues.setAccess(mj.id, session.id, plan.id, { userIds: [alice.id, bob.id] });
await montrer('le plan va aux deux');
await clues.setAccess(mj.id, session.id, plan.id, { userIds: [alice.id] });
await montrer('le MJ reprend le plan a Bob');

console.log('\n--- ce qu Alice recoit vraiment, champ par champ');
console.log(JSON.stringify((await clues.listForPlayer(alice.id, session.id))[0], null, 2));

await tables.removeMember(mj.id, table.id, alice.id);
console.log('\n--- Alice est retiree de la table');
console.log(
  `  permissions restantes pour elle en base : ${await prisma.sessionClueAccess.count({ where: { userId: alice.id } })}`,
);
console.log(
  `  ce que le MJ lit desormais : ${(await clues.list(mj.id, session.id)).map((c) => `${c.title} (${c.sharedWith.length})`).join(', ')}`,
);

await prisma.gameTable.delete({ where: { id: table.id } });
await prisma.user.deleteMany({
  where: { email: { in: [mj.email, alice.email, bob.email] } },
});
console.log('\nLa table et les comptes de demonstration ont ete retires.');

await prisma.$disconnect();
