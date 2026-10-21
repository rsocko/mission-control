# Attribution persistence and Monarch tags

Mission Control's existing transaction assignment, attribution exception review,
quick review, connector assignment, and approval-gated Houston assignment now
persist decisions in Tyrion and verify their Monarch tag projection. This does
not add an all-transactions view.

## Authority and protocol

Tyrion owns normalized attribution facts, immutable transaction identity mappings,
versioned decisions, action history, and managed-tag projection state. Mission
Control keeps its existing transaction/exception projection and local audit.
Requests use the existing private Tyrion origin and finance-manager bearer
credential. Neither tokens nor financial facts belong in logs or public UI
error messages.

The aligned protocol is version `2.1`:

- `POST /api/internal/v2/attribution/records` accepts
  `{contractVersion, provenance: "mission-control-normalized-v3",
  expectedPolicyVersion, expectedStateVersion: number | null, transactionId,
  item}`. `transactionId` is the actual upstream Monarch transaction ID;
  `item.sourceRef` remains opaque. `item` is the existing normalized batch item,
  without imported tags. A null state version registers a missing record or
  reads an existing record without replacing it; numeric versions refresh facts
  with CAS while preserving Tyrion's manual decisions.
- Records return `{contractVersion, record, projection}`. The internal
  `record` contains `input`, `attribution`, `stateVersion`, `exception`, and
  `lastAction`. Internal attribution uses nested `review` and `provenance`,
  not the flattened batch DTO. Mission Control converts it into its existing
  projection only after verification.
- `POST /api/internal/v2/attribution/actions` accepts
  `{contractVersion, provenance: "mission-control-normalized-v2", sourceRef,
  expectedPolicyVersion, expectedStateVersion, idempotencyKey, confirm: true,
  action, kidId?}`. Child assignments use `assign-kid`; explicit parent/shared
  expenses use `mark-parent-expense` without a kid ID. The action response
  contains `sourceRef`, `stateVersion`, internal `attribution`, and `projection`,
  alongside Tyrion's existing action metadata.
- `POST /api/internal/v2/attribution/projection` accepts
  `{contractVersion, sourceRef, expectedStateVersion, action: "status" | "retry"}`.
  It returns the records wrapper. A projection has `sourceRef`,
  `decisionVersion`, `kidIds`, `managedTagIds`, `status`, `errorCode`, and
  `updatedAt`. Status is `pending`, `projected`, `failed`, or `drift`.
  `decisionVersion` is the string `state:` followed by the numeric state version
  padded to 16 decimal digits, for example `state:0000000000000002`.

