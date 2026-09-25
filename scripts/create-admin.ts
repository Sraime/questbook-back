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
/// Hors terminal — un `echo | npx tsx` —, il n'y a rien a masquer et la ruse
/// ci-dessous ne marche pas : la seconde question ne se resoudrait jamais,
/// puisque l'entree est deja fermee, et le script s'eteindrait sans un mot.
/// Les lignes sont donc lues d'un bloc dans ce cas.
function askHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);

  return process.stdin.isTTY ? askFromTerminal() : askFromPipe();
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

/// Les lignes de l'entree, lues une fois et distribuees dans l'ordre.
let pipedLines: string[] | null = null;

async function askFromPipe(): Promise<string> {
  if (pipedLines === null) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) {
      chunks.push(Buffer.from(chunk));
    }
    pipedLines = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  }

  const line = pipedLines.shift();
  if (line === undefined) {
    throw new Error('Entree trop courte : un mot de passe et sa confirmation sont attendus.');
  }

  process.stdout.write('\n');
  return line;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
