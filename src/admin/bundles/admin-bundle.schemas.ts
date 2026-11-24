import { z } from 'zod';

export const bundleItemParamsSchema = z.object({ id: z.string().uuid() });

const bundleFields = {
  title: z.string().trim().min(1).max(80),
  description: z.string().max(2000),
  /// En centimes, comme partout dans la boutique. La boutique refuse encore
  /// de vendre ce qui a un prix, mais un bundle peut deja en porter un.
  priceCents: z.number().int().min(0).max(100_000),
  available: z.boolean(),
  /// En base64, comme l'image d'un asset.
  image: z.string().min(1).max(3_000_000),
  /// Les articles `asset` qu'il donne, dans l'ordre de l'ecran.
  assetItemIds: z.array(z.string().uuid()).max(100),
  scenarioIds: z.array(z.string().uuid()).max(30),
};

/// Un bundle nait retire de la vente sauf avis contraire, comme un asset : on
/// le relit dans le backoffice avant que les joueurs ne le voient.
export const createBundleSchema = z.object({
  ...bundleFields,
  description: bundleFields.description.default(''),
  priceCents: bundleFields.priceCents.default(0),
  available: bundleFields.available.default(false),
  assetItemIds: bundleFields.assetItemIds.default([]),
  scenarioIds: bundleFields.scenarioIds.default([]),
});

export const updateBundleSchema = z
  .object(bundleFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Au moins un champ doit etre fourni',
  });

export type CreateBundleInput = z.infer<typeof createBundleSchema>;
export type UpdateBundleInput = z.infer<typeof updateBundleSchema>;
