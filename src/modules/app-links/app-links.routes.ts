import type { FastifyPluginAsync } from 'fastify';

const PACKAGE_NAME = 'com.questbook.questbook';
const APPLE_APP_ID = '97X67224S7.com.questbook.questbook';

/// Les certificats dont Android accepte qu'ils signent l'app qui ouvre nos
/// liens. Ils se lisent dans la Play Console, Protege avec Play > Signature
/// d'application. Ce ne sont pas des secrets : ce fichier est public.
///
/// Changer de cle de signature dans la console n'en retire aucune ici : les
/// telephones gardent l'app signee par l'ancienne jusqu'a sa mise a jour.
const ANDROID_CERT_SHA256 = [
  // Cle de signature Google Play, en cours d'utilisation.
  'F4:09:F0:F4:E7:09:CC:7D:7C:EA:41:B4:BC:D2:68:5F:CE:64:D6:25:C0:D1:F2:45:74:23:A1:BF:3A:55:72:A1',
  // Cle de signature Google Play precedente, en usage depuis le 21 septembre 2026.
  'F9:19:2E:EB:45:A4:94:5D:3B:6E:0A:C9:F6:23:65:22:AC:5A:A0:B1:30:66:2E:9A:8E:A9:4F:63:5F:82:5C:BC',
  // Cle d'importation : signe les builds distribues aux testeurs par Firebase.
  '03:76:4B:00:30:15:D5:A2:C2:A7:38:6F:27:51:C0:59:B1:2B:85:51:A2:55:AC:A0:2A:E1:8E:0A:DD:D5:6B:DE',
];

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
