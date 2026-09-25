import { z } from 'zod';

export const userIdParamsSchema = z.object({
  id: z.string().uuid(),
});

export const suspendUserSchema = z.object({
  /// Nul ou absent : indefiniment. Une date passee serait une suspension deja
  /// expiree, donc un geste sans effet.
  until: z.string().datetime().optional(),
  /// Lu par le joueur sur l'ecran qui lui apprend la nouvelle, donc exige :
  /// une sanction sans motif est une sanction qu'on ne peut pas contester.
  reason: z.string().min(1).max(500),
});

/// Fermer un compte emporte par cascade les tables qu'il animait, leurs
/// seances et l'appartenance de leurs joueurs. On ne detruit pas cela sur un
/// clic : l'appelant doit recopier l'adresse du compte, que `GET
/// /admin/users/:id` vient de lui montrer avec le nombre de tables en jeu.
export const deleteUserSchema = z.object({
  confirmEmail: z.string().min(1),
});

export type SuspendUserInput = z.infer<typeof suspendUserSchema>;
export type DeleteUserInput = z.infer<typeof deleteUserSchema>;
