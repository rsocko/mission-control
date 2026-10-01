---
title: "Paperclip"
status: active
last_reviewed: 2026-10-01
---

# Paperclip

Mission Control can register Paperclip as an external-agent provider and mirror
its approval queue into Mission Control notifications. Paperclip remains
authoritative for company membership, issues, runs, approval policy, and
approval decisions.

## Approval notifications

Each enabled Paperclip provider polls only its configured company. A pending
approval is projected once using the stable identity
`paperclip:approval:{externalAgentId}:{approvalId}`. The notification includes:

- Paperclip company and requesting agent;
- approval type, minimized summary, and normalized risk;
- correlated Mission Control dispatch/task when a linked Paperclip issue
  matches a dispatch;
- Paperclip issue/run identifiers;
- creation and optional expiry time; and
- an HTTPS deep link to the Paperclip approval page.

The deep link contains no provider credential. The first release intentionally
does not expose approve or reject actions in Mission Control. Opening the link
marks the local notification read, but only a later authoritative Paperclip
read can resolve it.

Polling runs at startup and every five minutes. Set
`MC_PAPERCLIP_APPROVAL_POLL_MS` to an integer of at least 30000 to adjust the
interval. Runs retain the full pending identity set, prioritize approvals not
yet mirrored, and bound detail reads by the provider's configured request-rate
policy (with an absolute maximum of 50 approvals per run). Deferred approvals
are therefore processed on later runs and are not mistaken for stale ones.
Notification correlation is persisted in existing notification identity and
metadata fields; no approval-specific database migration is required, and the
same repository path is used for SQLite and PostgreSQL.

## Lifecycle and failure behavior

`pending` is actionable. `approved`, `rejected`, `revision_requested`,
`cancelled`, `expired`, and `withdrawn` close the notification only after a
per-approval Paperclip read confirms the state. The pinned Paperclip contract
uses `cancelled`; Mission Control presents that state as withdrawn. A `404`
after a successful company poll closes the notification as
`inaccessible_or_deleted`. Company authorization failures, rate limits,
timeouts, malformed responses, and provider outages leave existing
notifications active and emit structured reconciliation logs.

Reconciliation is available through the existing trusted
`POST /api/external-agents/reconcile` route as well as the scheduler. The
projection boundary accepts authoritative provider records, so a later
Paperclip event or plugin bridge can invoke the same reconciliation behavior
without introducing decision authority in Mission Control.

## Pinned Paperclip API assumptions

The provider contract remains pinned to `paperclipai/paperclip` commit
`0d3e7bf6ac69c6a41995e62e7a38ca99dcbc8dfd` and uses:

- `GET /api/companies/{companyId}`;
- `GET /api/companies/{companyId}/approvals?status=pending`;
- `GET /api/approvals/{approvalId}`;
- `GET /api/approvals/{approvalId}/issues`; and
- `GET /api/agents/{agentId}`.

At that commit an approval has `id`, `companyId`, `type`,
`requestedByAgentId`, `requestedByUserId`, `status`, redacted `payload`,
decision fields, and creation/update timestamps. Native statuses are
`pending`, `revision_requested`, `approved`, `rejected`, and `cancelled`.
Expiry, risk, summary, and run correlation are not first-class fields in the
pinned schema; Mission Control reads only allowlisted optional values from the
redacted payload and otherwise displays explicit `unspecified` or omitted
values. Future `expired` and `withdrawn` statuses are accepted as terminal for
forward compatibility.
