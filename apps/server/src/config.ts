import { z } from 'zod';

/**
 * All configuration comes from the environment (.env in development, the
 * compose environment in production). Nothing here has a secret default.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3030),
  HOST: z.string().default('0.0.0.0'),
  PUBLIC_URL: z.string().url().default('http://localhost:5373'),
  /** Directory of the built client to serve (the production image sets it); empty = API only. */
  STATIC_DIR: z.string().default(''),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  STARTING_BALANCE: z.coerce.number().int().nonnegative().default(1000),
  RAKE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  /**
   * Daily top-up until the tokens are on-chain: granted once per 24 h on the
   * first session check of the day (owner's decision, 2026-09-16: 100). 0 = off.
   */
  DAILY_GRANT: z.coerce.number().int().nonnegative().default(100),
  DAILY_GRANT_INTERVAL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  /** How long an open challenge waits for a taker before the fee is refunded. */
  CHALLENGE_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60 * 1000),
  /** How long a created game may sit un-started before it is finalised as abandoned. */
  PENDING_GAME_TTL_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  /** Slack added to the game clock before a playing game is force-finalised. */
  GAME_GRACE_MS: z.coerce.number().int().nonnegative().default(15_000),
  /** How far ahead of the server wall clock a submitted move's tMs may be. */
  CLOCK_TOLERANCE_MS: z.coerce.number().int().nonnegative().default(2_000),
  /**
   * The key the admin dashboard reads with (`Authorization: Bearer`). Empty
   * means the admin API is OFF (503), never open: it exposes every player's
   * scores, devices and rough locations, and a deployment that forgot to set
   * it must not publish those.
   */
  ADMIN_TOKEN: z.string().default(''),
  /**
   * Optional IP geolocation template with an `{ip}` placeholder, e.g.
   * `http://ip-api.com/json/{ip}?fields=countryCode,regionName`. Empty = no
   * lookup: the dashboard's "where" stays empty and no address leaves the box.
   * Asked at most once per hashed address; the answer is cached on the row.
   */
  GEOIP_URL: z.string().default(''),
  /**
   * Where share cards (the PNGs behind `/s/:id`) are kept. Relative to the
   * server's working directory; the production image mounts a volume here.
   */
  SHARE_DIR: z.string().default('./share-cards'),
  /**
   * Web Push (VAPID). All three empty = push is OFF: subscriptions are
   * refused with 404 and nothing is ever sent, but the app runs (the in-app
   * toasts and the inbox need none of this). Generate a pair once with
   * `npx web-push generate-vapid-keys` and keep the private key a secret.
   * `VAPID_SUBJECT` is the contact the push services may use: `mailto:`.
   */
  VAPID_PUBLIC_KEY: z.string().default(''),
  VAPID_PRIVATE_KEY: z.string().default(''),
  VAPID_SUBJECT: z.string().default(''),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

/** Every challenge is staked; practice is the solo mode. Owner's decision 2026-09-16. */
export const ENTRY_FEES = [5, 10, 25, 50, 100] as const;
