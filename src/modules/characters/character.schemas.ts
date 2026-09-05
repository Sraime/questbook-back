import { z } from 'zod';

/// Mirrors `StatKind` in the Flutter app (lib/domain/models/character_stat.dart).
export const statKindSchema = z.enum(['characteristic', 'skill', 'attribute']);

/// Mirrors `Tone` in the Flutter app (lib/domain/models/tone.dart).
export const toneSchema = z.enum(['neutral', 'danger', 'success', 'warning', 'info']);

const idSchema = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });

export const statInputSchema = z.object({
  id: idSchema.optional(),
  kind: statKindSchema,
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  value: z.number().int().min(-9999).max(9999),
  base: z.string().max(200).nullish(),
  sortOrder: z.number().int().min(0).max(9999).default(0),
});

export const resourceInputSchema = z.object({
  id: idSchema.optional(),
  key: z.string().min(1).max(120),
  label: z.string().min(1).max(200),
  current: z.number().int().min(-9999).max(9999),
  max: z.number().int().min(0).max(9999),
  tone: toneSchema.default('neutral'),
});

export const inventoryItemInputSchema = z.object({
  id: idSchema.optional(),
  name: z.string().min(1).max(200),
  qty: z.number().int().min(0).max(99999).default(1),
  weight: z.string().max(60).nullish(),
});

const characterCoreSchema = z.object({
  systemId: z.string().min(1).max(120),
  name: z.string().min(1).max(120),
  occupation: z.string().max(200).nullish(),
  description: z.string().max(5000).nullish(),
  level: z.number().int().min(1).max(999).default(1),
});

export const createCharacterSchema = characterCoreSchema.extend({
  id: idSchema.optional(),
  createdAt: isoDate.optional(),
  stats: z.array(statInputSchema).max(500).default([]),
  resources: z.array(resourceInputSchema).max(100).default([]),
  inventory: z.array(inventoryItemInputSchema).max(500).default([]),
});

/// Full-aggregate upsert used by the sync push. `updatedAt` is the client's own
/// clock reading and drives last-write-wins conflict detection, so it is
/// required here even though every other write endpoint stamps it server-side.
export const putCharacterSchema = characterCoreSchema.extend({
  createdAt: isoDate,
  updatedAt: isoDate,
  deletedAt: isoDate.nullish(),
  stats: z.array(statInputSchema).max(500).default([]),
  resources: z.array(resourceInputSchema).max(100).default([]),
  inventory: z.array(inventoryItemInputSchema).max(500).default([]),
});

export const patchCharacterSchema = characterCoreSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  { message: 'At least one field must be provided' },
);

export const patchStatSchema = z.object({
  value: z.number().int().min(-9999).max(9999),
});

export const patchResourceSchema = z
  .object({
    current: z.number().int().min(-9999).max(9999).optional(),
    max: z.number().int().min(0).max(9999).optional(),
  })
  .refine((value) => value.current !== undefined || value.max !== undefined, {
    message: 'Provide current, max, or both',
  });

export const patchInventoryItemSchema = inventoryItemInputSchema
  .omit({ id: true })
  .partial()
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field must be provided',
  });

export const characterIdParamsSchema = z.object({ id: idSchema });

export const inventoryItemParamsSchema = z.object({
  id: idSchema,
  itemId: idSchema,
});

export const statParamsSchema = z.object({
  id: idSchema,
  kind: statKindSchema,
  key: z.string().min(1).max(120),
});

export const resourceParamsSchema = z.object({
  id: idSchema,
  key: z.string().min(1).max(120),
});

/// `since` turns the collection endpoint into an incremental sync pull: it then
/// also returns tombstones, which the unfiltered listing hides.
export const listCharactersQuerySchema = z.object({
  since: isoDate.optional(),
});

export type CreateCharacterInput = z.infer<typeof createCharacterSchema>;
export type PutCharacterInput = z.infer<typeof putCharacterSchema>;
export type PatchCharacterInput = z.infer<typeof patchCharacterSchema>;
export type InventoryItemInput = z.infer<typeof inventoryItemInputSchema>;
export type PatchInventoryItemInput = z.infer<typeof patchInventoryItemSchema>;