Synthetic wire examples are executable in
`tests/helpers/tyrion-writeback-fixture.ts`; request/response validation lives in
`attribution-writeback-contract.ts`. Tyrion's
[`docs/ATTRIBUTION-PERSISTENCE.md`](https://github.com/rsocko/tyrion/blob/9d40da8d0383ee70a253aecc4063f24c1bfda28b/docs/ATTRIBUTION-PERSISTENCE.md)
is the corresponding server protocol reference, aligned with
[rsocko/tyrion#298](https://github.com/rsocko/tyrion/pull/298).

## Recovery and visible outcomes

The local CAS decision and audit commit first. An additive audit-backed outbox
defaults each manual decision to `pending`. Before dispatch, the first exact
serialized action request is durably captured, including both expected versions.
The remote idempotency identity is a bounded hash of the opaque source reference
and local key, avoiding collisions between connectors.

A timeout or 5xx leaves that request unchanged. Repeating the same review action
with its original key replays it even if Tyrion already committed. Only an
authenticated `409 attribution_state_conflict` or `409 policy_conflict`
authorizes refreshing the rejected version: Tyrion guarantees these rejections
created no receipt. Policy recovery uses the currently selected policy (or the
current Tyrion policy when following); an unchanged stale pin remains an explicit
failure until the operator updates it. A compare-and-swap replaces only the
rejected stored request. Idempotency conflicts never trigger rebasing.

Until a pending decision is reconciled, another local decision for the same
transaction is rejected. Superseded/deleted historical receipts are skipped.
Sync also processes up to 100 pending/failed audits per page, rotating by last
attempt so a failed record does not starve the backlog.

An action is not reported successful until Tyrion confirms the requested manual
decision and its current projection is `projected`. A saved decision with failed,
pending, missing, or mismatched tag projection returns an explicit mutation error
and appears as `writeback-failed` in the existing exception review. Operations
includes failed attribution write-backs in its existing write-back count. The
exception Retry action schedules the normal sync reconciliation; normal polling
also retries. Confirmed actions in quick review are not marked reviewed after a
write-back failure. Houston approval replay also reconciles before reporting
success. Quick review preserves the exact action key/payload when retrying the
same failed action and shows the server's saved-but-pending/drift message.

An action replay returns the original receipt/version but the live current
projection. If a later fact refresh advanced the version, Mission Control
create-only reads the current record, confirms its durable manual choice still
matches the local audit, and verifies the current projection token. A newer
different choice is a conflict, not permission to reproject the old decision.

Tag drift is never automatically overwritten. Resolve the mapping/catalog or
transaction-tag discrepancy in Tyrion/Monarch, then retry. Automatic definite
attributions and explicit parent expenses are persisted/projected through the
same record pipeline. Ambiguous/proposed assignments are saved for review but
do not create confirmed kid tags. Imported Monarch tags are not fed back into
attribution evidence.

## Rollout and historical catch-up

1. Back up the Mission Control database and Tyrion attribution volume. Deploy the
   matching Tyrion implementation first, with its dedicated persistent
   `tyrion-attribution` volume and the existing shared service credential.
   A stateless batch-only Tyrion installation cannot acknowledge these writes.
2. Deploy Mission Control. SQLite migration
   `0159_finance_attribution_writeback` or PostgreSQL migration
   `0037_finance_attribution_writeback` adds four nullable/defaulted audit fields
   and an index; it does not delete or replace existing decisions. Existing
   manual audits enter the bounded reconciliation backlog. Older superseded
   audit entries are retained but are not projected.
3. Run an operator-approved full finance sync to register previously confirmed
   automatic assignments and manual assignments without historical audit rows.
   This is bounded by the existing connector `backfillDays` (default 90, maximum
   365), not all historical Monarch transactions. Increase that setting up to
   the existing limit before the full sync if a wider catch-up is required.
   Transactions older than that window without an audit require a separately
   scoped historical backfill; they are not silently declared migrated.
4. Verify existing review/operations errors clear and Tyrion reports projected
   current decisions. No live financial mutation or deployment is part of the
   implementation's automated checks.

The installed Monarch client supports reading transaction-tag catalog entries,
creating tags, and replacing a transaction's tag IDs. Tyrion uses those
capabilities to ensure stable `Kid: <display name>` mappings while preserving
unrelated tags. Routine manual tag creation is not a prerequisite. Catalog name
collisions, deleted managed mappings, or detected drift require operator action;
the supported client does not provide catalog rename/update/delete operations.
Parent/shared expenses remove only managed kid tags.

## Retention and rollback

The outbox retains the serialized request and stable error code with the existing
local attribution audit; it contains opaque identities/decision identifiers,
not the service credential or full transaction facts. Tyrion retains normalized
facts, identity mappings, decisions, action history, and tag mappings on its
dedicated volume. Apply the household's existing finance backup/retention policy
to both stores. Deleting/rebuilding an MC projection does not delete Tyrion
history or undo Monarch tags; retire corresponding durable records through an
explicit operator procedure rather than deleting the Tyrion volume.

To roll back code, stop finance sync/mutations first, retain both database/volume
backups, and roll back the MC application without dropping additive columns.
Already committed Tyrion decisions and Monarch tags remain in place. Keep
pending receipts for a forward recovery; do not clear requests, fabricate
success, or delete managed tags as a migration rollback.
