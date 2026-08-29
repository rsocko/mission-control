---
title: Alertmanager webhook intake
---

# Alertmanager webhook intake

Mission Control receives standard grouped Alertmanager webhook v4 batches at:

```text
POST https://<mission-control-host>/api/integrations/alertmanager/webhook
```

Set a dedicated secret of at least 32 characters on Mission Control:

```dotenv
MC_ALERTMANAGER_WEBHOOK_TOKEN=<scoped-random-secret>
MC_ALERTMANAGER_INTEGRATION_ID=homelab
```

`MC_ALERTMANAGER_INTEGRATION_ID` defaults to `homelab`. Do not rotate it during
token rotation: it is part of the stable incident identity
`{integration}:alertmanager:{fingerprint}`.

## Alertmanager configuration

Mount a credential file into Alertmanager containing only the same raw token.
Do not include `Bearer`, quotes, or other fields in the file. Configure the
receiver with `send_resolved: true`:

```yaml
receivers:
  - name: mission-control
    webhook_configs:
      - url: https://mission-control.example/api/integrations/alertmanager/webhook
        send_resolved: true
        http_config:
          authorization:
            type: Bearer
            credentials_file: /run/secrets/mission-control-alertmanager-token
```

Alertmanager reads that file and sends:

```http
Authorization: Bearer <scoped-random-secret>
Content-Type: application/json
```

Keep ntfy in a separate Alertmanager receiver so paging does not depend on
Mission Control availability.

## Payload contract

The endpoint accepts the standard Alertmanager v4 grouped webhook object,
including `version`, `groupKey`, `status`, `receiver`, `notification_reason`,
`routeLabels`, group/common label and annotation maps, and one to 100 `alerts`.
Each alert must contain `status`, `labels`, `annotations`, `startsAt`, `endsAt`,
`generatorURL`, and a hexadecimal `fingerprint`. Alertmanager 0.34 adds
`notification_reason` and `routeLabels`; Mission Control validates their bounds
but does not persist them.

Every alert also requires:

| Field | Contract |
|---|---|
| `labels.severity` | `critical`, `warning`, or `info` |
| `labels.notification_type` | One of the stable Homelab notification types below |
| `annotations.summary` or `labels.alertname` | Non-empty incident summary |
| `labels.action_required` | Optional `true` or `false` |

Supported notification types are:

```text
homelab_service_unavailable
homelab_site_outage
homelab_backup_failed
homelab_backup_missed
homelab_storage_critical
homelab_filesystem_read_only
homelab_automation_failed
homelab_security_incident
homelab_capacity_sustained
homelab_device_intervention
homelab_maintenance_digest
```

The request body is limited to 256 KiB. A batch can contain at most 100 alerts;
label maps at most 32 entries; annotation maps at most 24 entries. Label names
are limited to 64 characters, label values to 256 characters, and annotation
values to 2,048 characters. Unknown labels and annotations are accepted within
those map bounds but discarded before persistence.

Mission Control accepts only these label inputs for normalization:

```text
alertname
severity
notification_type
category
service
job
instance
node
site
environment
owner
action_required
runbook_key
```

The inputs are not copied verbatim. `alertname` is the summary fallback, `job`
is the service fallback, and `instance` is the node fallback. The projection
stores the normalized summary, severity, type, category, service, node, site,
environment, owner, action-required flag, and runbook key.

Mission Control accepts only these annotation inputs for normalization:

```text
summary
description
dashboard_url
logs_url
uptime_url
runbook_url
metric_1_label / metric_1_value / metric_1_tone
metric_2_label / metric_2_value / metric_2_tone
metric_3_label / metric_3_value / metric_3_tone
metric_4_label / metric_4_value / metric_4_tone
```

These are normalized into summary, description, up to four metric snapshots,
and up to four typed links rather than copied as an annotation map. Metric tones
are `neutral`, `info`, `warning`, `danger`, or `success`. Link annotations must
be HTTP(S), at most 2,048 characters, and contain no embedded credentials or
fragment. Only dashboard, logs, uptime, and runbook links are retained. Raw logs,
arbitrary Prometheus labels, credentials, and time-series data are never
retained.

## Responses and retry behavior

| Condition | Status | Response |
|---|---:|---|
| Batch committed | `200` | `{ "success": true, "accepted": n, "applied": n, "stale": n, "created": n, "updated": n, "duplicateReceipts": n }` |
| Missing or invalid bearer token | `401` | `{ "error": "Unauthorized" }` |
| Invalid JSON | `400` | `{ "error": "Invalid JSON payload" }` |
| Malformed batch or member | `422` | `{ "error": "Invalid Alertmanager webhook batch", "maxAlerts": 100, "issues": [...] }` |
| Wrong content type | `415` | `{ "error": "Content-Type must be application/json" }` |
| Body over 256 KiB | `413` | `{ "error": "Alertmanager payload is too large", "maxBytes": 262144 }` |
| Rate limited | `429` | Includes `Retry-After` |
| Missing/weak server token | `503` | Includes `Retry-After: 30` |
| Storage failure | `503` | `{ "error": "Alertmanager batch could not be persisted" }`, with `Retry-After: 5` |

Validation failures reject the complete batch before any write. Receipts,
incident projections, and push outbox records commit in one immediate database
transaction. Alertmanager may safely retry 5xx responses: delivery receipts are
idempotent and projections are unique by integration, source, and fingerprint.
Resolved source state cannot be regressed by an older firing delivery.
