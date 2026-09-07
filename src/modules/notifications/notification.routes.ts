import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  listNotificationsQuerySchema,
  markReadSchema,
} from './notification.schemas.js';

const notificationRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.addHook('preHandler', app.authenticate);

  app.get(
    '/',
    { schema: { querystring: listNotificationsQuerySchema } },
    async (request) => ({
      notifications: await app.notifications.list(
        request.user.sub,
        request.query.limit,
      ),
      unreadCount: await app.notifications.unreadCount(request.user.sub),
    }),
  );

  app.post(
    '/read',
    { schema: { body: markReadSchema } },
    async (request, reply) => {
      await app.notifications.markRead(request.user.sub, request.body.ids);
      return reply.code(204).send();
    },
  );

  app.post('/read-all', async (request, reply) => {
    await app.notifications.markAllRead(request.user.sub);
    return reply.code(204).send();
  });
};

export default notificationRoutes;
