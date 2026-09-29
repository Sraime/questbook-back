/// Importe une aventure dans le catalogue et la reserve a des comptes nommes.
///
///   npm run scenario:import -- --pour robin@exemple.fr < document.json
///   npm run scenario:import -- --pour a@b.fr --pour c@d.fr --remplacer < doc.json
///
/// Et sur le serveur, ou le script vit dans l'image plutot que dans le depot :
///
///   ssh ... "cd /opt/questbook && docker compose exec -T api \
///     node dist/admin/cli/import-scenario.js --pour robin@exemple.fr" < doc.json
///
/// Le document arrive **sur l'entree standard**, et pas par un chemin. Une
/// aventure du commerce n'a alors rien a faire sur le disque du serveur, ni
/// dans un depot qui se trouve etre public : elle passe par le tuyau, et il ne
/// reste qu'une ligne en base.
///
/// `grantOnSignup` est force a faux, quoi que dise le document. C'est la
/// raison d'etre de cette commande : le drapeau ne connait que personne ou
/// tout le monde, et ce qu'on veut ici est quelqu'un.
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { createScenarioSchema } from '../scenarios/admin-scenario.schemas.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const prisma = new PrismaClient();

const USAGE = [
  'Usage : npm run scenario:import -- --pour <courriel> [--pour ...] [--remplacer] < document.json',
  '',
  "Le document se lit sur l'entree standard. Sans redirection, il n'y a rien a lire.",
].join('\n');

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const replace = args.includes('--remplacer');
  const emails = args.flatMap((arg, index) => {
    const next = args[index + 1];
    return arg === '--pour' && next !== undefined ? [next] : [];
  });

  if (emails.length === 0) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  // Sans redirection, `process.stdin` est le clavier : la boucle de lecture
  // ci-dessous n'aurait aucune raison de finir, et le script passerait pour
  // fige alors qu'il attend sagement une aventure qui ne viendra jamais.
  if (process.stdin.isTTY) {
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }

  const document = parseDocument(await readStdin());

  // Un courriel inconnu arrete tout, avant la moindre ecriture. Importer sans
  // donner laisserait dans le catalogue une aventure que personne ne peut
  // lire, et que rien a l'ecran ne signale.
  const owners = await prisma.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, displayName: true },
  });

  const missing = emails.filter((email) => !owners.some((owner) => owner.email === email));
  if (missing.length > 0) {
    console.error(`Compte inconnu : ${missing.join(', ')}. Rien n'a ete ecrit.`);
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.scenario.findFirst({
    where: { title: document.title },
    select: { id: true },
  });

  if (existing && !replace) {
    console.error(
      `« ${document.title} » est deja au catalogue. Relancer avec --remplacer pour en reecrire le contenu.`,
    );
    process.exitCode = 1;
    return;
  }

  const scenarioId = existing
    ? await replaceScenario(existing.id, document)
    : await createScenario(document);

  for (const owner of owners) {
    await prisma.scenarioOwnership.upsert({
      where: { userId_scenarioId: { userId: owner.id, scenarioId } },
      create: { userId: owner.id, scenarioId, source: 'grant' },
      update: {},
    });
  }

  console.log('');
  console.log(`${existing ? 'Remplace' : 'Importe'} : « ${document.title} »`);
  console.log(`  ${document.npcs.length} PNJ, ${document.clues.length} indices`);
  console.log(`  donnee a la connexion : non`);
  for (const owner of owners) {
    console.log(`  lisible par : ${owner.displayName} <${owner.email}>`);
  }
  console.log('');
};

/// Le document tel qu'il entre, valide par le schema du backoffice : une
/// aventure importee ne doit pas pouvoir etre plus laxiste qu'une aventure
/// saisie a la main.
function parseDocument(raw: string): ReturnType<typeof createScenarioSchema.parse> {
  // Un fichier ecrit sous Windows commence souvent par une marque d'ordre des
  // octets, invisible partout sauf devant `JSON.parse`, qui refuse alors le
  // document sur une erreur de syntaxe a la position zero.
  const parsed = createScenarioSchema.parse(JSON.parse(raw.replace(/^\uFEFF/, '')));
  return { ...parsed, grantOnSignup: false };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function createScenario(
  document: ReturnType<typeof createScenarioSchema.parse>,
): Promise<string> {
  const { npcs, clues, ...fields } = document;

  const created = await prisma.scenario.create({
    data: {
      ...fields,
      npcs: { create: npcs.map((npc, index) => ({ ...npc, sortOrder: index })) },
      clues: { create: clues.map((clue, index) => ({ ...clue, sortOrder: index })) },
    },
    select: { id: true },
  });

  return created.id;
}

/// Reecrit une aventure de bout en bout.
///
/// Les PNJ et les indices sont refaits, donc **renumerotes** : un indice deja
/// transmis pendant une seance perd la trace de qui l'avait recu. C'est le
/// prix d'un document qui ne porte pas d'identifiants, et la raison pour
/// laquelle `--remplacer` doit se demander.
///
/// La date est posee a la main. `@updatedAt` suffirait ici, puisque les champs
/// changent, mais l'ecrire rend le contrat visible : c'est cette date qui fait
/// apparaitre « Mettre a jour » sur les appareils qui gardent une copie.
async function replaceScenario(
  id: string,
  document: ReturnType<typeof createScenarioSchema.parse>,
): Promise<string> {
  const { npcs, clues, ...fields } = document;

  await prisma.$transaction(async (tx) => {
    await tx.scenarioNpc.deleteMany({ where: { scenarioId: id } });
    await tx.scenarioClue.deleteMany({ where: { scenarioId: id } });

    await tx.scenario.update({
      where: { id },
      data: {
        ...fields,
        updatedAt: new Date(),
        npcs: { create: npcs.map((npc, index) => ({ ...npc, sortOrder: index })) },
        clues: { create: clues.map((clue, index) => ({ ...clue, sortOrder: index })) },
      },
    });
  });

  return id;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
