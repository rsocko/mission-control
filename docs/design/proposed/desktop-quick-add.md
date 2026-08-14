---
title: "Desktop Quick Add"
status: proposed
created: 2026-08-01
last_reviewed: 2026-08-01
category: design
contract_version: 1
related:
  - "[Voice Capture](voice-capture.md)"
  - "[Houston Voice and Flight Director UI](houston-voice-and-operations-ui.md)"
  - "[Mobile iOS Native Bridge and API Security Contract](../active/mobile-ios-native-security-contract.md)"
mockups:
  - "[Interactive desktop Quick Add concept](../../mockups/desktop-quick-add.html)"
  - "[Houston Flight Director interactive concept](../../mockups/mockup-houston-operations.html)"
---

# Desktop Quick Add

## Summary

Desktop Quick Add is a small Windows-first companion that captures a task from
any application without opening the Mission Control website. A configurable
global shortcut opens a compact command window; the user types, presses Enter,
sees native confirmation, and returns to the prior application.

The recommended MVP is a Tauri 2 tray application with:

- one global command window and one configurable shortcut;
- a server-owned Quick Add parse-and-create API;
- explicit device pairing and a revocable, capture-scoped credential;
- a durable offline outbox with idempotent retry; and
- native success, queued, and error notifications.

The [interactive mockup](../../mockups/desktop-quick-add.html) compares the
command window, opt-in edge tab, and compact widget shapes. It is a standalone
local HTML file and does not define the API contract.

## Product goals

1. Reduce task-capture initiation to a single shortcut from any Windows app.
2. Preserve the Quick Add language users already learn in Mission Control.
3. Complete the keyboard-only capture loop without opening a browser.
4. Never lose or duplicate a capture during intermittent connectivity.
5. Keep parsing and task-creation behavior consistent across web and desktop.
6. Establish a portable Tauri core without delaying a high-quality Windows MVP.

## Non-goals

- Rebuild the Mission Control dashboard or task manager as a native desktop app.
- Duplicate connector, project, tag, or account administration.
- Put Mission Control API keys or deployment secrets in a desktop binary.
- Make the desktop renderer authoritative for parsing or connector capability.
- Ship an always-on-top edge tab, Windows Widget, voice capture, file capture, or
  macOS/Linux distribution in the MVP.
- Guarantee full offline destination validation; queued captures are validated
  by the server when connectivity returns.

## Existing behavior and rationale

`src/components/add-task/QuickAddBar.tsx` is the current reference experience.
It parses on each input change, resolves destination shortcuts, supports
multiple pending tasks and parent/subtask creation, applies My Day defaults,
creates tasks through existing APIs, and presents post-create metadata and
suggestions.

`src/lib/parse-task-input.ts` currently recognizes:

