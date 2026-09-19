import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { scenarioIdParamsSchema } from './scenario.schemas.js';
import { ScenarioService } from './scenario.service.js';

const scenarioRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ScenarioService(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async (request) => ({
    scenarios: await service.list(request.user.sub),
  }));

  app.get(
    '/:id',
    { schema: { params: scenarioIdParamsSchema } },
    async (request) => service.get(request.user.sub, request.params.id),
  );
};

export default scenarioRoutes;
