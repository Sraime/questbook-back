import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AssetService } from './asset.service.js';

const assetKeyParamsSchema = z.object({ key: z.string().min(1).max(80) });

const assetRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AssetService(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get('/', async () => ({ assets: await service.list() }));

  /// The picture never changes under a given hash, and the app asks for it
  /// once per hash: the ETag spares a second download, the long max-age
  /// anything that sits between the two.
  app.get(
    '/:key/image',
    { schema: { params: assetKeyParamsSchema } },
    async (request, reply) => {
      const image = await service.image(request.params.key);
      const etag = `"${image.hash}"`;

      reply
        .header('etag', etag)
        .header('cache-control', 'private, max-age=31536000, immutable');

      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }

      return reply.type(image.type).send(image.bytes);
    },
  );
};

export default assetRoutes;
