# Payee document review boundary

Mission Control owns the daily user-facing review route at
`/finance/payee-documents`. Tyrion remains the authority for read-only financial
pattern evidence. OWL remains the authority for Paperless correspondent mapping
and document expectation policy. The route deliberately does not expose a
transaction ledger and does not infer document expectations from financial
recurrence.

The browser uses `PayeeDocumentReviewClient` from
`src/lib/payee-document-review/client.ts`. The same-origin Finance API delegates
to `PayeeDocumentReviewAdapter` in
`src/lib/payee-document-review/server-adapter.ts`. Until the sibling integration
is wired, the production adapter returns an explicit `unavailable` snapshot and
rejects mutations. UI tests inject deterministic clients through this boundary;
runtime code contains no sample household data.

## Source contracts

The adapter must normalize both sources into the Mission Control contract in
`src/lib/payee-document-review/contract.ts`.

Tyrion's settled `PayeePatternProjectionV1` is read-only and separate from
document expectation signals:

- Internal read:
  `GET /api/internal/v1/finance/insights/payee-patterns/{generationId}?connectorRef={connectorRef}`
- Connector replay:
  `GET /api/connector/v1/payee-patterns/{sourceGeneration}?connectorRef={connectorRef}`
- Envelope:
  `{ contractVersion: "1", connectorRef, sourceGeneration, sourceAsOf, completeness, payees[] }`
- Payee evidence includes opaque `payeeRef`, display name, activity,
  classification, observation count/window, optional interval evidence,
  confidence, basis, transaction/Monarch-recurring provenance, and optional
  confirmed Monarch recurrence.

Mission Control does not mutate Tyrion through this flow. It displays only
bounded aggregate evidence: classification, confidence, observation count and
window, and interval summary.

OWL's settled Mission Control contract requires the server-only
`OWL_MISSION_CONTROL_API_TOKEN` bearer:

- `GET /api/mc/v1/payee-document-reviews?status=all&limit=100&offset=0`
- `GET /api/mc/v1/correspondents?limit=100&offset=0`
- `PUT /api/mc/v1/payee-document-reviews/{candidate_id}/mapping`
- `POST /api/mc/v1/payee-document-reviews/{candidate_id}/no-documents-expected`

Detailed policy remains specialist-only. Mission Control uses the review
record's `owl_deep_link`; it does not call OWL's history endpoint.

The deployed adapter requires:

- `TYRION_PAYEE_PATTERN_API_URL`: the complete internal or replay resource URL,
  including the generation path segment and `connectorRef` query value;
- `TYRION_PAYEE_PATTERN_API_TOKEN`: the server-only Tyrion bearer;
- `OWL_MISSION_CONTROL_URL`: the OWL service origin/base path; and
- `OWL_MISSION_CONTROL_API_TOKEN`: the server-only OWL bearer.

The current join assumption is explicit and isolated in `server-adapter.ts`:
OWL review `id` is the same opaque identity as Tyrion `payeeRef`. Names and
`display_hint` are never used as identity. The bounded UI maps one whole-payee
candidate by sending `account_candidate_id: null`; account-specific mapping
remains an OWL specialist workflow. Mapping preserves OWL `expectation_ids` and
notes, while `no_documents_expected` preserves current mappings and notes.
OWL collection reads follow 100-item offset pages up to a 5,000-item safety
limit.

## Authorization and states

The API uses the existing trusted Finance read/mutation guards. The review
surface explicitly handles loading, unavailable, empty, forbidden/error, ready,
and mutation-failure states. Mapping and no-document decisions write only
through OWL after its adapter is available. A local success must never be shown
before OWL acknowledges the mutation. The acknowledged OWL response is the
commit point; Mission Control does not make that success depend on a subsequent
Tyrion or collection refresh.
