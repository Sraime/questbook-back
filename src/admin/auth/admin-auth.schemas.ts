import { z } from 'zod';

export const signInSchema = z.object({
  login: z.string().min(1).max(60),
  // Long passwords are welcome; the ceiling only keeps a megabyte of text from
  // reaching scrypt, which would hold the process for as long as it took.
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^[0-9]{6}$/, 'Le code doit faire six chiffres'),
});

export type SignInBody = z.infer<typeof signInSchema>;