| Syntax | Meaning |
| --- | --- |
| Natural date text | Due date, including `tomorrow`, `next Friday`, and `in 3 days` |
| `!critical`, `!high`, `!medium`, `!low`, `!0`-`!3` | Priority |
| `#tag` | One or more tag slugs |
| `@work`, `@personal`, `@github`, `@todo` | Destination family |
| `/project-name` | Project or list hint |
| `~30m`, `~1.5h` | Estimated duration |
| `^1`-`^5` | Effort |
| `daily`, `weekly`, `every 3 days`, weekday lists | Recurrence |
| `\` before a token trigger or date word | Literal text escape |

The current browser component performs meaningful orchestration after parsing:
destination/list resolution, compound-task handling, parent-before-subtask
creation, My Day application, completion updates, partial-failure handling, and
response formatting. A desktop client must not reproduce that workflow. Doing
so would create parser drift, require extra round trips, and make connector
behavior dependent on the installed client version.

The server should therefore extract a tested Quick Add service from the browser
workflow. The web bar can progressively adopt the same service after parity is
proven. `POST /api/tasks` remains a lower-level API for callers that already
have normalized task fields.

## UX surfaces and interaction model

### Global command window

The primary surface opens near the top center of the active monitor and focuses
the input. The target warm shortcut-to-focused-input latency is under 150 ms.

- `Enter`: submit and close after server acknowledgement.
- `Ctrl+Enter`: submit, clear, and stay open for consecutive capture.
- `Tab`: expand explicit destination, schedule, and option controls.
- `Escape`: close without submitting.
- Token chips preview the server-compatible interpretation of dates, priority,
  tags, list, effort, duration, and recurrence.
- Ambiguous or invalid input remains editable; it is never silently rewritten.
- On success, focus returns to the previously active application.

The proposed default shortcut is `Ctrl+Alt+Space`. Onboarding must detect a
registration conflict and require the user to choose another combination.

### System tray

The tray is the discoverable secondary entry point:

- Quick Add;
- pending outbox count and connection state;
- retry or inspect pending captures;
- open Mission Control;
- settings, pairing status, and credential revocation; and
- quit.

The app may start at login only after explicit user choice. Closing the command
window leaves the tray process running; Quit ends it.

### Native notifications

- **Created:** task title and destination with Open and, when safely supported,
  Undo actions.
- **Saved offline:** capture retained locally with the pending count.
- **Action required:** non-retryable validation or authorization error with an
  Inspect action.

Notification content must be suppressible and should avoid sensitive full task
titles when the user enables privacy mode.

### Deferred surfaces

The edge tab, voice capture, clipboard suggestions, multi-task paste, Windows
Widget, Explorer/Share integrations, and local command palette are advanced
work. The edge tab is always opt-in because persistent screen chrome can be
distracting.

## MVP scope

1. Windows 11 installer and signed update path.
2. Tray lifecycle, explicit autostart setting, and configurable global shortcut.
3. Compact and expanded Quick Add window with keyboard-complete behavior.
4. Pairing, credential storage, rotation/re-pair UX, and revocation.
5. Capability and destination cache with visible stale/offline state.
6. Version 1 Quick Add preview and create API.
7. Date, priority, tags, destination/list, duration, effort, recurrence, and My
   Day defaults consistent with the current web experience.
8. Durable bounded outbox and idempotent retries across app restarts.
9. Native created, queued, and actionable-error notifications.
10. Open-created-task deep link and basic diagnostics with redacted logs.

The first release may support one parent task per request. Multi-task paste and
subtask trees should only enter version 1 if the extracted server service can
offer atomic or clearly reported partial outcomes without delaying the core
single-task loop.

## Advanced roadmap

### Capture workflow

- Voice dictation with transcript review.
- Clipboard-aware URL and text suggestions.
- Multi-task paste, Markdown checklist parsing, and nested preview.
- Templates, recent destinations, and configurable defaults.
- Post-create Quick Sort suggestions.
- Undo and edit-last-capture.
- Meeting mode for rapid consecutive capture.

### Ambient Windows integration

- Opt-in docked edge tab.
- Jump List actions.
- Windows Widget for My Day plus a Quick Add deep link.
- Explorer, browser, and Windows Share targets.
- Drag-and-drop text, URLs, files, images, and email snippets.
- Calendar-aware schedule hints and optional sync-failure notifications.

### Portability

Keep the API, renderer, domain types, outbox semantics, and most Tauri commands
portable. Add macOS and Linux packaging only after Windows usage validates the
capture habit. Platform modules own shortcuts, credential storage,
notifications, window placement, autostart, and shell integrations.

## Tauri 2 Windows-first architecture

Place the client in `clients/desktop/`:

```text
clients/desktop/
  src/                 React capture renderer
  src-tauri/
    src/
      auth/            pairing and credential lifecycle
      outbox/          durable queue and retry worker
      platform/        Windows shell adapters
      api/             typed HTTP client and capability cache
      commands/        narrow renderer command surface
