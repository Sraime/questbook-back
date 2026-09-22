import { z } from 'zod';

export const createBlockSchema = z.object({
  userId: z.string().uuid(),
});

export type CreateBlockInput = z.infer<typeof createBlockSchema>;
