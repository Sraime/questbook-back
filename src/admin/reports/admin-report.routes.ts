import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { currentAdmin } from '../plugins/admin-auth.js';
import { AdminReportService } from './admin-report.service.js';
import {
  listReportsQuerySchema,
  reportIdParamsSchema,
  resolveReportSchema,
} from './admin-report.schemas.js';

/// La file des signalements : la lire, ouvrir un dossier, le trancher.
///
/// Les conditions d'utilisation annoncent un examen sous vingt-quatre heures.
/// C'est le seul ecran qui permette de le tenir, et c'est pour cela qu'il
/// existe avant les statistiques et l'administration du contenu.
const adminReportRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const service = new AdminReportService(app.prisma);

  app.addHook('preHandler', app.requireAdmin);

  // Consulter la file n'est pas journalise : c'est le geste ordinaire du
  // poste, et une ligne par rafraichissement noierait celles qui comptent.
  app.get('/', { schema: { querystring: listReportsQuerySchema } }, async (request) =>
    service.list(request.query),
  );

  app.get('/:id', { schema: { params: reportIdParamsSchema } }, async (request) =>
    service.detail(request.params.id),
  );

  app.post(
    '/:id/resolve',
    { schema: { params: reportIdParamsSchema, body: resolveReportSchema } },
    async (request) =>
      service.resolve(request.params.id, currentAdmin(request).admin.id, request.body),
  );
};

export default adminReportRoutes;
