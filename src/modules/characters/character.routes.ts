import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { CharacterService } from './character.service.js';
import {
  characterIdParamsSchema,
  createCharacterSchema,
  inventoryItemInputSchema,
  inventoryItemParamsSchema,
  listCharactersQuerySchema,
  patchCharacterSchema,
  patchInventoryItemSchema,
  patchResourceSchema,
  patchStatSchema,
  putCharacterSchema,
  resourceParamsSchema,
  statParamsSchema,
} from './character.schemas.js';

const characterRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new CharacterService(app.prisma);

  // Every route below belongs to the authenticated user, no exceptions.
  app.addHook('preHandler', app.authenticate);

  app.get(
    '/',
    { schema: { querystring: listCharactersQuerySchema } },
    async (request) => {
      const since = request.query.since ? new Date(request.query.since) : undefined;
      const characters = await service.list(request.user.sub, since);
      // `syncedAt` is the cursor the client should send as `since` next time.
      return { characters, syncedAt: new Date().toISOString() };
    },
  );

  app.post(
    '/',
    { schema: { body: createCharacterSchema } },
    async (request, reply) => {
      const character = await service.create(request.user.sub, request.body);
      return reply.code(201).send(character);
    },
  );

  app.get(
    '/:id',
    { schema: { params: characterIdParamsSchema } },
    async (request) => service.get(request.user.sub, request.params.id),
  );

  app.put(
    '/:id',
    { schema: { params: characterIdParamsSchema, body: putCharacterSchema } },
    async (request, reply) => {
      const { character, created } = await service.replace(
        request.user.sub,
        request.params.id,
        request.body,
      );
      return reply.code(created ? 201 : 200).send(character);
    },
  );

  app.patch(
    '/:id',
    { schema: { params: characterIdParamsSchema, body: patchCharacterSchema } },
    async (request) =>
      service.patch(request.user.sub, request.params.id, request.body),
  );

  app.delete(
    '/:id',
    { schema: { params: characterIdParamsSchema } },
    async (request, reply) => {
      await service.softDelete(request.user.sub, request.params.id);
      return reply.code(204).send();
    },
  );

  app.get(
    '/:id/inventory',
    { schema: { params: characterIdParamsSchema } },
    async (request) => {
      const character = await service.get(request.user.sub, request.params.id);
      return character.inventory;
    },
  );

  app.post(
    '/:id/inventory',
    { schema: { params: characterIdParamsSchema, body: inventoryItemInputSchema } },
    async (request, reply) => {
      const item = await service.addInventoryItem(
        request.user.sub,
        request.params.id,
        request.body,
      );
      return reply.code(201).send(item);
    },
  );

  app.patch(
    '/:id/inventory/:itemId',
    {
      schema: {
        params: inventoryItemParamsSchema,
        body: patchInventoryItemSchema,
      },
    },
    async (request) =>
      service.updateInventoryItem(
        request.user.sub,
        request.params.id,
        request.params.itemId,
        request.body,
      ),
  );

  app.delete(
    '/:id/inventory/:itemId',
    { schema: { params: inventoryItemParamsSchema } },
    async (request, reply) => {
      await service.removeInventoryItem(
        request.user.sub,
        request.params.id,
        request.params.itemId,
      );
      return reply.code(204).send();
    },
  );

  /// Keyed by the domain `key`, not a row id, to match how the Flutter
  /// repository already addresses stats and resources.
  app.patch(
    '/:id/stats/:kind/:key',
    { schema: { params: statParamsSchema, body: patchStatSchema } },
    async (request) =>
      service.setStatValue(
        request.user.sub,
        request.params.id,
        request.params.kind,
        request.params.key,
        request.body.value,
      ),
  );

  app.patch(
    '/:id/resources/:key',
    { schema: { params: resourceParamsSchema, body: patchResourceSchema } },
    async (request) =>
      service.setResourceValue(
        request.user.sub,
        request.params.id,
        request.params.key,
        request.body,
      ),
  );
};

export default characterRoutes;
