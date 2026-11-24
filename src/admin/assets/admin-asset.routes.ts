import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import {
  assetItemParamsSchema,
  createAssetSchema,
  updateAssetSchema,
} from './admin-asset.schemas.js';
import { AdminAssetService } from './admin-asset.service.js';

/// Une carte de 5 Mo pese pres de 6,7 Mo une fois en base64 : la limite de
/// 1 Mo que Fastify applique par defaut ne la laisserait pas passer.
const IMAGE_BODY_LIMIT = 8 * 1024 * 1024;

/// Les assets de la boutique s'ajoutent ici, sans release de l'app. Rien ne
/// se supprime : un article retire de la vente reste a ceux qui l'ont, et un
/// pion deja pose garde son dessin.
const adminAssetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AdminAssetService(app.prisma);

  app.addHook('preHandler', app.requireAdmin);

  app.get('/', async () => service.list());

  app.get('/:id', { schema: { params: assetItemParamsSchema } }, async (request) =>
    service.detail(request.params.id),
  );

  app.get('/:id/image', { schema: { params: assetItemParamsSchema } }, async (request, reply) => {
    const image = await service.image(request.params.id);
    return reply.type(image.type).header('cache-control', 'no-store').send(image.bytes);
  });

  app.post(
    '/',
    { bodyLimit: IMAGE_BODY_LIMIT, schema: { body: createAssetSchema } },
    async (request, reply) => {
      const asset = await service.create(currentAdmin(request).admin.id, request.body);
      return reply.code(201).send(asset);
    },
  );

  app.patch(
    '/:id',
    {
      bodyLimit: IMAGE_BODY_LIMIT,
      schema: { params: assetItemParamsSchema, body: updateAssetSchema },
    },
    async (request) =>
      service.update(request.params.id, currentAdmin(request).admin.id, request.body),
  );
};

export default adminAssetRoutes;
