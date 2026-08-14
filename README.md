# Mission Control

Personal task & alert aggregation hub. A local-first, self-hosted system that provides a unified view across all your task sources (Microsoft Todo, GitHub Issues, Outlook, custom databases, RyMessage Action Center) with AI-powered reasoning.

## Features (Planned)

- **Unified Task View** — See all tasks across sources in one list with filtering, sorting, and sub-task hierarchy
- **Alert Aggregation** — Centralized notifications from email, calendar, GitHub, and messaging
- **Triage Queue** — Review saved content from GitHub, Reddit, YouTube, social capture, and share-sheet inputs in one routing queue
- **My Day / Today View** — Cross-source daily planner with smart suggestions
- **Kanban Board** — Drag-and-drop organization across sources
- **Hub Projects** — Define projects that span multiple sources
- **Tag Overlay** — Manual + AI-inferred tags for cross-cutting grouping
- **Focus Planner** — "What should I work on next?" with time/project constraints
- **AI Assistant** — Natural language queries, smart prioritization, agent dispatch
- **Write-Through** — Complete, edit, and move tasks from the unified view back to sources

## Tech Stack

- **Framework**: Next.js 14 (App Router) + TypeScript
- **Database**: SQLite via Drizzle ORM (local-first)
- **UI**: Tailwind CSS + shadcn/ui components
- **State**: TanStack Query + Zustand
- **AI**: Vercel AI SDK (configurable: OpenAI, Azure, Ollama)
- **Sync**: node-cron scheduler with per-connector configuration

## Getting Started

```bash
# Install dependencies
npm install

# Copy environment template
cp .env.example .env.local

# Push database schema
npm run db:push

# Start development server
npm run dev
```

Open [http://localhost:3099](http://localhost:3099) to access Mission Control.

`npm run dev` uses the managed development-service supervisor. It records the
owning worktree, process tree, port, uptime, and resource use. On Windows, a
Job Object applies CPU and memory limits and terminates the complete process
tree when the terminal or Copilot session closes.

```bash
npm run dev:services          # shared service inventory
npm run dev:stop -- <id>      # stop the supervised process tree
npm run dev:orphan-scan       # scan Copilot lifecycle registrations
```

See [Managed Development Services](docs/development/dev-services.md) for
resource limits, TTL behavior, temporary uncapped runs, inventory, and logs.

## MCP Server (AI Agent Integration)

Mission Control includes an MCP (Model Context Protocol) server that lets AI agents like GitHub Copilot manage your projects, tasks, and tags directly.

```bash
# Start the MCP server
npm run mcp
```

See [docs/MCP-SERVER.md](docs/MCP-SERVER.md) for setup, available tools, and Copilot CLI configuration.

## Community and Governance

- [Security policy](SECURITY.md)
- [Contributing guide](CONTRIBUTING.md)
- [Code of conduct](CODE_OF_CONDUCT.md)
- [Support policy](SUPPORT.md)
- [Compatibility policy](docs/governance/compatibility.md)
- [Release and versioning policy](docs/governance/releases.md)
- [Connector data and privacy](docs/governance/connector-privacy.md)
- [Licensing status](docs/governance/licensing.md)
- [Public architecture and development guides](docs/public/architecture.md)

Mission Control does not yet have an approved software license. No license is
granted to copy, redistribute, or create derivative works, and external
contributions cannot be accepted until the legal/IP review records an explicit
decision and the approved `LICENSE` file is added.

## Triage Queue Phase 2 (GitHub + Reddit ingestion)

- Manual import endpoints:
  - `POST /api/triage/import/github-stars`
  - `POST /api/triage/import/reddit-saved`
- **Scheduled auto-sync** (#162):
  - `GET /api/triage/auto-sync` — current schedule config & job status
  - `PUT /api/triage/auto-sync` — update schedule (on/off, interval per source)
  - `POST /api/triage/auto-sync` — trigger immediate import for a source
  - Default: GitHub Stars every 30 min (off by default; toggle in Settings → Triage Sources)
  - Config stored in `app_settings` key `triage_auto_sync`
  - Scheduler initialized in `instrumentation.ts` alongside connector sync
- Universal capture endpoint for iOS Shortcut/browser extension:
  - `POST /api/triage/capture`
- Required env for imports:
  - `GITHUB_PAT`
  - `REDDIT_CLIENT_ID`
  - `REDDIT_CLIENT_SECRET`
  - `REDDIT_REFRESH_TOKEN`
  - optional `REDDIT_USERNAME`
  - optional `MC_TRIAGE_CAPTURE_KEY` for external capture auth

## Connector Architecture

Each data source is a plugin implementing the `IConnector` interface:

| Connector | Read | Write | Sub-tasks | Lists |
|-----------|------|-------|-----------|-------|
| Microsoft Todo | ✅ | ✅ | ✅ (checklist) | ✅ |
| GitHub Issues | ✅ | ✅ | ✅ (sub-issues + task-lists) | ✅ (repos + projects) |
| Outlook Calendar | ✅ | ❌ | ❌ | ✅ |
| Outlook Email | ✅ | ✅ (mark read) | ❌ | ✅ (folders) |
| RyMessage | ✅ | ❌ | ❌ | ❌ |
| Custom REST API | ✅ | Configurable | Configurable | Configurable |

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
│   ├── page.tsx           # Dashboard (unified list)
│   ├── today/             # My Day view
│   ├── kanban/            # Kanban board
│   ├── ai/               # AI assistant
│   ├── settings/          # Connector & system settings
│   └── api/              # API routes
├── components/            # React components
├── db/                    # Drizzle schema & database
├── lib/
│   ├── connectors/       # Connector plugins
│   ├── sync/             # Sync scheduler
│   └── ai/              # AI provider layer
├── stores/               # Zustand stores
├── hooks/                # Custom React hooks
└── types/                # TypeScript interfaces
```

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3099](http://localhost:3099) with your browser to see the result.

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
