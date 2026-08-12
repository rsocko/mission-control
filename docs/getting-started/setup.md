---
title: Development Setup
sidebar_label: Setup
sidebar_position: 1
---

# Development Setup

Get Mission Control running locally for development.

## Prerequisites

- **Node.js** 22+ (LTS recommended)
- **npm** (comes with Node.js)
- **Git**

:::tip[Optional but recommended]
- [Drizzle Studio](https://orm.drizzle.team/drizzle-studio/overview) for database inspection (`npm run db:studio`)
- An Ollama instance for local AI features
- **Microsoft Edge** as your browser — Edge's built-in AI text prediction provides free inline typeahead suggestions in the Quick Add bar and other text inputs, making task entry faster
:::

## Clone & Install

```bash
git clone https://github.com/octo-org/mission-control.git
cd mission-control

# Install dependencies
npm install
```

## Configure Environment

```bash
# Copy the environment template
cp .env.example .env.local
```

Edit `.env.local` with your values. See the [Configuration reference](./configuration.md) for all available variables.

:::info[Minimum viable config]
For basic local development, you only need:
- `MC_DB_PATH=./data/mission-control.db` (default)
- `AI_PROVIDER=ollama` + running Ollama instance

All connectors are optional and can be enabled incrementally.
:::

## Database Setup

```bash
# Push the schema to SQLite (creates DB file if needed)
npm run db:push

# Optional: seed with sample data
npm run db:seed
```

## Run Development Server

```bash
npm run dev
```

Open [http://localhost:3099](http://localhost:3099) to access Mission Control.

## Useful Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start bounded dev server (port 3099) |
| `npm run dev:services` | List active dev services and resource use |
| `npm run dev:stop -- ID` | Stop a supervised service by inventory ID |
| `npm run build` | Production build |
| `npm run test` | Run unit tests (Vitest) |
| `npm run test:watch` | Tests in watch mode |
| `npm run test:e2e` | Run Playwright E2E tests |
| `npm run lint` | ESLint check |
| `npm run db:studio` | Open Drizzle Studio (DB browser) |
| `npm run db:push` | Push schema changes to DB |
| `npm run db:generate` | Generate migration files |
| `npm run db:migrate` | Run pending migrations |

## Running a Local Test Instance

When you need to validate changes without deploying to production — especially useful for iterative dev testing or CI validation:

### Quick Start (separate from production)

```bash
# Use a dedicated dev database (keeps production data untouched)
# In .env.local, set:
MC_DB_PATH=./data/mission-control-dev.db

# If port 3099 is in use (e.g., production is running), use a different port:
npm run dev -- --port 3098

# The server auto-creates the DB and runs all migrations on first request.
```

### Seeding Demo Data

```bash
# Set MC_DB_PATH so the seed targets the correct database
# PowerShell:
$env:MC_DB_PATH="./data/mission-control-dev.db"; npm run db:seed
# Bash:
MC_DB_PATH=./data/mission-control-dev.db npm run db:seed
```

The seed script populates: 16 tasks, 6 alerts, 14 tags, 3 projects, My Day items, and source lists.

### Known Gotchas

| Issue | Cause | Fix |
|-------|-------|-----|
| `server-only` error when running `db:seed` | The `server-only` package throws outside Next.js runtime | Ensure `server-only` is installed (`npm install server-only`) — the shimmed version allows CLI scripts to import the logger |
| Seed writes to wrong DB | Seed script defaults to `data/mission-control.db` if `MC_DB_PATH` is unset | Always export `MC_DB_PATH` before running `npm run db:seed` |
| Port 3099 in use | Another Mission Control instance (production) is already running | Use `npm run dev -- --port 3098` or any available port |
| Empty tables after seed | Seed ran before migrations | Start the dev server first (triggers auto-migration), then seed |

### Validating the Instance

```bash
# Check server is responding
curl http://localhost:3098

# Verify seeded data is accessible
curl http://localhost:3098/api/tasks
```

See [Managed Development Services](../development/dev-services.md) for resource
limits, shared inventory, automatic cleanup, and temporary uncapped runs.

## Project Structure

```
mission-control/
├── src/
│   ├── app/              ← Next.js App Router pages & API routes
│   ├── components/       ← React UI components
│   ├── lib/              ← Core logic (db, connectors, AI, sync)
│   └── hooks/            ← Client-side React hooks
├── docs/                 ← Documentation (this site)
├── tests/                ← E2E tests (Playwright)
├── drizzle/              ← Database migrations
├── public/               ← Static assets
├── scripts/              ← Utility scripts
└── deploy/               ← Deployment configs
```
