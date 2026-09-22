import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PATHS = [
  'src/lib/external-agents/http.ts',
  'src/lib/external-agents/policy.ts',
  'src/lib/external-agents/registry.ts',
  'src/lib/external-agents/service.ts',
  'src/lib/external-agents/transports.ts',
  'src/app/api/external-agents/route.ts',
  'src/app/api/external-agents/[id]/route.ts',
  'src/app/api/external-agents/dispatch/route.ts',
  'src/app/api/external-agents/dispatches/route.ts',
  'src/app/api/external-agents/dispatches/claim/route.ts',
  'src/app/api/external-agents/dispatches/[id]/route.ts',
  'src/app/api/external-agents/dispatches/[id]/result/route.ts',
  'src/app/api/external-agents/import/route.ts',
] as const;

describe('external-agent PostgreSQL import safety', () => {
  it.each(PATHS)('%s does not import SQLite persistence', (path) => {
    const source = readFileSync(join(process.cwd(), path), 'utf8');
    expect(source).not.toMatch(/(?:from\s*['"]@\/db(?:['"/])|import\(\s*['"]@\/db)/);
    expect(source).not.toMatch(/better-sqlite3|drizzle-orm\/better-sqlite3/);
    expect(source).not.toMatch(/\.\.\/.*sqlite|@\/db\/persistence\/sqlite/i);
  });
});