```

### Responsibility split

| Layer | Owns | Must not own |
| --- | --- | --- |
| React renderer | Input, token preview, explicit fields, pending-state UI, accessibility | Secrets, direct filesystem access, authoritative parsing |
| Tauri Rust core | Window/tray lifecycle, hotkey, HTTP, secure storage, outbox, notifications, redacted diagnostics | Mission Control business rules |
| Mission Control server | Authentication, schema validation, parsing, destination resolution, orchestration, idempotency, audit events | Desktop window behavior |

Use a narrow, allowlisted Tauri command surface. Do not enable arbitrary shell,
filesystem, or HTTP access in the renderer. Content Security Policy should
permit packaged assets and the configured Mission Control origin only where
network access is required by the Rust layer.

## Server-owned Quick Add service

Extract server-safe behavior behind `src/lib/quick-add/`:

1. validate the versioned request;
2. authenticate and authorize the device scope;
3. claim or replay the idempotency key;
4. parse raw text using the canonical grammar;
5. merge allowed client defaults;
6. resolve destinations and verify connector/list capability;
7. create the task and associated tags/My Day state;
8. return normalized display metadata and warnings;
9. persist the final idempotent response; and
10. emit a redacted audit/telemetry event.

Parsing and orchestration tests should reuse existing
`parse-task-input` fixtures, including escape, date, and recurrence cases. The
service needs deterministic timezone behavior: requests include an IANA
timezone, and relative dates are evaluated against the server-received time in
that zone. The response identifies the parser version used.

Preview and create must share the same parse/resolution pipeline. Preview has no
side effect and is advisory; create revalidates all inputs.

## Proposed version 1 API

All envelopes contain integer `version: 1` and UUID `requestId`. Unknown
versions fail without side effects. Create requests also use `requestId` as the
idempotency key. Undeclared fields are rejected. Breaking changes require a new
version; additive optional response fields are permitted only when older
clients can safely ignore them.

### Capabilities

```http
GET /api/desktop/v1/capabilities
Authorization: Bearer <device-credential>
```

```json
{
  "version": 1,
  "minimumClientVersion": "0.1.0",
  "parserVersion": "1",
  "features": {
    "preview": true,
    "undo": false,
    "multiTask": false,
    "myDay": true
  },
  "destinations": [
    {
      "id": "local:inbox",
      "label": "Inbox",
      "connectorType": "local",
      "requiresList": false,
      "writable": true
    }
  ]
}
```

Responses use `ETag` and support `If-None-Match`. The client may display a
cached response offline, but the server always revalidates a create.

### Preview

```http
POST /api/desktop/v1/quick-add/preview
Authorization: Bearer <device-credential>
Content-Type: application/json
```

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "text": "Send launch plan tomorrow !high #launch /Work",
  "timezone": "America/New_York",
  "defaults": {
    "destinationId": null,
    "addToMyDay": false
  }
}
```

Preview returns the normalized title, parsed fields, resolved destination when
unambiguous, parser version, and typed warnings. It does not reserve an
idempotency key.

### Create

```http
POST /api/desktop/v1/quick-add
Authorization: Bearer <device-credential>
Idempotency-Key: 8cf177a0-e46a-46fa-824c-4c34004e2423
Content-Type: application/json
```

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "text": "Send launch plan tomorrow !high #launch /Work",
  "timezone": "America/New_York",
  "defaults": {
    "destinationId": null,
    "addToMyDay": false
  },
  "client": {
    "name": "mc-desktop",
    "version": "0.1.0"
  }
}
```

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "created": [
    {
      "id": "task-id",
      "title": "Send launch plan",
      "destinationId": "ms-todo:work",
      "destinationLabel": "Work",
      "dueDate": "2026-08-02",
      "dueDateLabel": "Tomorrow",
      "priority": "high",
      "url": "https://mc.example.test/tasks/task-id"
    }
  ],
  "warnings": [],
  "parserVersion": "1",
  "replayed": false,
  "undo": null
}
```

