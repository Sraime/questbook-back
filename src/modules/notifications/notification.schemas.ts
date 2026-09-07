import { z } from 'zod';

const idSchema = z.string().uuid();

export const listNotificationsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const markReadSchema = z.object({
  ids: z.array(idSchema).min(1).max(200),
});

/// FCM registration tokens have no fixed length and grow over time, so the
/// bound is generous rather than exact.
export const registerDeviceSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['android', 'ios']),
});

export const deviceTokenParamsSchema = z.object({
  token: z.string().min(1).max(4096),
});
