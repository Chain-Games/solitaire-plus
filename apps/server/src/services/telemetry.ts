import { createHash } from 'node:crypto';
import { and, eq, isNotNull, sql } from 'drizzle-orm';
import type { Config } from '../config.js';
import type { Db } from '../db/index.js';
import { clientMeta, type DeviceKind } from '../db/schema.js';

/**
 * What the admin dashboard can tell about a player's browser, from the two
 * things it sends: the User-Agent and a `x-solitaire-touch: 1` hint.
 *
 * Written out rather than installed: a UA library is large, updated weekly and
 * answers far more than the three buckets the dashboard asks (phone / tablet /
 * desktop, roughly which OS, roughly which browser). Order is the whole
 * design — every one of these strings lies about the others.
 *
 * What is deliberately not kept: the address. It is hashed with the session
 * secret so a repeat address can be recognised (and geolocated once) without
 * the table being able to say what it was. Location is country + region and
 * no finer. And none of this may ever matter to a game: `noteClient` runs
 * after the response is sent and swallows its own errors.
 */

export interface ClientProfile {
  readonly device: DeviceKind;
  readonly os: string;
  readonly browser: string;
}

/**
 * Classify a user-agent string. Each check is here because the obvious one
 * before it lies:
 *   - iPadOS says "Macintosh" (since 2019); it is told apart by claiming touch.
 *   - every Chromium browser says "Chrome", so Edge / Opera / Samsung go first.
 *   - Chrome says "Safari" too, so Safari is only Safari once Chrome is excluded.
 *   - Android tablets are Android without "Mobile"; Android phones have it.
 */
export function profileOf(userAgent: unknown, touch = false): ClientProfile {
  const ua = typeof userAgent === 'string' ? userAgent.slice(0, 1024) : '';
  const low = ua.toLowerCase();
  const has = (needle: string): boolean => low.includes(needle.toLowerCase());

  const os = ((): string => {
    if (has('iPhone') || has('iPod')) return 'iOS';
    if (has('iPad')) return 'iPadOS';
    if (has('Macintosh')) return touch ? 'iPadOS' : 'macOS';
    if (has('Android')) return 'Android';
    if (has('Windows')) return 'Windows';
    if (has('CrOS')) return 'ChromeOS';
    if (has('Linux')) return 'Linux';
    return 'Unknown';
  })();

  const browser = ((): string => {
    if (has('Edg/') || has('EdgiOS') || has('EdgA/')) return 'Edge';
    if (has('OPR/') || has('Opera')) return 'Opera';
    if (has('SamsungBrowser')) return 'Samsung Internet';
    if (has('Firefox') || has('FxiOS')) return 'Firefox';
    if (has('CriOS') || has('Chrome') || has('Chromium')) return 'Chrome';
    if (has('Safari')) return 'Safari';
    return 'Unknown';
  })();

  const device = ((): DeviceKind => {
    if (os === 'iPadOS') return 'tablet';
    if (os === 'iOS') return 'phone';
    if (os === 'Android') return has('Mobile') ? 'phone' : 'tablet';
    if (has('Tablet')) return 'tablet';
    if (has('Mobile')) return 'phone';
    // Unknown UA + touch is most likely a phone; unknown UA alone is a desktop
    // (or a bot, which is fine to count as one).
    if (os === 'Unknown' && touch) return 'phone';
    return 'desktop';
  })();

  return { device, os, browser };
}

/** A stable, non-reversible handle for an address. Never the address itself. */
export function hashIp(ip: string, secret: string): string {
  return createHash('sha256').update(`${ip}${secret}`).digest('hex');
}

/**
 * Addresses that can never be located and must never be sent anywhere. On a
 * LAN every request is from a private range; asking a public service about
 * 192.168.1.4 tells it something about us and nothing about the player.
 */
