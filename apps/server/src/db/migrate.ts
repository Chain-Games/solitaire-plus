import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createDb } from './index.js';

/** Apply pending SQL migrations from ./drizzle. Safe to run on every boot. */
export async function runMigrations(url: string): Promise<void> {
  const { db, client } = createDb(url);
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Works from src/ (tsx) and dist/ (node) alike.
  const migrationsFolder = path.resolve(here, '..', '..', 'drizzle');
  await migrate(db, { migrationsFolder });
  await client.end();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is required');
  runMigrations(url).then(
    () => {
      console.log('migrations applied');
    },
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
