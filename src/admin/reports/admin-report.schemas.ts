import { z } from 'zod';

export const reportStatuses = ['open', 'resolved'] as const;

/// Ce qu'un dossier peut devenir.
///
/// `suspended` et `deleted` **ne font rien par eux-memes** : ils disent ce qui
/// a ete decide, la sanction se posant par `/admin/users/:id`. Les deux gestes
/// restent separes a dessein — un compte se suspend souvent pour un faisceau
/// de dossiers, pas pour celui qu'on avait sous les yeux, et un dossier se
/// classe parfois sans que personne ne soit sanctionne.
export const resolutions = ['dismissed', 'warned', 'suspended', 'deleted'] as const;

export const listReportsQuerySchema = z.object({
  status: z.enum(reportStatuses).default('open'),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export const reportIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const resolveReportSchema = z.object({
  resolution: z.enum(resolutions),
  note: z.string().max(2000).optional(),
});

export type ListReportsQuery = z.infer<typeof listReportsQuerySchema>;
export type ResolveReportInput = z.infer<typeof resolveReportSchema>;
