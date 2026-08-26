import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './src/db/postgres/schema/index.ts',
  out: './drizzle/postgres',
  dialect: 'postgresql',
  dbCredentials: {
    url:
      process.env.MC_POSTGRES_URL
      ?? 'postgresql://migration-generation.invalid/mission_control',
  },
});
