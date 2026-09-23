import type { SessionStore } from '@fastify/session';
import type Redis from 'ioredis';

type Session = Parameters<SessionStore['set']>[1];

/** Minimal @fastify/session store on ioredis. Sessions expire with the cookie. */
export class RedisSessionStore implements SessionStore {
  constructor(
    private readonly redis: Redis,
    private readonly ttlSeconds: number,
    readonly prefix = 'sess:',
  ) {}

  set(sessionId: string, session: Session, callback: (err?: Error | null) => void): void {
    this.redis.set(this.prefix + sessionId, JSON.stringify(session), 'EX', this.ttlSeconds).then(
      () => callback(null),
      (err: Error) => callback(err),
    );
  }

  get(sessionId: string, callback: (err: Error | null, session?: Session) => void): void {
    this.redis.get(this.prefix + sessionId).then(
      (raw) => {
        if (raw === null) return callback(null, undefined);
        try {
          callback(null, JSON.parse(raw) as Session);
        } catch (err) {
          callback(err as Error);
        }
      },
      (err: Error) => callback(err),
    );
  }

  destroy(sessionId: string, callback: (err?: Error | null) => void): void {
    this.redis.del(this.prefix + sessionId).then(
      () => callback(null),
      (err: Error) => callback(err),
    );
  }
}
