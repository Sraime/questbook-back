/// Cree un compte du backoffice, ou reinitialise celui qui porte ce login.
///
/// Il n'y a pas de route d'inscription : un backoffice qui en ouvrirait une
/// donnerait a Internet le formulaire qu'on cherche justement a lui cacher.
/// Un compte se cree donc ici, sur le serveur, la main sur le clavier.
///
///   npx tsx scripts/create-admin.ts robin
///   npx tsx scripts/create-admin.ts robin --reset   # meme login, tout neuf
///
/// Le secret TOTP s'affiche une fois, sous la forme d'une URI `otpauth://` a
/// scanner. Il n'est pas reaffichable ensuite : la base n'en garde que de quoi
/// verifier un code, et le perdre veut dire relancer ce script avec `--reset`.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { PrismaClient } from '@prisma/client';
import { toString } from 'qrcode';
import { hashPassword } from '../src/lib/password.js';
import { generateTotpSecret, totpProvisioningUri } from '../src/lib/totp.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const MIN_PASSWORD_LENGTH = 12;

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const reset = args.includes('--reset');
  const login = args.find((arg) => !arg.startsWith('--'));

  if (!login) {
    console.error('Usage: npx tsx scripts/create-admin.ts <login> [--reset]');
    process.exitCode = 1;
    return;
  }

  const existing = await prisma.adminUser.findUnique({ where: { login } });

  if (existing && !reset) {
    console.error(
      `Le login "${login}" existe deja. Relancer avec --reset pour lui donner un nouveau mot de passe et un nouveau secret TOTP.`,
    );
    process.exitCode = 1;
    return;
  }

  // Annonce l'invisibilite de la frappe, et surtout : se termine par un saut
  // de ligne. Les invites qui suivent n'en ont pas, et un terminal ne rend pas
  // toujours une ligne incomplete — on croit alors le script fige, on l'arrete,
  // et on recommence.
  console.log('');
  console.log(`Choisir un mot de passe, ${MIN_PASSWORD_LENGTH} caracteres au moins.`);
  console.log(
    process.stdin.isTTY
      ? 'La frappe reste invisible : ni caracteres, ni asterisques.'
      : "Ce terminal n'est pas un TTY : la frappe s'affichera en clair.",
  );
  console.log('');

  const password = await askHidden('Mot de passe : ');
  const confirmation = await askHidden('Confirmer     : ');

  if (password !== confirmation) {
    console.error('Les deux saisies different.');
    process.exitCode = 1;
    return;
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(`Au moins ${MIN_PASSWORD_LENGTH} caracteres.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await hashPassword(password);
  const totpSecret = generateTotpSecret();

  await prisma.adminUser.upsert({
    where: { login },
    create: { login, passwordHash, totpSecret },
    // Un reset remet aussi les compteurs : un compte verrouille dont on vient
    // de changer le mot de passe n'a aucune raison de le rester.
    update: {
      passwordHash,
      totpSecret,
      lastTotpStep: null,
      failedCount: 0,
      lockedUntil: null,
      disabledAt: null,
    },
  });

  const uri = totpProvisioningUri(totpSecret, login, 'Questbook');

  console.log('');
  console.log(existing ? `Compte "${login}" reinitialise.` : `Compte "${login}" cree.`);
  console.log('');
  console.log("A scanner dans une application d'authentification, maintenant :");
  console.log('');

  // Le QR plutot que la seule URI : le secret doit passer dans un telephone,
  // et recopier trente-deux caracteres en base32 a la main est le genre de
  // geste qu'on rate deux fois avant d'abandonner.
  console.log(await toString(uri, { type: 'terminal', small: true }));

  console.log('  Si le QR passe mal, saisie manuelle de la cle :');
  console.log('');
  console.log(`    compte : Questbook:${login}`);
  console.log(`    cle    : ${totpSecret}`);
  console.log(`    type   : par temps (TOTP), 6 chiffres, 30 secondes`);
  console.log('');
  console.log('Rien de tout ceci ne sera reaffiche.');
};

/// Lit une saisie sans l'afficher. `readline` n'offre rien pour cela, d'ou le
/// masquage du flux de sortie pendant la question.
///
/// Encore faut-il un vrai terminal. `npx` lance node a travers un `.cmd` sous
/// Windows, et l'entree cesse alors d'etre un TTY : `isTTY` est indefini, le
/// masquage n'a plus de prise, et il reste a lire des lignes comme elles
/// viennent — d'un `echo |` ou d'un clavier, la difference ne se voit pas
/// d'ici.
///
/// **Ne pas y lire le flux jusqu'a sa fin.** C'est ce que faisait ce script, et
/// une saisie au clavier ne finit jamais : chaque Entree ajoutait une ligne a
/// une attente qui ne se resolvait pas, et l'on croyait le script gele.
function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return process.stdin.isTTY ? askFromTerminal() : askLine();
}

function askFromTerminal(): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    // `_writeToOutput` n'est pas dans les types publics de readline, mais c'est
    // le seul point d'accroche pour ne pas faire l'echo de la frappe.
    (rl as unknown as { _writeToOutput: (text: string) => void })._writeToOutput = () => {};

    rl.on('close', () => reject(new Error('Saisie interrompue.')));

    rl.question('', (answer) => {
      process.stdout.write('\n');
      rl.removeAllListeners('close');
      rl.close();
      resolve(answer);
    });
  });
}

/// Une seule interface pour tout le script : deux `createInterface` sur la
/// meme entree se volent les lignes, et la seconde question resterait sans
/// reponse.
let reader: ReturnType<typeof createInterface> | null = null;

/// Les lignes arrivees avant qu'on ne les demande. Un `echo a`nb |` livre les
/// deux d'un coup, souvent avant le premier `askLine`.
const arrived: string[] = [];
const waiting: ((line: string) => void)[] = [];
let inputEnded = false;

function askLine(): Promise<string> {
  if (reader === null) {
    reader = createInterface({ input: process.stdin, terminal: false });

    reader.on('line', (line) => {
      const next = waiting.shift();
      if (next) {
        next(line);
      } else {
        arrived.push(line);
      }
    });

    reader.on('close', () => {
      inputEnded = true;
      // Debloque ce qui attendait encore, plutot que de laisser le script
      // pendre sur une entree fermee.
      for (const resolve of waiting.splice(0)) {
        resolve('');
      }
    });
  }

  const ready = arrived.shift();
  if (ready !== undefined) {
    process.stdout.write('\n');
    return Promise.resolve(ready);
  }

  if (inputEnded) {
    return Promise.reject(
      new Error('Entree trop courte : un mot de passe et sa confirmation sont attendus.'),
    );
  }

  return new Promise((resolve) => {
    waiting.push((line) => {
      process.stdout.write('\n');
      resolve(line);
    });
  });
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    reader?.close();
    return prisma.$disconnect();
  });
