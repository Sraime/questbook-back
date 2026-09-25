import { z } from 'zod';

export const reportStatuses = ['open', 'resolved'] as const;

/// Ce qu'un dossier peut devenir aujourd'hui.
///
/// `suspended` et `deleted` manquent volontairement : les gestes qu'ils
/// nomment n'existent pas encore, et un backoffice qui laisserait ecrire
/// « compte suspendu » sans suspendre quoi que ce soit ferait mentir le
/// journal d'audit. Ils arriveront avec la carte qui les rend vrais.
export const resolutions = ['dismissed', 'warned'] as const;

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
