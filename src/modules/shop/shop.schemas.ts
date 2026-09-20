import { z } from 'zod';

export const shopItemIdParamsSchema = z.object({
  id: z.string().uuid(),
});
