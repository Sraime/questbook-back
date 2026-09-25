/// Affiche le code TOTP courant d'un compte du backoffice.
///
///   npx tsx scripts/totp-code.ts robin
///
/// C'est un outil de developpement, pour essayer un ecran sans sortir son
/// telephone a chaque rechargement. Il lit le secret en base et refait le
/// calcul que ferait l'application d'authentification.
///
/// **Il annule le second facteur**, et c'est pourquoi il refuse de tourner
/// ailleurs qu'en local. Le garde-fou n'est pas de la prudence de facade : le
/// jour ou l'on ouvre un tunnel vers le VPS, `DATABASE_URL` peut pointer
/// ailleurs qu'on ne le croit, et rien a l'ecran ne le dirait.
import { existsSync } from 'node:fs';
import { PrismaClient } from '@prisma/client';
import { currentStep, totpCode, TOTP_STEP_SECONDS } from '../src/lib/totp.js';

if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

const prisma = new PrismaClient();

const main = async (): Promise<void> => {
  const login = process.argv[2];

  if (!login) {
    console.error('Usage: npx tsx scripts/totp-code.ts <login>');
    process.exitCode = 1;
    return;
  }

  const url = process.env.DATABASE_URL ?? '';
  const host = url.match(/@([^:/?]+)/)?.[1] ?? '';

  if (!['localhost', '127.0.0.1', 'db', '::1'].includes(host)) {
    console.error(
      `Refus : cette base n'est pas locale (hote "${host || 'inconnu'}").\n` +
        "Ce script divulgue un second facteur, il n'a sa place que sur un poste de\n" +
        'developpement. Pour un compte reel, sortir le telephone.',
    );
    process.exitCode = 1;
    return;
  }

  const admin = await prisma.adminUser.findUnique({ where: { login } });

  if (!admin) {
    console.error(`Aucun compte "${login}". Le creer avec scripts/create-admin.ts.`);
    process.exitCode = 1;
    return;
  }

  const code = totpCode(admin.totpSecret, currentStep());
  const remaining = TOTP_STEP_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_STEP_SECONDS);

  console.log('');
  console.log(`  ${code}`);
  console.log('');
  console.log(`  encore valable ${remaining} s`);
};

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
