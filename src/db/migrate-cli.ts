import { runMigrations } from './migrate.js';
import { closePool } from './pool.js';

async function main(): Promise<void> {
  await runMigrations();
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
