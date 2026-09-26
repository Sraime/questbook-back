import { z } from 'zod';

export const scenarioIdParamsSchema = z.object({ id: z.string().uuid() });

/// Un PNJ ou un indice porte son `id` quand il existe deja, et rien quand il
/// vient d'etre ajoute dans le formulaire. C'est ce qui permet de reecrire un
/// scenario entier sans donner a ses enfants de nouveaux identifiants — ceux
/// des indices sont cites par `scenario_clue_access`, donc par ce que des
/// joueurs ont deja recu.
const scenarioNpcInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(120),
  description: z.string().max(10_000).default(''),
});

const scenarioClueInputSchema = z.object({
  id: z.string().uuid().optional(),
  title: z.string().min(1).max(160),
  contentMarkdown: z.string().min(1).max(20_000),
});

const scenarioFields = {
  title: z.string().min(1).max(160),
  description: z.string().min(1).max(600),
  context: z.string().min(1).max(20_000),
  rundownMarkdown: z.string().min(1).max(200_000),
  minRecommendedPlayers: z.number().int().min(1).max(12),
  maxRecommendedPlayers: z.number().int().min(1).max(12),
  averageDurationMinutes: z.number().int().min(15).max(1_440),
  grantOnSignup: z.boolean(),
};

/// L'ordre d'affichage n'est pas demande : c'est celui du tableau envoye. Un
/// champ a remplir en plus, pour une information que la liste porte deja,
/// serait une occasion de se contredire.
const childrenFields = {
  npcs: z.array(scenarioNpcInputSchema).max(60),
  clues: z.array(scenarioClueInputSchema).max(60),
};

const playersMakeSense = <T extends { minRecommendedPlayers?: number; maxRecommendedPlayers?: number }>(
  value: T,
  ctx: z.RefinementCtx,
): void => {
  const { minRecommendedPlayers: min, maxRecommendedPlayers: max } = value;
  if (min !== undefined && max !== undefined && max < min) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['maxRecommendedPlayers'],
      message: 'Le maximum de joueurs ne peut pas etre sous le minimum',
    });
  }
};

export const createScenarioSchema = z
  .object({
    ...scenarioFields,
    grantOnSignup: scenarioFields.grantOnSignup.default(false),
    npcs: childrenFields.npcs.default([]),
    clues: childrenFields.clues.default([]),
  })
  .superRefine(playersMakeSense);

/// Tout est facultatif, y compris les deux listes : corriger une faute de
/// titre ne doit pas obliger a renvoyer un deroule de quinze pages, donc a le
/// tenir a jour ailleurs pour pouvoir le recopier juste.
///
/// En revanche, **une liste envoyee fait autorite** : ce qui n'y figure plus
/// est supprime. Une fusion serait impossible a annuler depuis l'ecran —
/// retirer un PNJ n'aurait aucun geste.
export const updateScenarioSchema = z
  .object({ ...scenarioFields, ...childrenFields })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Au moins un champ doit etre fourni',
  })
  .superRefine(playersMakeSense);

export type CreateScenarioInput = z.infer<typeof createScenarioSchema>;
export type UpdateScenarioInput = z.infer<typeof updateScenarioSchema>;
