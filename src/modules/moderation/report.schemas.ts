import { z } from 'zod';

/// Ce qu'un joueur peut signaler. Chaque valeur correspond à un endroit de
/// l'app où du texte écrit par quelqu'un d'autre s'affiche : le pseudo dans
/// la liste des membres, le titre d'une table, une séance, la fiche d'un
/// investigateur.
export const reportableContentTypes = [
  'user',
  'table',
  'session',
  'investigator',
] as const;

export type ReportableContentType = (typeof reportableContentTypes)[number];

/// L'appelant ne dit que ce qu'il vise et ce qu'il reproche. Ni l'auteur du
/// contenu ni sa copie ne viennent d'ici : le serveur les relit lui-même,
/// faute de quoi un signalement se forgerait de toutes pièces.
export const createReportSchema = z.object({
  contentType: z.enum(reportableContentTypes),
  contentId: z.string().min(1).max(64),
  /// Assez pour raconter, trop court pour servir de dépotoir.
  reason: z.string().trim().min(1).max(2000),
});

export type CreateReportInput = z.infer<typeof createReportSchema>;
