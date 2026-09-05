import { PrismaClient } from '@prisma/client';
import type { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';

declare module 'fastify' {
  interface FastifyInstance {
    prisma: PrismaClient;
  }
}

export interface PrismaPluginOptions {
  databaseUrl: string;
  /// Tests pass an already-connected client so the whole suite shares one pool.
  client?: PrismaClient;
}

const prismaPlugin: FastifyPluginAsync<PrismaPluginOptions> = async (app, options) => {
  const externallyOwned = options.client !== undefined;
  const prisma =
    options.client ??
    new PrismaClient({ datasources: { db: { url: options.databaseUrl } } });

  await prisma.$connect();
  app.decorate('prisma', prisma);

  app.addHook('onClose', async () => {
    if (!externallyOwned) {
      await prisma.$disconnect();
    }
  });
};

export default fp(prismaPlugin, { name: 'prisma' });
