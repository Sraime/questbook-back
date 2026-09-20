import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { shopItemIdParamsSchema } from './shop.schemas.js';
import { ShopService } from './shop.service.js';

const shopRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ShopService(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/items', async (request) => ({
    items: await service.list(request.user.sub),
  }));

  app.get(
    '/items/:id',
    { schema: { params: shopItemIdParamsSchema } },
    async (request) => service.get(request.user.sub, request.params.id),
  );

  app.post(
    '/items/:id/purchase',
    { schema: { params: shopItemIdParamsSchema } },
    async (request) => service.purchase(request.user.sub, request.params.id),
  );
};

export default shopRoutes;
