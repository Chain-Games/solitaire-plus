import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { installOutbox } from './outbox.js';
import * as schema from './schema.js';

export function createDb(url: string) {
  const client = postgres(url, { max: 10, onnotice: () => {} });
  const db = drizzle(client, { schema });
  // Notification rows written inside a transaction reach their listeners
  // after the commit (db/outbox.ts).
  installOutbox(db);
  return { db, client };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
export { schema };
