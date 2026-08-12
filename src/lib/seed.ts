/**
 * Development seed CLI.
 * Run: npm run db:seed
 */
import { resetDemoDatabase } from '@/lib/seed-api';

async function main() {
  await resetDemoDatabase();
  process.stdout.write('Mission Control demo database reset and seeded\n');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`Failed to seed Mission Control demo database\n${message}\n`);
  process.exitCode = 1;
});
