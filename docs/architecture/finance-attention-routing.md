# Finance attention routing

Mission Control implements the normative Tyrion finance attention contract as a
strict, versioned envelope evaluator in `src/lib/finance/attention-policy.ts`.
The evaluator owns matrix selection, inclusive escalation clocks, freshness refusal,
logical/activity/transition dedupe keys, cross-kind precedence, My Day eligibility,
and capability-to-target authorization. Unknown fields and invalid combinations are
rejected; producers provide typed descriptors rather than URLs.

## Runtime coverage

| Matrix area | Mission Control coverage |
| --- | --- |
| Attribution review required | Produced from persisted attribution exceptions and reconciled transactionally into one notification or task. Source resolution and supersession settle the projection. |
| Write-back failed | Produced from exhausted mutation audits and reconciled transactionally into one task with source-authoritative settlement. |
| Finance insights | Existing insight publication remains notification-only. Large transaction, recurring increase, variance mover, and monthly digest policy rows are deterministic and cannot become tasks or My Day candidates. |
| Thresholds | The generic evaluator covers approaching, exceeded, 24-hour promotion, freshness, and My Day rules. Tyrion does not yet publish the routing envelope to this service. |
| Duplicate candidates | Tyrion's protected `create`/`update`/`settle` delivery snapshots are consumed through the generic evaluator, including notification-to-task promotion and action authorization. |
| Reconciliation | The generic evaluator covers early, due-soon, overdue/mismatch, settlement, and due-date My Day rules. OWL receipt reconciliation feeds bounded unmatched/review/durable signals through the same backend-neutral transaction; only durable work or exhausted repair becomes a task. |
| Connector health | Tyrion's protected delivery snapshots drive suppression, 15-minute degradation, 4-hour promotion, authentication precedence, freshness, and authoritative recovery settlement. |
| Weekly summary | The generic evaluator keeps the row informational and non-task. Summary/job-family production belongs to rsocko/tyrion#17. |

Tyrion automation deliveries cross a durable ingestion boundary keyed by
`deliveryKey` and exact positive `version`. Mission Control commits the receipt and
the notification/task/My Day projection in one local transaction, then acknowledges
that exact version. A crash before acknowledgement therefore replays as a no-op and
can be acknowledged safely. Older snapshots cannot overwrite newer receipts, and an
immutable-version payload mismatch fails closed.

Settlement is source-authoritative. Verified remediation completes the task;
supersession or a condition that is merely no longer applicable cancels it. A user
completion received before source settlement remains complete with
`verificationPending` metadata until a newer authoritative delivery settles it.
Notification and task projections remain mutually exclusive, with one stable primary
record per logical signal.

Operational logs expose only bounded counts for received, newly applied, replayed,
out-of-order, and acknowledged deliveries. They do not include delivery keys, signal
snapshots, source references, amounts, merchant data, or upstream errors. Mission
Control must not infer missing finance facts from notification copy, connector process
uptime, absent partial-sync rows, or raw URLs.
