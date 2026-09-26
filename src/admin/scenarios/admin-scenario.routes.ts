import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import {
  createScenarioSchema,
  scenarioIdParamsSchema,
  updateScenarioSchema,
} from './admin-scenario.schemas.js';
import { AdminScenarioService } from './admin-scenario.service.js';

/// Le catalogue s'ecrit ici, et nulle part ailleurs : cote produit, les
/// scenarios sont en lecture seule, et la seule facon d'en ajouter un etait
/// jusqu'ici un `INSERT` ecrit a la main dans une migration.
const adminScenarioRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AdminScenarioService(app.prisma);

  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => service.list());

  app.get('/:id', { schema: { params: scenarioIdParamsSchema } }, async (request) =>
    service.detail(request.params.id),
  );

  app.post('/', { schema: { body: createScenarioSchema } }, async (request, reply) => {
    const scenario = await service.create(currentAdmin(request).admin.id, request.body);
    return reply.code(201).send(scenario);
  });

  app.patch(
    '/:id',
    { schema: { params: scenarioIdParamsSchema, body: updateScenarioSchema } },
    async (request) =>
      service.update(request.params.id, currentAdmin(request).admin.id, request.body),
  );
};

export default adminScenarioRoutes;
