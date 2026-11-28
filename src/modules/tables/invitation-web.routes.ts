import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../../lib/errors.js';
import { TableService } from './table.service.js';
import { invitationTokenParamsSchema } from './table.schemas.js';
import type { TableRoutesOptions } from './table.routes.js';

const PACKAGE_NAME = 'com.questbook.questbook';
const PLAY_STORE_URL = `https://play.google.com/store/apps/details?id=${PACKAGE_NAME}`;
const APP_STORE_URL = 'https://apps.apple.com/app/id6813883912';

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
    <meta name="robots" content="noindex" />
    <title>Questbook</title>
  </head>
  <body style="margin:0;padding:32px 20px;background:#f4ecd8;font-family:Georgia,serif;color:#2b2118">
    <div style="max-width:460px;margin:0 auto;background:#fbf6ea;border:3px solid #6b4f2a;border-radius:10px;padding:28px;text-align:center">
      ${body}
    </div>
  </body>
</html>`;
}

function button(href: string, label: string, primary = true): string {
  const colors = primary
    ? 'background:#c8912f;color:#2b2118'
    : 'background:transparent;color:#6b4f2a;border:2px solid #6b4f2a';
  return `<p style="margin:0 0 12px"><a href="${escapeHtml(href)}" style="display:inline-block;${colors};text-decoration:none;padding:12px 22px;border-radius:6px;font-size:16px;font-weight:bold">${label}</a></p>`;
}

type Platform = 'android' | 'ios' | 'other';

/// iPadOS presents itself as a Mac, which lands it in `other`: it is then
/// offered both stores, which is still right.
function platformOf(userAgent: string | undefined): Platform {
  if (!userAgent) return 'other';
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'other';
}

/// Where the emailed link lands when the app did not take it: the app is not
/// installed, or the phone opened the link in the browser anyway.
///
/// This page never joins anyone to anything. Joining needs a signed-in
/// account, and only the app has one; the page's job is to get the player
/// there, through the store if need be.
const invitationWebRoutes: FastifyPluginAsync<TableRoutesOptions> = async (
  fastify,
  options,
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new TableService(app.prisma, app.notifications, app.email, options);

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

  app.get(
    '/:token',
    { schema: { params: invitationTokenParamsSchema } },
    async (request, reply) => {
      const invitation = await service.previewByToken(request.params.token);
      const code = encodeURIComponent(request.params.token);
      const platform = platformOf(request.headers['user-agent']);

      // Un lien `https` tape depuis une page du meme domaine n'ouvre jamais
      // l'app, ni sur Android ni sur iOS : le bouton passe donc par le schema
      // de l'app. Sur Android, l'URL d'intent retombe d'elle-meme sur le Play
      // Store quand l'app manque.
      const openInApp =
        platform === 'android'
          ? `intent://invitations/${code}#Intent;scheme=questbook;package=${PACKAGE_NAME};S.browser_fallback_url=${encodeURIComponent(PLAY_STORE_URL)};end`
          : `questbook://invitations/${code}`;

      const actions =
        platform === 'android'
          ? button(openInApp, 'Rejoindre la table')
          : platform === 'ios'
            ? button(APP_STORE_URL, 'Installer Questbook') +
              button(openInApp, 'J’ai déjà l’application', false)
            : button(APP_STORE_URL, 'Questbook sur l’App Store') +
              button(PLAY_STORE_URL, 'Questbook sur Google Play');

      const hint =
        platform === 'other'
          ? 'Ouvre ce lien depuis ton téléphone : c’est là que l’application te fera rejoindre la table.'
          : 'Si tu viens d’installer Questbook, connecte-toi puis rouvre ce lien : la table t’attendra.';

      return reply.type('text/html; charset=utf-8').send(
        page(`
        <h1 style="margin:0 0 12px;font-size:20px">Rejoindre « ${escapeHtml(invitation.tableTitle)} »</h1>
        <p style="margin:0 0 24px;line-height:1.5;color:#6b5c48">
          ${escapeHtml(invitation.inviterName)} t'invite à sa table de jeu.
        </p>
        ${actions}
        <p style="margin:12px 0 0;font-size:14px;line-height:1.5;color:#6b5c48">${hint}</p>`),
      );
    },
  );
};

export default invitationWebRoutes;
