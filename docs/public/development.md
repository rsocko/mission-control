# Public Development Guide

## Repository layout

| Path | Purpose |
| --- | --- |
| `src/app` | UI routes and API route handlers |
| `src/components` | Shared and feature components |
| `src/lib/connectors` | External-service adapters |
| `src/lib/sync` | Synchronization and durable job logic |
| `src/mcp` | MCP server and tools |
| `drizzle` | Database migrations |
| `tests` | End-to-end tests |
| `.github/workflows` | CI and release automation |

## Change workflow

1. Branch from `main`.
2. Reproduce the behavior with synthetic data.
3. Add tests for success, failure, and boundary cases.
4. Update documentation for public contracts or operator behavior.
5. Run the smallest relevant test set, then lint.
6. Open a pull request and complete the security and privacy checklist.

Common commands:

```bash
npm run test
npm run lint
npm run build
npm run test:e2e
npm run ci:workflows
```

See [continuous integration and container publication](continuous-integration.md)
for CI trust boundaries, GHCR digest publication, and required repository
settings.

Do not commit `.env.local`, databases, logs, screenshots containing real data,
or generated connector exports. Use `example.test`, reserved documentation IP
addresses, and synthetic account names in all examples.

Changes to authentication, connectors, workflows, release code, or deployment
templates require CODEOWNERS review. Workflow changes must use GitHub-hosted
runners for untrusted pull requests, explicit least-privilege permissions, and
immutable action references.
