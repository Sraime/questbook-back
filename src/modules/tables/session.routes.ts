import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../lib/errors.js';
import { BoardService } from './board.service.js';
import { NpcService } from './npc.service.js';
import { SessionService } from './session.service.js';
import {
  attendanceCharacterSchema,
  attendanceSchema,
  createNpcSchema,
  patchNpcSchema,
  patchSessionSchema,
  replaceBoardSchema,
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
  const boards = new BoardService(app.prisma);

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

  // --- The board ---
  //
  // The mirror image of the non-player characters above: every member reads,
  // only the game master writes. A board is meant to be seen.

  app.get(
    '/:id/board',
    { schema: { params: sessionIdParamsSchema } },
    async (request) => boards.get(request.user.sub, request.params.id),
  );

  app.put(
    '/:id/board',
    { schema: { params: sessionIdParamsSchema, body: replaceBoardSchema } },
    async (request) => {
      const board = await boards.replace(
        request.user.sub,
        request.params.id,
        request.body,
      );

      // After the write, never before: a listener told of a move the database
      // then refused would be showing a board that does not exist.
      app.boardLive.publish(request.params.id, board);

      return board;
    },
  );

  // Le canal temps reel. Le joueur le prefere a une interrogation
  // periodique : un pion qu'on voit bouger trois secondes apres le MJ donne
  // l'impression de regarder un enregistrement, et une table qui joue ne
  // supporte pas ce decalage.
  //
  // Le premier message porte le plateau entier, avant tout mouvement : sans
  // lui le joueur devrait aussi appeler `GET`, et verrait un plateau vide
  // jusqu'au geste suivant du MJ.
  app.get(
    '/:id/board/live',
    { websocket: true, schema: { params: sessionIdParamsSchema } },
    async (socket, request) => {
      const sessionId = request.params.id;

      let board;
      try {
        board = await boards.get(request.user.sub, sessionId);
      } catch (error) {
        // La poignee de main a deja abouti : on ne peut plus repondre 404, il
        // ne reste qu'a dire pourquoi et raccrocher.
        socket.send(
          JSON.stringify({
            type: 'error',
            message:
              error instanceof AppError ? error.message : 'Board unavailable',
          }),
        );
        socket.close();
        return;
      }

      app.boardLive.join(sessionId, socket);
      socket.on('close', () => app.boardLive.leave(sessionId, socket));
      // Sans cela, une connexion coupee sans fermeture propre resterait dans
      // la salle et chaque poussee tenterait de l'atteindre.
      socket.on('error', () => app.boardLive.leave(sessionId, socket));

      socket.send(JSON.stringify({ type: 'board', board }));
    },
  );
};

export default sessionRoutes;
