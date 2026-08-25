<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Dependency Restoration Policy

Corporate development environments use the approved npm registry at
`https://packagefeedproxy.microsoft.io/npm/`. Some versions locked by this repository may not
yet be mirrored there.

- Do not run `npm install` or `npm ci` as routine session setup. First use the existing
  `node_modules` and run the smallest relevant validation command; restore only when a command
  fails because dependencies are actually missing.
- Before any restore, run `npm config get registry`. If it is not the approved registry above,
  stop and report the configuration problem. Never switch to or retry against the public npm
  registry.
- The committed `package-lock.json` is authoritative. Restore with
  `npm ci --prefer-offline --no-audit --no-fund --fetch-retries=0 --fetch-timeout=15000`.
  Do not use unconstrained installs or request newer package versions.
- If the approved registry lacks a locked package or version, stop after the first failed
  restore. Do not retry, add a different registry, use an unapproved tarball/cache, or downgrade
  the dependency merely to make installation succeed.
- Add or update a dependency only when the task explicitly requires it. Confirm the exact
  version exists in the approved registry before editing either package manifest, then keep
  `package.json` and `package-lock.json` in sync.
- When restoration is blocked, continue work that does not require missing dependencies. Run
  only validations supported by the existing installation and report the remaining validation
  as blocked by the approved registry rather than repeatedly attempting installation.

## Local Dev Testing

When you need to spin up a test instance of Mission Control (e.g., to validate a fix, test a feature, or run E2E checks without deploying):

1. **Create `.env.local`** (if not present) with at minimum:
   ```
   MC_DB_PATH=./data/mission-control-dev.db
   AI_PROVIDER=ollama
   AI_BASE_URL=http://localhost:11434/v1
   AI_MODEL=llama3.1:8b
   ```

2. **Restore dependencies only if required**: follow the Dependency Restoration Policy above.

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
- The seed script requires the existing `server-only` package dependency.
- Always set `MC_DB_PATH` env var when running `db:seed` — it defaults to a different path otherwise.
- DB migrations run automatically via `src/db/index.ts` on first connection (no manual `db:migrate` needed for dev).
- The `data/` directory is gitignored — dev databases are local-only.

## Pull Request Creation

Before invoking the app-native `create_pull_request` tool, push the current branch and verify that its head exists on the remote:

```bash
git push --set-upstream origin HEAD
git ls-remote --exit-code --heads origin "$(git branch --show-current)"
```

Do not invoke `create_pull_request` unless both commands succeed. Repeat this preflight after renaming a branch. If the push or verification fails, surface that error instead of submitting a PR request with a missing head branch.

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
