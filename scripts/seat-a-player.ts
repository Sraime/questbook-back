/// Assoit un compte a une table dont l'autre siege est tenu par un compte de
/// controle, sur une seance commencee depuis une heure.
///
/// Voir la section « S'asseoir a une table sans second compte Google » du
/// README : c'est le seul moyen de voir les deux cotes d'une table sans
/// brancher un second compte Google sur l'emulateur.
///
///   npx tsx scripts/seat-a-player.ts                  # les comptes connus
///   npx tsx scripts/seat-a-player.ts questbook.nextus # joueur d'une table
///   npx tsx scripts/seat-a-player.ts questbook.nextus --mj  # MJ de la sienne
///
/// `--mj` inverse les roles. Plusieurs gestes ne se voient que d'un seul
/// cote — retirer un joueur, ou le bloquer, qui le sort de la table au lieu
/// de m'en faire sortir — et ils resteraient invisibles sans lui.
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const main = async () => {
  const args = process.argv.slice(2);
  const iAmGameMaster = args.includes('--mj');
  const needle = args.find((arg) => !arg.startsWith('--'));

  const users = await prisma.user.findMany({
    select: { id: true, email: true, displayName: true },
    orderBy: { createdAt: 'desc' },
  });

  // Sans argument, le script ne cree rien : il dit seulement qui il pourrait
  // asseoir. On ne devine pas l'adresse du compte connecte sur l'emulateur.
  if (!needle) {
    console.log('Comptes connus de la base de dev :');
    console.table(users.map((u) => ({ email: u.email, nom: u.displayName ?? '—' })));
    console.log('\nRelancer avec un fragment d’adresse pour asseoir ce compte.');
    return;
  }

  const me = users.find((u) => u.email.includes(needle));
  if (!me) throw new Error(`Aucun compte ne contient « ${needle} »`);

  const stamp = Date.now().toString(36);
  const other = await prisma.user.create({
    data: {
      googleSub: `seat-other-${stamp}`,
      email: `${iAmGameMaster ? 'joueuse' : 'mj'}-${stamp}@local`,
      displayName: iAmGameMaster ? 'Hélène, joueuse' : 'Hélène, maîtresse du jeu',
    },
  });

  const owner = iAmGameMaster ? me : other;
  const table = await prisma.gameTable.create({
    data: {
      title: 'Les Ombres de Providence',
      universeLabel: 'Call of Cthulhu',
      ownerId: owner.id,
      members: {
        create: [
          { userId: owner.id, role: 'gm' },
          { userId: iAmGameMaster ? other.id : me.id, role: 'player' },
        ],
      },
    },
  });

  // Commencee, donc « Participer » s'affiche des que le joueur a repondu. Les
  // inscriptions restent ouvertes une heure apres la creation de la seance,
  // il peut donc encore repondre — c'est la fenetre des seances impromptues.
  const session = await prisma.gameSession.create({
    data: {
      tableId: table.id,
      title: 'La maison de Water Street',
      description: 'On reprend là où le carnet s’arrêtait.',
      startsAt: new Date(Date.now() - 60 * 60 * 1000),
      location: 'Chez Hélène',
    },
  });

  console.log(`MJ       ${owner.email}`);
  console.log(`Joueur   ${(iAmGameMaster ? other : me).email}`);
  console.log(`Table    ${table.title}`);
  console.log(`Séance   ${session.id}  (commencée il y a 1 h)`);
  console.log(`\nPousser le plateau :\n  npx tsx scripts/push-as-gm.ts ${session.id} 4`);
};

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
