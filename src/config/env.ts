import { z } from 'zod';

const csv = (value: string): string[] =>
  value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // 32+ chars: anything shorter is brute-forceable for an HS256 signing key.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  /// Every Google OAuth client id the app may present an ID token from
  /// (web/server client, Android client, iOS client). Comma-separated.
  GOOGLE_CLIENT_IDS: z.string().transform(csv).pipe(z.array(z.string()).min(1)),

  /// Empty means "no browser origin allowed", which is the right default for a
  /// mobile-only API: native apps do not send an Origin header.
  CORS_ORIGINS: z.string().default('').transform(csv),

  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),

  /// Where the invitation links in outgoing emails point. Must be reachable
  /// from a mail client, so it is the public origin rather than HOST/PORT.
  PUBLIC_BASE_URL: z.string().url().default('http://localhost:3000'),
  INVITATION_TTL_DAYS: z.coerce.number().int().positive().default(14),

  /// Email and push are both optional: without credentials the senders fall
  /// back to logging what they would have sent, so a local checkout runs with
  /// no third-party account at all.
  RESEND_API_KEY: z.string().default(''),
  EMAIL_FROM: z.string().default('Questbook <onboarding@resend.dev>'),

  FIREBASE_PROJECT_ID: z.string().default(''),
  FIREBASE_CLIENT_EMAIL: z.string().default(''),
  /// Pasted from the service account JSON, where newlines are escaped as \n.
  FIREBASE_PRIVATE_KEY: z
    .string()
    .default('')
    .transform((value) => value.replace(/\\n/g, '\n')),
});

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${details}`);
  }

  return parsed.data;
}
