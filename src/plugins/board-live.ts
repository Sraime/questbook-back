import type { FastifyPluginAsync } from 'fastify';
import websocket from '@fastify/websocket';
import fp from 'fastify-plugin';
import { BoardLiveRegistry } from '../modules/tables/board.live.js';

declare module 'fastify' {
  interface FastifyInstance {
    /// Who is watching which board. Decorated on the app rather than built
    /// inside the session routes so the push and the listeners share one
    /// registry — two of them would each hold half the table.
    boardLive: BoardLiveRegistry;
  }
}

const boardLivePlugin: FastifyPluginAsync = async (app) => {
  await app.register(websocket, {
    options: {
      // Un plateau entier, pions compris, plafonne a une centaine de
      // kilo-octets cote ecriture ; le meme plafond ici refuse une trame
      // absurde sans jamais gener une vraie.
      maxPayload: 128 * 1024,
    },
  });

  app.decorate('boardLive', new BoardLiveRegistry());
};

export default fp(boardLivePlugin, { name: 'board-live' });
