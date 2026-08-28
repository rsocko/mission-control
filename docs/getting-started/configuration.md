---
title: Configuration
sidebar_label: Configuration
sidebar_position: 2
---

# Configuration

All configuration is via environment variables in `.env.local`. Copy from `.env.example` to get started.

## Core

| Variable | Default | Description |
|----------|---------|-------------|
| `LOG_LEVEL` | `info` (prod), `debug` (dev) | Logging verbosity: trace, debug, info, warn, error, fatal |
| `MC_DATABASE_BACKEND` | `sqlite` | Relational backend: `sqlite` or `postgres` |
| `MC_DB_PATH` | `./data/mission-control.db` | Path to SQLite database file |
| `MC_POSTGRES_URL` | — | Server-only PostgreSQL connection secret; required for the PostgreSQL backend |
| `MC_ALERTMANAGER_WEBHOOK_TOKEN` | — | Required scoped bearer token of at least 32 characters for Alertmanager webhook intake |
| `MC_ALERTMANAGER_INTEGRATION_ID` | `homelab` | Stable namespace used in Alertmanager incident identity |

See [Alertmanager webhook intake](../integrations/alertmanager.md) for the exact
producer URL, credential-file contract, payload allowlist, and response behavior.

### SQLite observability

`GET /api/health` includes bounded, per-process SQLite latency, contention,
slow-operation, WAL, and checkpoint metrics. SQL text and values are not
retained. Initial review thresholds are 100 ms at p95, 500 ms at p99, a 5-second
busy timeout, 64 MiB/256 MiB WAL warning/critical sizes, and checkpoint
starvation after 60 seconds with at least 1,000 pending frames. Configure these
with the `MC_DB_*` variables documented in `.env.example`.

### PostgreSQL

PostgreSQL uses an asynchronous connection pool and PostgreSQL-specific
migrations, search, queue, and health implementations. See
[PostgreSQL deployment](../operations/postgresql.md) for secret handling, TLS,
least-privilege roles, pool sizing, startup, backup, and rollback requirements.

## Microsoft Graph (Todo, Email, Calendar)

Supports multiple accounts (personal + work) via OAuth2.

| Variable | Required | Description |
|----------|----------|-------------|
| `MS_CLIENT_ID` | Yes | Azure AD app client ID |
| `MS_CLIENT_SECRET` | Yes | Azure AD app client secret |
| `MS_TENANT_ID` | No | Default: `consumers`. Use `organizations` for work accounts |
| `MS_REDIRECT_URI` | No | Default: `http://localhost:3099/api/auth/microsoft/callback` |

:::tip[Multi-account support]
The OAuth flow handles account selection automatically. Personal and work accounts can coexist — each gets its own token stored in the database.
:::

## Native APNs Push

All values are required to register native devices or dispatch APNs. Keep the
private key and token-encryption key in the deployment secret store.

| Variable | Description |
|----------|-------------|
| `APNS_TEAM_ID` | 10-character Apple Developer Team ID |
| `APNS_KEY_ID` | 10-character APNs signing key ID |
| `APNS_PRIVATE_KEY_P8_BASE64` | Base64-encoded PKCS#8 APNs `.p8` key |
| `APNS_TOPIC` | Exact application bundle identifier |
| `APNS_ENVIRONMENT` | `development` or `production`; registrations must match |
| `APNS_TOKEN_ENCRYPTION_KEY` | Base64 encoding of exactly 32 random bytes used for AES-256-GCM token encryption |

## GitHub

| Variable | Required | Description |
|----------|----------|-------------|
| `GITHUB_PAT` | Yes | Personal Access Token (for issues, PRs, stars) |
| `GITHUB_REPOS` | No | Comma-separated `owner/repo` list to sync |

## Triage Queue Sources