export function isPrivateIp(ip: string): boolean {
  if (!ip) return true;
  const a = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (a === '::1' || a === '127.0.0.1' || a.startsWith('127.')) return true;
  if (a.startsWith('10.') || a.startsWith('192.168.') || a.startsWith('169.254.')) return true;
  if (a.startsWith('172.')) {
    const second = Number(a.split('.')[1] ?? -1);
    if (second >= 16 && second <= 31) return true;
  }
  const l = a.toLowerCase();
  if (l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80')) return true;
  return false;
}

export interface Place {
  readonly country: string | null;
  readonly region: string | null;
}

const GEO_TIMEOUT_MS = 4000;

/**
 * Ask the configured service where an address is. Resolves to null when it
 * cannot or must not say (no template, private address, timeout, odd answer).
 * The template's `{ip}` is replaced; the reply is read for the common field
 * names (`countryCode` / `country`, `regionName` / `region`), so ip-api's
 * `?fields=countryCode,regionName` works out of the box.
 */
export async function locateIp(template: string, ip: string): Promise<Place | null> {
  if (!template || isPrivateIp(ip)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEO_TIMEOUT_MS);
  try {
    const res = await fetch(template.replaceAll('{ip}', encodeURIComponent(ip)), {
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    if (body['status'] === 'fail') return null;
    const str = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = body[k];
        if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 80);
      }
      return null;
    };
    const country = str('countryCode', 'country_code', 'country');
    if (!country) return null;
    return {
      country: country.length === 2 ? country.toUpperCase() : country,
      region: str('regionName', 'region_name', 'region'),
    };
  } catch {
    return null; // unreachable, slow or rate-limited: knowing less is not an error
  } finally {
    clearTimeout(timer);
  }
}

/** Insertion-ordered map capped at `max` entries; the oldest key is evicted. */
class Lru<K, V> {
  private readonly map = new Map<K, V>();
  constructor(private readonly max: number) {}
  get(k: K): V | undefined {
    const v = this.map.get(k);
    if (v !== undefined) {
      this.map.delete(k);
      this.map.set(k, v);
    }
    return v;
  }
  set(k: K, v: V): void {
    this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
  }
}

export const NOTE_INTERVAL_MS = 60 * 60 * 1000;

/** userId → when it was last noted; a session check within the hour is skipped. */
const lastNoted = new Lru<string, number>(5000);
/** ipHash → the place a lookup gave (null = asked, nothing came back). Never asks twice. */
const geoMemo = new Lru<string, Place | null>(5000);

export interface ClientRequest {
  readonly headers: Record<string, unknown>;
  readonly ip?: string;
}

/**
 * Record what can be told about a player's browser. Idempotent per user and
 * rate-limited to once an hour per user (in memory; a restart just notes
 * again). Nothing here is allowed to matter: errors are swallowed, every
 * field is optional downstream. Telemetry that can break a game is worse
 * than no telemetry.
 *
 * Returns true when a row was written, for the tests.
 */
export async function noteClient(
  db: Db,
  cfg: Pick<Config, 'SESSION_SECRET' | 'GEOIP_URL'>,
  req: ClientRequest,
  userId: string,
  now = Date.now(),
  opts: { force?: boolean; locate?: typeof locateIp } = {},
): Promise<boolean> {
  try {
    const last = lastNoted.get(userId);
    if (!opts.force && last !== undefined && now - last < NOTE_INTERVAL_MS) return false;
    lastNoted.set(userId, now);

    const touch = String(req.headers['x-solitaire-touch'] ?? '') === '1';
    const profile = profileOf(req.headers['user-agent'], touch);
    const ip = typeof req.ip === 'string' ? req.ip : '';
    const ipHash = ip ? hashIp(ip, cfg.SESSION_SECRET) : null;

    let place: Place | null = null;
    if (ipHash) {
      // Once per hash: the user's own row, then any row that already knows
      // this hash, then the in-memory memo, and only then the network.
      const known = await db
        .select({ country: clientMeta.country, region: clientMeta.region })
        .from(clientMeta)
        .where(and(eq(clientMeta.ipHash, ipHash), isNotNull(clientMeta.country)))
        .limit(1);
      if (known[0]) place = known[0];
      else {
        const memo = geoMemo.get(ipHash);
        if (memo !== undefined) place = memo;
        else {
          place = await (opts.locate ?? locateIp)(cfg.GEOIP_URL, ip);
          geoMemo.set(ipHash, place);
        }
      }
    }

    await db
      .insert(clientMeta)
      .values({
        userId,
        ...profile,
        ipHash,
        country: place?.country ?? null,
        region: place?.region ?? null,
        updatedAt: new Date(now),
      })
      .onConflictDoUpdate({
        target: clientMeta.userId,
        set: {
          device: profile.device,
          os: profile.os,
          browser: profile.browser,
          ipHash: sql`coalesce(${ipHash}, ${clientMeta.ipHash})`,
          // A lookup that failed or was skipped never erases one that succeeded.
          country: sql`coalesce(${place?.country ?? null}, ${clientMeta.country})`,
          region: sql`coalesce(${place?.region ?? null}, ${clientMeta.region})`,
          updatedAt: new Date(now),
        },
      });
    return true;
  } catch {
    return false; // a session was checked; nothing about knowing less is worth an error
  }
}
