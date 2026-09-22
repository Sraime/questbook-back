import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { ReportService } from './report.service.js';
import { createReportSchema } from './report.schemas.js';

export interface ReportRoutesOptions {
  reportsEmailTo: string;
}

/// Signaler est un geste rare, écrit une fois et relu par un humain : pas de
/// route pour lister ni pour reprendre. Ce qui se passe ensuite se passe dans
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

export default reportRoutes;
