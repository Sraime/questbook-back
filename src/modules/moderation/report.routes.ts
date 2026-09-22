import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { BlockService } from './block.service.js';
import { blockParamsSchema, createBlockSchema } from './block.schemas.js';
import { ReportService } from './report.service.js';
import { createReportSchema } from './report.schemas.js';

export interface ReportRoutesOptions {
  reportsEmailTo: string;
}

/// Signaler est un geste rare, écrit une fois et relu par un humain : pas de
/// route pour reprendre ni pour relire. Ce qui se passe ensuite se passe dans
/// la boîte du support, pas dans l'app.
const reportRoutes: FastifyPluginAsync<ReportRoutesOptions> = async (fastify, options) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ReportService(app.prisma, app.email, app.log, {
    reportsEmailTo: options.reportsEmailTo,
  });

  app.addHook('preHandler', app.authenticate);

  app.post('/', { schema: { body: createReportSchema } }, async (request, reply) => {
    const report = await service.create(request.user.sub, request.body);
    return reply.code(201).send(report);
  });
};

/// Bloquer, lui, s'annule — et la liste existe pour cela. Un geste qui ne se
/// défait pas et qu'on ne peut même pas relire se paierait en demandes au
/// support : « j'ai bloqué la mauvaise personne ».
export const blockRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new BlockService(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => ({
    blocks: await service.list(request.user.sub),
  }));

  app.post('/', { schema: { body: createBlockSchema } }, async (request, reply) => {
    const outcome = await service.block(request.user.sub, request.body.userId);
    return reply.code(201).send(outcome);
  });

  app.delete(
    '/:userId',
    { schema: { params: blockParamsSchema } },
    async (request, reply) => {
      await service.unblock(request.user.sub, request.params.userId);
      return reply.code(204).send();
    },
  );
};

export default reportRoutes;