The server binds the idempotency record to the authenticated device, endpoint,
version, and hash of the canonical request body. The same key and body return
the stored status and response with `replayed: true`. Reusing a key with a
different body returns `409 IDEMPOTENCY_CONFLICT`. In-progress duplicates
return a retryable response without starting another create.

### Errors

```json
{
  "version": 1,
  "requestId": "8cf177a0-e46a-46fa-824c-4c34004e2423",
  "ok": false,
  "error": {
    "code": "DESTINATION_REQUIRED",
    "message": "Choose a destination before adding this task.",
    "retryable": false,
    "field": "defaults.destinationId"
  }
}
```

Version 1 error codes should include `INVALID_REQUEST`, `UNAUTHORIZED`,
`SCOPE_DENIED`, `CLIENT_UPGRADE_REQUIRED`, `DESTINATION_REQUIRED`,
`DESTINATION_NOT_WRITABLE`, `PARSER_AMBIGUOUS`, `IDEMPOTENCY_CONFLICT`,
`RATE_LIMITED`, and `SERVICE_UNAVAILABLE`. Messages are safe for display and
must not contain credentials, raw provider errors, or stack traces.

## Device pairing and scoped authorization

Do not reuse `MC_API_KEY`, `MC_TRIAGE_CAPTURE_KEY`, connector credentials, or a
web session cookie in the desktop app.

Recommended pairing flow:

1. The client generates an installation UUID and PKCE verifier/challenge.
2. It requests a short-lived pairing transaction and displays the user code.
3. It opens the exact configured Mission Control HTTPS origin in the system
   browser; localhost HTTP is allowed only for development.
4. The authenticated user approves the named device and requested
   `quick-add:create`, `quick-add:preview`, `destinations:read`, and
   `device:self-revoke` scopes.
5. The client polls or completes a callback and exchanges the single-use code
   plus verifier for a device credential.
6. Windows stores the credential in Credential Manager through a maintained
   Tauri secure-storage integration. The renderer never receives it.

Pairing transactions expire within ten minutes, are single-use, are rate
limited, and bind the challenge, installation, origin, and requested scopes.
Device credentials are individually revocable, have a bounded lifetime, rotate
before expiry, and are visible in Mission Control settings with last-used time.
Logout/re-pair removes the local credential and optionally clears the outbox
only after an explicit warning.

## Offline outbox and idempotency

The Rust core accepts a capture into the outbox before attempting the network
request. A record contains:

- request UUID/idempotency key;
- versioned request body and canonical body hash;
- created time, attempt count, and next-attempt time;
- state: `pending`, `sending`, `confirmed`, or `action_required`; and
- sanitized last error code.

The queue survives process and machine restarts. Use SQLite or another
transactional store, with encryption at rest where the platform integration
supports it. Bound the queue by item count, total bytes, and maximum age; when a
limit is reached, reject new captures visibly rather than evicting old ones.

Retry retryable network, `429`, and `5xx` failures with capped exponential
backoff and jitter. Do not retry schema, scope, or destination errors until the
user edits or reauthorizes. A crash after server commit but before local
acknowledgement is safe because retry uses the same idempotency key. Confirmed
records may be retained briefly for diagnostics, then removed.

## Security, privacy, accessibility, and reliability

### Security and privacy

- Restrict HTTP to the paired origin; production requires HTTPS with normal
  certificate validation.
- Redact credentials and raw task text from production logs, crash reports, and
  telemetry. Record request ID, duration, result code, queue state, and version.
- Validate every renderer-to-Rust command, cap request size, and reject unknown
  fields and versions.
- Apply per-device and per-account rate limits server-side.
- Store no connector credentials locally.
- Make notification title display configurable for lock-screen privacy.
- Support immediate server-side device revocation and fail closed after scope or
  credential validation fails.

### Accessibility

- Provide visible focus, logical tab order, and complete keyboard operation.
- Give icon-only controls accessible names and expose status changes through a
  polite live region.
