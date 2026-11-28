import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError, notFound } from '../../lib/errors.js';
import { AssetService } from '../assets/asset.service.js';
import { publicBoard } from './projection.board.js';
import { ProjectionService } from './projection.service.js';

export interface ProjectionRoutesOptions {
  publicBaseUrl: string;
}

const tokenParamsSchema = z.object({ token: z.string().min(20).max(128) });
const imageParamsSchema = tokenParamsSchema.extend({ key: z.string().min(1).max(80) });
const staticParamsSchema = z.object({ file: z.string().min(1).max(64) });

/// Le script, la feuille de style et les images que l'app embarque : la page
/// web n'a pas l'app sous la main pour les lui emprunter. Une liste fermee,
/// lue au demarrage : aucun chemin venu de l'URL n'atteint le disque.
const STATIC_DIR = fileURLToPath(new URL('../../../web/projection/', import.meta.url));
const STATIC_FILES: Record<string, string> = {
  'projection.js': 'text/javascript; charset=utf-8',
  'projection.css': 'text/css; charset=utf-8',
  'manoir-clairiere.jpg': 'image/jpeg',
  'grand-ancien.png': 'image/png',
};

/// La page ne charge que ce qui vient d'ici, et ne parle qu'a ce serveur.
/// Elle n'a ni formulaire ni cadre : rien a soumettre, rien a encadrer.
function contentSecurityPolicy(host: string): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self'",
    `connect-src 'self' wss://${host} ws://${host}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex, nofollow" />
    <title>${escapeHtml(title)} · Questbook</title>
    <link rel="stylesheet" href="/projection/static/projection.css" />
  </head>
  <body>
${body}
  </body>
</html>`;
}

/// L'hote tel que le navigateur l'a demande, port compris : `hostname` le
/// perd, et une politique sans port refuserait la websocket d'un poste de dev.
function hostOf(request: FastifyRequest): string {
  return request.headers.host ?? request.hostname;
}

function sendPage(reply: FastifyReply, host: string, status: number, html: string) {
  return reply
    .code(status)
    .header('content-security-policy', contentSecurityPolicy(host))
    .header('cache-control', 'no-store')
    .header('x-robots-tag', 'noindex, nofollow')
    .type('text/html; charset=utf-8')
    .send(html);
}

/// Le mode projection, cote public : ce que voit l'ecran de la salle.
///
/// **Rien ici n'ecrit.** Pas une route en `POST`, `PUT` ni `DELETE`, et la
/// websocket ferme toute connexion qui lui envoie quoi que ce soit. Le jeton
/// ne fait qu'ouvrir une fenetre sur le plateau, le temps de la seance.
const projectionRoutes: FastifyPluginAsync<ProjectionRoutesOptions> = async (
  fastify,
  options,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new ProjectionService(app.prisma, options);
  const assets = new AssetService(app.prisma);

  const files = new Map(
    Object.entries(STATIC_FILES).map(([name, type]) => [
      name,
      { type, bytes: readFileSync(`${STATIC_DIR}${name}`) },
    ]),
  );

  app.get(
    '/static/:file',
    { schema: { params: staticParamsSchema } },
    async (request, reply) => {
      const file = files.get(request.params.file);
      if (!file) throw notFound('File not found');
      return reply
        .header('cache-control', 'public, max-age=3600')
        .type(file.type)
        .send(file.bytes);
    },
  );

  app.get(
    '/:token',
    { schema: { params: tokenParamsSchema } },
    async (request, reply) => {
      try {
        const session = await service.resolve(request.params.token);
        return sendPage(
          reply,
          hostOf(request),
          200,
          page(
            session.title,
            `    <main id="stage">
      <p class="status">Chargement du plateau…</p>
    </main>
    <script src="/projection/static/projection.js"></script>`,
          ),
        );
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        return sendPage(
          reply,
          hostOf(request),
          error.statusCode,
          page(
            'Projection',
            `    <main class="notice">
      <h1>Projection indisponible</h1>
      <p>${escapeHtml(error.message)}</p>
    </main>`,
          ),
        );
      }
    },
  );

  app.get(
    '/:token/assets',
    { schema: { params: tokenParamsSchema } },
    async (request, reply) => {
      await service.resolve(request.params.token);
      reply.header('cache-control', 'no-store');
      return { assets: await assets.list() };
    },
  );

  app.get(
    '/:token/assets/:key/image',
    { schema: { params: imageParamsSchema } },
    async (request, reply) => {
      await service.resolve(request.params.token);
      const image = await assets.image(request.params.key);
      const etag = `"${image.hash}"`;

      reply
        .header('etag', etag)
        .header('cache-control', 'private, max-age=86400');

      if (request.headers['if-none-match'] === etag) {
        return reply.code(304).send();
      }
      return reply.type(image.type).send(image.bytes);
    },
  );

  // Le premier message porte le plateau entier, les suivants arrivent a
  // chaque geste du MJ, par le meme registre que les joueurs.
  app.get(
    '/:token/live',
    { websocket: true, schema: { params: tokenParamsSchema } },
    async (socket, request) => {
      // Avant tout `await` : un message arrive pendant la resolution du jeton
      // doit deja trouver la porte fermee.
      socket.on('message', () => socket.close(1008, 'Read only'));

      let session;
      try {
        session = await service.resolve(request.params.token);
      } catch (error) {
        socket.send(
          JSON.stringify({
            type: 'error',
            status: error instanceof AppError ? error.statusCode : 500,
            message:
              error instanceof AppError ? error.message : 'Projection indisponible.',
          }),
        );
        socket.close();
        return;
      }

      const { sessionId } = session;
      const board = publicBoard(await service.board(sessionId));
      if (socket.readyState !== socket.OPEN) return;

      app.boardLive.joinProjection(sessionId, socket);

      // La seance close, l'ecran s'eteint de lui-meme : un lien ne survit
      // pas a sa partie, meme sur une connexion ouverte avant la fin.
      const expiry = setTimeout(() => {
        try {
          socket.send(
            JSON.stringify({
              type: 'closed',
              message: 'Cette séance est terminée : la projection est close.',
            }),
          );
        } finally {
          socket.close();
        }
      }, Math.max(0, session.closesAt.getTime() - Date.now()));

      const leave = () => {
        clearTimeout(expiry);
        app.boardLive.leaveProjection(sessionId, socket);
      };
      socket.on('close', leave);
      socket.on('error', leave);

      socket.send(JSON.stringify({ type: 'board', board }));
    },
  );
};

export default projectionRoutes;
