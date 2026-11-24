import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import {
  bundleItemParamsSchema,
  createBundleSchema,
  updateBundleSchema,
} from './admin-bundle.schemas.js';
import { AdminBundleService } from './admin-bundle.service.js';

/// Une image de 2 Mo pese pres de 2,7 Mo en base64, au-dela du megaoctet que
/// Fastify accepte par defaut.
const IMAGE_BODY_LIMIT = 4 * 1024 * 1024;

const adminBundleRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AdminBundleService(app.prisma);

  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => service.list());

  app.get('/:id', { schema: { params: bundleItemParamsSchema } }, async (request) =>
    service.detail(request.params.id),
  );

  app.get('/:id/image', { schema: { params: bundleItemParamsSchema } }, async (request, reply) => {
    const image = await service.image(request.params.id);
    return reply.type(image.type).header('cache-control', 'no-store').send(image.bytes);
  });

  app.post(
    '/',
    { bodyLimit: IMAGE_BODY_LIMIT, schema: { body: createBundleSchema } },
    async (request, reply) => {
      const bundle = await service.create(currentAdmin(request).admin.id, request.body);
      return reply.code(201).send(bundle);
    },
  );

  app.patch(
    '/:id',
    {
      bodyLimit: IMAGE_BODY_LIMIT,
      schema: { params: bundleItemParamsSchema, body: updateBundleSchema },
    },
    async (request) =>
      service.update(request.params.id, currentAdmin(request).admin.id, request.body),
  );
};

export default adminBundleRoutes;