- Respect Windows text scaling, high contrast, reduced motion, and notification
  settings.
- Do not rely on token color alone; include text and icons.
- Preserve typed content when validation fails and move focus to the actionable
  field or message.

### Reliability

- Treat a capture as successful only after a server acknowledgement or as saved
  offline only after a durable local transaction.
- Prevent two client workers from sending the same record concurrently.
- Reconcile uncertain sends through idempotent replay.
- Surface stale capability data and pending/action-required counts.
- Include migration and recovery tests for the outbox schema.

## Rollout

1. **Server dark launch:** extract and test the Quick Add service; ship
   capabilities, pairing, preview, create, idempotency, audit, and revocation
   behind a feature flag.
2. **Internal Windows alpha:** sideload signed builds, validate hotkey conflicts,
   latency, outbox recovery, upgrades, and device revocation.
3. **Opt-in beta:** publish installer/update channel, add settings onboarding,
   privacy controls, and support diagnostics.
4. **General availability:** enforce minimum client version only for security or
   incompatible contracts; document support and rollback procedures.
5. **Advanced experiments:** gate edge tab, voice, clipboard, and shell
   integrations independently and promote them only with usage evidence.

## Telemetry and success criteria

Telemetry is opt-in where required and excludes task text.

| Measure | MVP target |
| --- | --- |
| Warm shortcut to focused input | p95 under 150 ms on supported Windows 11 hardware |
| Local submit feedback | under 100 ms |
| Online create acknowledgement | p95 under 1 s excluding connector write-through latency |
| Accepted capture durability | 100% confirmed or visibly retained in outbox |
| Duplicate tasks caused by retry | zero in idempotency fault-injection tests |
| Crash-free desktop sessions | at least 99.5% |
| Pairing completion | at least 90% of started, eligible flows |
| Capture loop | at least 80% completed without opening the website |

Product signals include weekly active paired devices, captures per active
device, repeat use after 7 and 28 days, keyboard versus tray invocation,
offline queue frequency and drain time, validation-error rate, destination
correction rate, and advanced-surface adoption.

## Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Desktop and web parsing drift | One server-owned service and shared contract fixtures |
| Broad credential exposure | Pairing plus revocable least-privilege device scopes |
| Duplicate or lost tasks | Durable pre-send outbox and server idempotency |
| Hotkey conflicts | Detect registration failure and require rebinding |
| Native scope expands into a desktop clone | Enforce capture-only MVP and open web for management |
| Connector errors make capture feel unreliable | Stable server error taxonomy, retry classification, and action-required queue |
| Sensitive titles appear in logs or notifications | Redaction by default and privacy-mode notifications |
| Tauri plugin or updater supply-chain risk | Pin/audit dependencies, signed artifacts, least-privilege capabilities |
| Edge tab becomes distracting | Defer and make opt-in |
| Version skew blocks old clients | Capability handshake, minimum version policy, and explicit compatibility window |

## Open decisions

1. Should MVP create directly in the selected destination or default every
   capture to a local inbox when destination resolution is ambiguous?
2. Should preview call the server on a debounce, or should the client show only
   lexical hints until submit to minimize latency and disclosure?
3. Is undo safe for all connector types, or should version 1 omit it and offer
   Open instead?
4. What queue count, byte, and age limits balance reliability and local privacy?
5. Which Windows packaging/update channel is supportable for beta and GA?
6. Should autostart be offered during onboarding or only in settings?
7. When should the web QuickAddBar switch from browser orchestration to the new
   server service?

## Delivery dependencies

The implementation should be tracked as three sequential workstreams:

1. Server Quick Add API, idempotency, pairing, scopes, and revocation.
2. Windows Tauri tray/hotkey client, dependent on the version 1 server contract.
3. Advanced capture surfaces and integrations, dependent on MVP telemetry and a
   stable client/server foundation.