| Variable | Required | Description |
|----------|----------|-------------|
| `REDDIT_CLIENT_ID` | For Reddit | Reddit OAuth app client ID |
| `REDDIT_CLIENT_SECRET` | For Reddit | Reddit OAuth app secret |
| `REDDIT_REFRESH_TOKEN` | For Reddit | Reddit OAuth refresh token |
| `REDDIT_USERNAME` | No | Auto-resolved if omitted |
| `MC_YOUTUBE_CLIENT_ID` | For YouTube | Google OAuth client ID |
| `MC_YOUTUBE_CLIENT_SECRET` | For YouTube | Google OAuth client secret |
| `MC_YOUTUBE_REFRESH_TOKEN` | For YouTube | Google OAuth refresh token |
| `MC_YOUTUBE_PLAYLIST_IDS` | No | Comma-separated playlist IDs (defaults: Watch Later, Liked) |
| `MC_TRIAGE_CAPTURE_KEY` | No | Shared secret for iOS Shortcut / browser extension capture |
| `CAPTURE_IMAGE_MAX_BYTES` | `10485760` | Maximum image capture upload size in bytes |
| `CAPTURE_IMAGE_STORAGE_PATH` | `data/captures/` | Local filesystem directory for captured images |
| `MC_SHORTCUT_INSTALL_URL` | No | iCloud sharing link for the iOS Shortcut |

## AI Provider

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_PROVIDER` | `ollama` | Provider: `openai`, `azure`, `ollama`, or `bifrost` |
| `AI_BASE_URL` | `http://localhost:11434/v1` | API endpoint (Ollama default shown) |
| `AI_MODEL` | `llama3.1:8b` | Model to use for completions |
| `AI_SEMANTIC_SEARCH_ENABLED` | `false` | Opt in to meaning-based search enrichment. The saved AI setting takes precedence |
| `AI_EMBEDDING_MODEL` | Auto | Embedding model (defaults: `nomic-embed-text` for Ollama, `ollama/nomic-embed-text:latest` for Bifrost, `text-embedding-3-small` otherwise) |
| `MC_QUERY_EMBEDDING_CACHE_MAX_ENTRIES` | `128` | Maximum successful interactive query vectors retained per process |
| `MC_QUERY_EMBEDDING_CACHE_TTL_MS` | `300000` | TTL for process-local query vectors; identical in-flight requests are coalesced and failures are not cached |
| `MC_SEMANTIC_CACHE_MAX_ENTRIES` | `2048` | Maximum number of parsed `Float32` embedding vectors retained by each process |
| `MC_SEMANTIC_CACHE_MAX_BYTES` | `33554432` | Maximum estimated bytes retained by the embedding LRU; both cache limits are enforced |
| `MC_SEMANTIC_SEARCH_MAX_CANDIDATES` | `2000` | Maximum current, provider/model-compatible embeddings scored by one semantic query, selected by newest source update first |
| `OPENAI_API_KEY` | — | Required when `AI_PROVIDER=openai` |
| `AZURE_OPENAI_ENDPOINT` | — | Approved direct Azure OpenAI endpoint |
| `AZURE_OPENAI_API_KEY` | — | API key for direct Azure OpenAI |
| `BIFROST_BASE_URL` | — | Bifrost OpenAI-compatible endpoint, including `/v1` |
| `BIFROST_API_KEY` | — | Bifrost virtual key when gateway authentication is enabled |
| `AI_APPROVED_AZURE_HOSTS` | — | Additional trusted Azure endpoint hostnames |
| `AI_APPROVED_BIFROST_HOSTS` | — | Additional trusted Bifrost endpoint hostnames |
| `AI_APPROVED_OPENAI_HOSTS` | — | Additional trusted OpenAI-compatible endpoint hostnames |
| `MC_HOUSTON_TOOL_APPROVAL_SECRET` | — | Required server-only secret of at least 32 bytes for AI SDK-signed Houston finance approvals; use the same secret on every web instance |

