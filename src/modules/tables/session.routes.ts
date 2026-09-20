import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { NpcService } from './npc.service.js';
import { SessionService } from './session.service.js';
import {
  attendanceCharacterSchema,
  attendanceSchema,
  createNpcSchema,
  patchNpcSchema,
  patchSessionSchema,
  sessionAttendeeParamsSchema,
  sessionIdParamsSchema,
  sessionNpcParamsSchema,
} from './table.schemas.js';

/// Sessions are created under their table (see `table.routes.ts`) but read and
/// updated by their own id, so a notification can link straight to one.
const sessionRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new SessionService(app.prisma, app.notifications);
  const npcs = new NpcService(app.prisma);

  app.addHook('preHandler', app.authenticate);

  app.get(
    '/:id',
    { schema: { params: sessionIdParamsSchema } },
    async (request) => service.get(request.user.sub, request.params.id),
  );

  app.patch(
    '/:id',
    { schema: { params: sessionIdParamsSchema, body: patchSessionSchema } },
    async (request) => service.patch(request.user.sub, request.params.id, request.body),
  );

  /// Cancelling rather than deleting: players who had already answered should
  /// still see what happened to the evening they had blocked out.
  app.delete(
    '/:id',
    { schema: { params: sessionIdParamsSchema } },
    async (request) => service.cancel(request.user.sub, request.params.id),
  );

  app.put(
    '/:id/attendance',
    { schema: { params: sessionIdParamsSchema, body: attendanceSchema } },
    async (request) =>
      service.setAttendance(
        request.user.sub,
        request.params.id,
        request.body.status,
        request.body.characterId,
      ),
  );

  /// Split from the answer above so a player can confirm now and decide who
  /// they are playing later, and so the game master hears about the two
  /// changes separately.
  app.put(
    '/:id/attendance/character',
    { schema: { params: sessionIdParamsSchema, body: attendanceCharacterSchema } },
    async (request) =>
      service.setAttendanceCharacter(
        request.user.sub,
        request.params.id,
        request.body.characterId,
      ),
  );

  /// The one way to read someone else's sheet: they registered it for a session
  /// you are both at. Addressed by player rather than by character id, so the
  /// authorisation is legible in the URL.
  app.get(
    '/:id/attendances/:userId/character',
    { schema: { params: sessionAttendeeParamsSchema } },
    async (request) =>
      service.getAttendanceCharacter(
        request.user.sub,
        request.params.id,
        request.params.userId,
      ),
  );

  // --- Non-player characters ---
  //
  // Game-master-only, reads included: what the game master has prepared is
  // exactly what the players are not supposed to know.

  app.get(
    '/:id/npcs',
    { schema: { params: sessionIdParamsSchema } },
    async (request) => ({ npcs: await npcs.list(request.user.sub, request.params.id) }),
  );

  app.post(
    '/:id/npcs',
    { schema: { params: sessionIdParamsSchema, body: createNpcSchema } },
    async (request, reply) => {
      const npc = await npcs.create(request.user.sub, request.params.id, request.body);
      return reply.code(201).send(npc);
    },
  );

  app.patch(
    '/:id/npcs/:npcId',
    { schema: { params: sessionNpcParamsSchema, body: patchNpcSchema } },
    async (request) =>
      npcs.patch(
        request.user.sub,
        request.params.id,
        request.params.npcId,
        request.body,
      ),
  );

  app.delete(
    '/:id/npcs/:npcId',
    { schema: { params: sessionNpcParamsSchema } },
    async (request, reply) => {
      await npcs.remove(request.user.sub, request.params.id, request.params.npcId);
      return reply.code(204).send();
    },
  );
};

export default sessionRoutes;
