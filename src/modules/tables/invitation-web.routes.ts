import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../lib/errors.js';
import { TableService } from './table.service.js';
import { invitationTokenParamsSchema } from './table.schemas.js';
import type { TableRoutesOptions } from './table.routes.js';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function page(body: string): string {
  return `<!doctype html>
<html lang="fr">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Questbook</title>
  </head>
  <body style="margin:0;padding:32px 20px;background:#f4ecd8;font-family:Georgia,serif;color:#2b2118">
    <div style="max-width:460px;margin:0 auto;background:#fbf6ea;border:3px solid #6b4f2a;border-radius:10px;padding:28px;text-align:center">
      ${body}
    </div>
  </body>
</html>`;
}

/// The link sent by email. It is unauthenticated on purpose: the invitation
/// row already names the account it was issued for, and holding the token is
/// the proof that the person owns that mailbox.
const invitationWebRoutes: FastifyPluginAsync<TableRoutesOptions> = async (
  fastify,
  options,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new TableService(app.prisma, app.notifications, app.email, options);

  // The accept form posts no fields, so the body is empty. Teaching this
  // encapsulated context to accept an empty urlencoded body avoids both a
  // dependency and a JavaScript-only button.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_request, _body, done) => done(null, {}),
  );

  // Failures here must render a page, not the API's JSON envelope.
  app.setErrorHandler((error, request, reply) => {
    const message =
      error instanceof AppError
        ? error.message
        : 'Une erreur inattendue est survenue.';

    if (!(error instanceof AppError)) {
      request.log.error({ err: error }, 'Invitation page failed');
    }

    return reply
      .code(error instanceof AppError ? error.statusCode : 500)
      .type('text/html; charset=utf-8')
      .send(
        page(`
        <h1 style="margin:0 0 12px;font-size:20px">Invitation indisponible</h1>
        <p style="margin:0;line-height:1.5;color:#6b5c48">${escapeHtml(message)}</p>`),
      );
  });

  /// Only ever renders: a mail client prefetching links must not be able to
  /// accept an invitation on the player's behalf.
  app.get(
    '/:token',
    { schema: { params: invitationTokenParamsSchema } },
    async (request, reply) => {
      const invitation = await service.previewByToken(request.params.token);

      return reply.type('text/html; charset=utf-8').send(
        page(`
        <h1 style="margin:0 0 12px;font-size:20px">Rejoindre « ${escapeHtml(invitation.tableTitle)} »</h1>
        <p style="margin:0 0 24px;line-height:1.5;color:#6b5c48">
          ${escapeHtml(invitation.inviterName)} t'invite à sa table de jeu.
        </p>
        <form method="post" action="/invitations/${encodeURIComponent(request.params.token)}/accept">
          <button type="submit" style="background:#c8912f;color:#2b2118;border:none;padding:12px 22px;border-radius:6px;font-size:16px;font-weight:bold;cursor:pointer">
            Accepter l'invitation
          </button>
        </form>`),
      );
    },
  );

  app.post(
    '/:token/accept',
    { schema: { params: invitationTokenParamsSchema } },
    async (request, reply) => {
      const { tableTitle } = await service.acceptByToken(request.params.token);

      return reply.type('text/html; charset=utf-8').send(
        page(`
        <h1 style="margin:0 0 12px;font-size:20px">C'est fait</h1>
        <p style="margin:0;line-height:1.5;color:#6b5c48">
          Tu fais maintenant partie de « ${escapeHtml(tableTitle)} ».
          Ouvre Questbook, la table t'attend dans l'onglet Tables.
        </p>`),
      );
    },
  );
};

export default invitationWebRoutes;
