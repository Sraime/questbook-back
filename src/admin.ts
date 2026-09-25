import { buildAdminApp } from './admin/app.js';
import { loadEnv } from './config/env.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const app = await buildAdminApp({ env });

  // Docker sends SIGTERM on `stop`; draining lets in-flight requests finish
  // and closes the Prisma pool cleanly.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      app.log.info({ signal }, 'Shutting down');
      void app.close().then(() => process.exit(0));
    });
  }

  // `ADMIN_HOST` stays `0.0.0.0`, and that is not a contradiction with an API
  // nobody can reach: binding the container's loopback would make it invisible
  // to Docker's own port mapping too. What closes this API is the publish
  // address in `docker-compose.yml` — `127.0.0.1:4000:4000` — not this line.
  await app.listen({ host: env.ADMIN_HOST, port: env.ADMIN_PORT });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
