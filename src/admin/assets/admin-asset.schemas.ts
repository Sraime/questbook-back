import { z } from 'zod';
import { assetKinds } from '../../modules/assets/asset.image.js';

export const assetItemParamsSchema = z.object({ id: z.string().uuid() });

/// L'image voyage en base64 dans le JSON, comme tout le reste de cette API :
/// le front n'a qu'une facon d'appeler, et un pion pese trop peu pour que le
/// tiers de plus compte. Sa taille et son format sont verifies apres decodage.
const imageSchema = z.string().min(1).max(3_000_000);

const assetFields = {
  name: z.string().trim().min(1).max(80),
  description: z.string().max(600),
  kind: z.enum(assetKinds),
  available: z.boolean(),
  image: imageSchema,
};

/// Un asset nait retire de la vente sauf avis contraire : on le voit dans le
/// backoffice avant que les joueurs ne le voient dans la boutique.
export const createAssetSchema = z.object({
  ...assetFields,
  description: assetFields.description.default(''),
  available: assetFields.available.default(false),
});

/// La cle n'en fait pas partie : un pion pose s'en souvient, la changer le
/// laisserait sans dessin.
export const updateAssetSchema = z
  .object(assetFields)
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Au moins un champ doit etre fourni',
  });

export type CreateAssetInput = z.infer<typeof createAssetSchema>;
export type UpdateAssetInput = z.infer<typeof updateAssetSchema>;
