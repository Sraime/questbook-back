import type { FastifyPluginAsync } from 'fastify';

const PACKAGE_NAME = 'com.questbook.questbook';
const APPLE_APP_ID = '97X67224S7.com.questbook.questbook';

/// Les certificats dont Android accepte qu'ils signent l'app qui ouvre nos
/// liens. Il en faut deux : la cle d'upload, qui signe les builds distribues
/// aux testeurs, et celle de Google Play, qui re-signe ce que le store livre.
/// Les deux se lisent dans la Play Console, Test et publication > Integrite
/// de l'application. Ce ne sont pas des secrets : ce fichier est public.
const ANDROID_CERT_SHA256: string[] = [];

/// Ce que lisent Android et iOS pour croire qu'un lien `https` de ce domaine
/// peut ouvrir l'app plutot que le navigateur. Ils les reclament sans
/// authentification, sans redirection, et en JSON — d'ou le type explicite :
/// le fichier Apple n'a pas d'extension.
const appLinksRoutes: FastifyPluginAsync = async (app) => {
  app.get('/.well-known/assetlinks.json', async (_request, reply) =>
    reply.type('application/json').send([
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: PACKAGE_NAME,
          sha256_cert_fingerprints: ANDROID_CERT_SHA256,
        },
      },
    ]),
  );

  // Seul le chemin des invitations : un lien vers les pages legales doit
  // rester une page web, meme sur un telephone qui a l'app.
  app.get('/.well-known/apple-app-site-association', async (_request, reply) =>
    reply.type('application/json').send({
      applinks: {
        details: [
          {
            appIDs: [APPLE_APP_ID],
            components: [{ '/': '/invitations/*' }],
          },
        ],
      },
    }),
  );
};

export default appLinksRoutes;