Houston degrades gracefully when `MC_HOUSTON_TOOL_APPROVAL_SECRET` is missing
or shorter than 32 UTF-8 bytes: general chat and all finance read tools keep
working, but the two approval-gated finance mutation tools
(`assignFinanceTransactionKid` and `updateFinanceTransactionCategory`) are
removed from the tool set, and any request that carries a finance approval or
denial decision fails closed with a 503 explaining the missing secret. The
secret signs approval requests and is never returned to the browser or
written to logs. Generate it in the deployment secret manager and keep the
value identical across instances so an approval issued by one instance can be
verified by another.

:::info[Azure OpenAI]
For Azure, set `AI_PROVIDER=azure` plus `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT`.
:::

:::info[Azure through Bifrost]
Set `AI_PROVIDER=bifrost`, `BIFROST_BASE_URL=https://gateway.example.com/v1`,
and use a provider-qualified model such as `azure/gpt-4o-mini`. Mission Control
loads the gateway's model catalog from `/v1/models` and enforces sensitivity
routing from the model's provider prefix.

Semantic search is a separate, off-by-default feature under **Settings → AI
Provider**. Its embedding model is independent from the completion model.
Bifrost embedding IDs must be provider-qualified (for example,
`ollama/nomic-embed-text:latest`). Entity embeddings remain durable in SQLite,
while query embeddings are kept only in a bounded in-memory cache and never
written as query history. Interactive searches report `not-ready` until
compatible entity embeddings exist; index maintenance runs separately and is
never triggered by a query.

Search requests may include `source`, `status`, and `excludeDone=true`. These
filters are applied to both keyword and semantic results before they are
returned. Keyword filtering considers the best 50 FTS candidates; semantic
filtering is applied in SQLite before the configured candidate limit is scored.
:::

Settings can also be changed at runtime. `GET /api/ai/provider` returns the
redacted active configuration, `POST /api/ai/provider` saves provider and
routing settings in SQLite, and `PUT /api/ai/provider` tests the active
connection. Saved SQLite values take precedence over environment defaults.

## Connected Services

| Variable | Default | Description |
|----------|---------|-------------|
| `FINANCE_MANAGER_API_TOKEN` | — | Optional server-side fallback for Tyrion's bearer token; connector setup can persist `BRIDGE_API_TOKEN` instead |
| `TYRION_FINANCE_INSIGHTS_TIMEOUT_MS` | `10000` | Bounded private Finance Insights request timeout, capped at 30 seconds |
| `TYRION_FINANCE_INSIGHTS_MAX_RETRIES` | `2` | Retry count for retryable private Finance Insights failures, capped at 3 |
| `TYRION_FINANCE_INSIGHTS_SHADOW_INGEST_ENABLED` | `false` | Enables server-only staged publication, evaluation retry, and bounded occurrence shadow ingestion; notification delivery still requires the per-connector cutover fence |
| `TYRION_FINANCE_INSIGHTS_IMMEDIATE_NOTIFICATIONS_ENABLED` | `false` | Enables immediate notifications for eligible fresh large transactions and recurring amount increases |
| `TYRION_FINANCE_INSIGHTS_MONTHLY_DIGEST_NOTIFICATIONS_ENABLED` | `false` | Enables the grouped high-confidence monthly movers digest after 09:00 on day 2 in the configured household timezone |
| `TYRION_ATTRIBUTION_EXPECTED_POLICY_VERSION` | — | Required positive static fence for normal attribution sync and operator readiness; production currently uses policy version `2`, which is independent of attribution contract version `2.0` |
| `TYRION_ATTRIBUTION_TIMEOUT_MS` | `10000` | Bounded Tyrion attribution request timeout, capped at 30 seconds |
| `MONARCH_WEB_URL` | `https://app.monarchmoney.com` | Public Monarch origin used for comprehensive finance workflow links |
| `TYRION_OPERATIONS_URL` | `https://tyrion.example` | Allowlisted public Tyrion operations root used for configuration and the server-constructed `?source=mission-control` reconnect action |
| `FINANCE_EXTERNAL_ALLOWED_HOSTS` | — | Additional comma-separated HTTPS hosts approved for public finance links |
| `FINANCE_OWL_ALLOWED_HOSTS` | — | Additional comma-separated HTTPS hosts approved for mapped OWL document actions |
| `DOC_INTELLIGENCE_URL` | `http://localhost:8200` | OWL, the Paperless-ngx connector and document agent for Mission Control |
| `DOC_INTELLIGENCE_API_KEY` | — | API key for OWL |
| `PAPERLESS_BASE_URL` | `http://localhost:8000` | Paperless-ngx system of record (for authoritative document links) |
| `RYMESSAGE_MODE` | `rest` | RyMessage mode: `rest` or `sqlite` |
| `RYMESSAGE_API_URL` | `http://localhost:1234/api/v1` | RyMessage REST API URL |
| `RYMESSAGE_API_KEY` | — | RyMessage API authentication key |
| `HOME_ASSISTANT_URL` | `http://localhost:8123` | Home Assistant instance |
| `HOME_ASSISTANT_TOKEN` | — | HA long-lived access token |
| `HOME_ASSISTANT_ENTITIES` | — | Comma-separated entity globs to monitor |

