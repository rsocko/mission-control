# Receipt reconciliation review boundary

Mission Control presents receipt exceptions as a filter on the existing
`/finance/review` route. It does not add a receipt inbox, navigation item,
receipt table, evidence table, or relationship table. OWL is the sole
authority for payment evidence, obligation relationships, revisions,
correction history, attention state, and settlement.

## Contract and transport

The browser calls only the trusted same-origin Finance API. The server-only
adapter in `src/lib/receipt-reconciliation/server-adapter.ts` consumes OWL's
strict Mission Control contract:

- `GET /api/mc/v1/payment-reconciliation-reviews?active_only=true&limit=100&offset=0`
- `GET /api/mc/v1/payment-reconciliation-reviews/{case_id}`
- `POST /api/mc/v1/payment-reconciliation-reviews/{case_id}/actions`

Every mutation sends OWL's current `expected_revision` and a durable
body-level `idempotency_key`. Mission Control retains that key for retryable
failures, validates OWL's action response, and performs a separate no-cache
detail read before showing success. Revision conflicts replace the local
snapshot with OWL's current bounded item.

`OWL_MISSION_CONTROL_URL` must be HTTPS except for loopback development and
`OWL_MISSION_CONTROL_API_TOKEN` is server-only. OWL deep links must be hash-only
paths; Mission Control resolves them against the configured OWL origin and
rejects arbitrary owner URLs.

## Evidence and privacy

The UI separates OWL/Paperless document evidence, Tyrion/Monarch payment
evidence, and the Mission Control decision. This separation is presentation,
not a local join: the exact OWL contract exposes at most one privacy-scoped
evidence summary per case. Mission Control does not infer replacement
candidates or fabricate a Monarch transaction target.

The boundary rejects unknown fields and does not accept or persist canonical
document, receipt, transaction, or account references; OCR; filenames; email
content; line items; signed URLs; bytes; credentials; or upstream payloads.
Only OWL review IDs, revisions, bounded summaries, reason codes, source state,
and finance-attention projection metadata cross the boundary.

## Attention projection

Receipt cases reuse the existing backend-neutral finance attention transaction,
notification delivery, local task, and My Day machinery for SQLite and
PostgreSQL:

- unmatched after OWL's grace period creates one informational notification;
- ambiguity, conflict, and stale evidence create review notifications;
- partial/double payment and explicitly exhausted repair create tasks eligible
  for My Day under existing caps;
- normal, verified, not-applicable, and non-exhausted repair states remain
  suppressed or status-only.

After local projection commits, Mission Control sends OWL
`deliver_attention` with the local stable attention source ID. Local snooze,
dismissal, or task completion never calls payment settlement or rewrites OWL
evidence. Resolved OWL cases settle existing projections when returned by the
bounded `active_only=false` attention read.
