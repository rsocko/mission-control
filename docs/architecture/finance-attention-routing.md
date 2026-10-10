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
| Duplicate candidates | The generic evaluator covers notification-to-task promotion and action authorization. Duplicate production and connector-health transport belong to rsocko/tyrion#162. |
| Reconciliation | The generic evaluator covers early, due-soon, overdue/mismatch, settlement, and due-date My Day rules. No reconciliation envelope producer is currently connected. |
| Connector health | The generic evaluator covers suppression, 15-minute degradation, 4-hour promotion, authentication precedence, and freshness. Transport belongs to rsocko/tyrion#162. |
| Weekly summary | The generic evaluator keeps the row informational and non-task. Summary/job-family production belongs to rsocko/tyrion#17. |

Producer-only gaps must be closed by supplying the version `1.0` envelope through a
durable ingestion boundary. Mission Control must not infer missing finance facts from
notification copy, connector process uptime, absent partial-sync rows, or raw URLs.
The two currently persisted producers are intentionally the only sources scanned by
the reconciliation adapters.
