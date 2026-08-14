<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

## Local Dev Testing

When you need to spin up a test instance of Mission Control (e.g., to validate a fix, test a feature, or run E2E checks without deploying):

1. **Create `.env.local`** (if not present) with at minimum:
   ```
   MC_DB_PATH=./data/mission-control-dev.db
   AI_PROVIDER=ollama
   AI_BASE_URL=http://localhost:11434/v1
   AI_MODEL=llama3.1:8b
   ```

2. **Install deps**: `npm install` (also install `server-only` if missing)

3. **Start the dev server** on an available port through the managed service:
   ```bash
   npm run dev -- --port 3098
   ```
   The server auto-creates the SQLite DB and runs all Drizzle migrations on first request.

4. **Seed demo data** (optional but recommended for testing):
   ```bash
   # MUST set MC_DB_PATH so seed targets the correct database
   MC_DB_PATH=./data/mission-control-dev.db npm run db:seed
   ```

5. **Verify**: `curl http://localhost:3098/api/tasks` should return seeded tasks.

**Key notes for agents:**
- Port 3099 is typically the production instance — use 3098 or another port for dev.
- Never launch a development server directly or with tool-level `detach`. The managed service registers the process tree, applies resource and TTL limits, and closes its Windows Job Object when the terminal or Copilot session ends.
- Use `npm run dev:services` to see ports, uptime, memory, CPU limits, and owning worktrees; use `npm run dev:stop -- <id>` for supervised cleanup.
- Use `npm run dev:uncapped -- --port <port>` only for temporary profiling that cannot fit inside the normal resource boundary. It remains supervised and has a shorter TTL.
- The seed script requires `server-only` to be installed as a package dep.
- Always set `MC_DB_PATH` env var when running `db:seed` — it defaults to a different path otherwise.
- DB migrations run automatically via `src/db/index.ts` on first connection (no manual `db:migrate` needed for dev).
- The `data/` directory is gitignored — dev databases are local-only.

## Task Completion Workflow

After completing any requested task, perform the following self-review before considering work done:

### Phase 1: Complete the Task
- Implement the requested feature, fix, or change
- Run all relevant tests to confirm the implementation works

### Phase 2: Self-Review Checklist
Review your work for:
- **Bugs**: Logic errors, off-by-one errors, null/undefined handling
- **Incomplete code**: TODO comments left behind, partial implementations, missing imports
- **Security vulnerabilities**: Injection risks, exposed secrets, improper auth checks, unsafe data handling
- **Performance issues**: N+1 queries, unnecessary re-renders, missing memoization, unbounded loops
- **UX problems**: Missing loading states, unhelpful error messages, broken navigation flows
- **Accessibility**: Missing ARIA labels, keyboard navigation gaps, color contrast issues
- **Edge cases**: Empty states, boundary values, concurrent access, network failures
- **Error handling**: Missing try/catch, swallowed errors, unclear error messages to users
- **Type safety**: Any types, missing null checks, unsafe casts
- **Race conditions**: Async operations that could conflict, stale state

### Phase 3: Test Coverage
- Verify automated tests exist for all new/changed behavior
- Add missing unit tests, integration tests, or e2e tests as appropriate
- Ensure edge cases identified in Phase 2 have test coverage

### Phase 4: Fix & Verify
- Fix any issues found in Phases 2-3
- Run the full relevant test suite again to confirm fixes don't break anything
- Ensure documentation is updated if behavior changed
