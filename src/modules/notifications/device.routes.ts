import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  deviceTokenParamsSchema,
  registerDeviceSchema,
} from './notification.schemas.js';

/// Where the app hands over its FCM registration token. Registration is a PUT
/// because the client replays it on every sign-in and on every token refresh.
const deviceRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', app.authenticate);

  app.put(
    '/',
    { schema: { body: registerDeviceSchema } },
    async (request, reply) => {
      await app.notifications.registerDevice(request.user.sub, request.body);
      return reply.code(204).send();
    },
  );

  /// Called on sign-out so a shared device stops receiving another player's
  /// notifications.
  app.delete(
    '/:token',
    { schema: { params: deviceTokenParamsSchema } },
    async (request, reply) => {
      await app.notifications.unregisterDevice(request.user.sub, request.params.token);
      return reply.code(204).send();
    },
  );
};

export default deviceRoutes;
