import { loadConfig } from './config.js';
import { backfillXp } from './db/backfill-xp.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
await runMigrations(cfg.DATABASE_URL);
console.log('migrations: up to date');
// Idempotent: credits anything finished before XP existed, then does nothing.
const backfill = await backfillXp(cfg.DATABASE_URL);
console.log(`xp backfill: ${backfill.games} games, ${backfill.wins} challenge wins credited`);
const app = await buildApp(cfg);

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: cfg.PORT, host: cfg.HOST });
