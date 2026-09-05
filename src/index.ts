import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildApp({ env });

  // Docker sends SIGTERM on `stop`; draining lets in-flight requests finish
  // and closes the Prisma pool cleanly.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'Shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  await app.listen({ host: env.HOST, port: env.PORT });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