Finance Insight publication also requires an exact ISO 4217
`householdCurrency` in the persisted Finance Manager connector settings. There
is no currency environment fallback or inferred/default currency.

Each Tyrion connector stores a canonical, non-secret Bridge API base URL entered
in setup. Production defaults to the protected backend-only gateway at
`https://tyrion.example/api/connector/v1`; local development defaults to
`http://localhost:8100`. Custom HTTPS base URLs can include a fixed path. Safe
loopback/private hosts may use HTTP. Base URLs cannot contain credentials,
queries, fragments, encoded separators, or path traversal. The bare
`https://tyrion.example` operations UI is rejected with guidance to use the
versioned gateway. The browser `/api/bridge` proxy and Tyrion auth, session, raw
bridge, and internal routes are not connector APIs. Connector requests never
follow redirects.

Mission Control polls normalized Tyrion health every five minutes. Degraded or
unavailable health remains suppressed for the first 15 minutes; a verified
`expired` or `unauthenticated` state is immediately actionable. One durable
outage episode owns one notification and, after four hours, one local task and
My Day item. Restarting Mission Control does not reset either threshold.
Recovery is not inferred from navigation: Mission Control requires connected
live health, performs `POST /sync?days=30` without a request body, and then
requires a second connected live health response before settling the episode.
The reconnect action is built only from `TYRION_OPERATIONS_URL`; producer URLs,
Monarch cookies, `session_id`, `csrftoken`, and reusable session material are
not accepted.

The attribution client calls only
`POST http://tyrion-operations-ui:3000/api/internal/v2/attribution/batch` and
uses the connector's persisted service token, falling back to
`FINANCE_MANAGER_API_TOKEN`, as a standard bearer credential. New setup stores
only the canonical `serviceToken` key; bounded legacy aliases remain readable
for migration. That path must
remain absent from public routers. Tyrion fixes the service actor and household
identity server-side; Mission Control sends no identity, signature, timestamp,
nonce, or replay metadata. The bearer token is authentication only. Mission
Control persists a random identity namespace in protected connector credentials
and uses ordinary SHA-256 derivation to create stable opaque connector-scoped
source and account references. Raw Monarch identifiers never cross the Tyrion
service boundary, and the namespace is never returned to browser clients.

Finance Insight source facts use the same protected connector namespace to
replace raw Monarch transaction, recurring, category, category-group, account,
and tag identifiers with deterministic connector-scoped references. These
ordinary identities require no deployment `DATA_KEY`, identity key, or derived
secret subkey.

## Bug Snap Widget

| Variable | Default | Description |
|----------|---------|-------------|
| `MC_BUG_SNAP_KEY` | Falls back to `MC_TRIAGE_CAPTURE_KEY` | Shared secret for the embeddable bug-snap widget |
