# Public Architecture Guide

Mission Control is a local-first task aggregation service. A browser or MCP
client communicates with a Next.js web process. Connector synchronization may
run in a separate worker process. Both processes use the same explicitly
configured relational backend.

```mermaid
flowchart LR
  Browser["Browser / PWA"] --> Web["Next.js web service"]
  MCP["MCP client"] --> Web
  Web --> DB[("PostgreSQL or SQLite")]
  Web --> Queue["Durable sync queue"]
  Worker["Sync worker"] --> Queue
  Worker --> DB
  Worker <--> Services["Operator-configured services"]
```

## Trust boundaries

- Browser input, connector payloads, webhooks, and pull-request content are
  untrusted.
- Credentials remain outside source control and are available only to the
  process that needs them.
- Connectors receive least-privilege upstream permissions and own their
  read/write behavior.
- The worker claims durable jobs and records results in the configured backend.
- Public CI uses GitHub-hosted infrastructure and must not receive protected
  secrets from untrusted pull requests.

This diagram is intentionally deployment-neutral. Operators choose their own
hostnames, accounts, and providers and should not copy production identifiers
into documentation or issues.

PostgreSQL is the approved production target and is implemented as a selectable
backend. SQLite remains the application default and compatibility backend.
Mission Control documentation treats the homelab as SQLite-backed until the
maintenance-window cutover tracked by
[#1155](https://github.com/rsocko/mission-control/issues/1155) and
[homelab-config#574](https://github.com/rsocko/homelab-config/issues/574) is
completed. See the
[database scaling and migration strategy](../design/active/database-scaling-strategy.md).
