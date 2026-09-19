import { z } from 'zod';

export const scenarioIdParamsSchema = z.object({
  id: z.string().uuid(),
});
