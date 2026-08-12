import 'server-only';

import { sqlite } from '@/db';
import { FINANCE_PROVIDER_ALIASES } from '@/lib/finance-insights/provider';
import { NOTIFICATION_NEEDS_ATTENTION_SQL } from '@/lib/notifications/lifecycle-sql';
import { resolveFinanceExternalLinks } from './external-links';

type ConnectorRow = {
  id: string;
  name: string;
};

type CountRow = {
  count: number;
};

type AlertRow = {
  title: string;
  body: string | null;
  level: string;
  receivedAt: string;
};

type SubjectRow = {
  kidId: string;
  name: string | null;
};

function financeConnectors(): ConnectorRow[] {
  return sqlite.prepare(`
    SELECT id, name
    FROM connector_configs
    WHERE type IN (${FINANCE_PROVIDER_ALIASES.map(() => '?').join(', ')})
      AND enabled = 1 AND deleted_at IS NULL
    ORDER BY created_at, id
  `).all(...FINANCE_PROVIDER_ALIASES) as ConnectorRow[];
}

function count(query: string, ...params: Array<string | number | null>): number {
  return (sqlite.prepare(query).get(...params) as CountRow | undefined)?.count ?? 0;
}

export function getFinanceOperationsOverview(requestedConnectorId?: string | null) {
  const connectors = financeConnectors();
  if (connectors.length === 0) {
    return null;
  }

  const selected = requestedConnectorId
    ? connectors.find((connector) => connector.id === requestedConnectorId)
    : connectors[0];
  if (!selected) {
    throw new Error('Finance connector was not found');
  }

  const pendingExceptions = count(`
    SELECT count(*) AS count
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND status = 'open'
  `, selected.id);
  const retryRequested = count(`
    SELECT count(*) AS count
    FROM finance_attribution_exceptions
    WHERE connector_id = ? AND status = 'retry_requested'
  `, selected.id);
  const failedWritebacks = count(`
    SELECT count(*) AS count
    FROM finance_mutation_audit
    WHERE connector_id = ? AND status = 'failed'
  `, selected.id);
  const openAlerts = count(`
    SELECT count(*) AS count
    FROM notifications
    WHERE connector_instance_id = ? AND category = 'finance'
      AND ${NOTIFICATION_NEEDS_ATTENTION_SQL}
      AND level IN ('urgent', 'action_needed', 'heads_up')
  `, selected.id, new Date().toISOString());

  const alerts = sqlite.prepare(`
    SELECT title, body, level, received_at AS receivedAt
    FROM notifications
    WHERE connector_instance_id = ? AND category = 'finance'
      AND ${NOTIFICATION_NEEDS_ATTENTION_SQL}
      AND level IN ('urgent', 'action_needed', 'heads_up')
    ORDER BY level_rank, sort_at DESC
    LIMIT 5
  `).all(selected.id, new Date().toISOString()) as AlertRow[];

  const subjects = sqlite.prepare(`
    SELECT subjects.kid_id AS kidId, profiles.name
    FROM finance_attribution_subjects subjects
    INNER JOIN finance_sync_state state
      ON state.connector_id = subjects.connector_id
      AND state.attribution_policy_version = subjects.policy_version
    LEFT JOIN kid_profiles profiles ON profiles.id = subjects.kid_id
    WHERE subjects.connector_id = ?
    ORDER BY COALESCE(profiles.name, subjects.kid_id)
  `).all(selected.id) as SubjectRow[];

  const attentionCount = pendingExceptions + retryRequested + failedWritebacks + openAlerts;
  return {
    connectors,
    connector: selected,
    attention: {
      total: attentionCount,
      pendingExceptions,
      retryRequested,
      failedWritebacks,
      openAlerts,
    },
    alerts: alerts.map((alert) => ({
      title: alert.title,
      summary: alert.body,
      level: alert.level,
      receivedAt: alert.receivedAt,
    })),
    subjects: subjects.map((subject) => ({
      kidId: subject.kidId,
      name: subject.name || 'Household member',
      policyStatus: 'current' as const,
      limitStatus: 'unavailable' as const,
    })),
    digest: [
      pendingExceptions > 0
        ? `${pendingExceptions} attribution ${pendingExceptions === 1 ? 'exception needs' : 'exceptions need'} review`
        : 'No attribution exceptions need review',
      failedWritebacks > 0
        ? `${failedWritebacks} Monarch ${failedWritebacks === 1 ? 'write-back has' : 'write-backs have'} failed`
        : 'No failed Monarch write-backs',
      openAlerts > 0
        ? `${openAlerts} finance ${openAlerts === 1 ? 'alert is' : 'alerts are'} open`
        : 'No open finance alerts',
    ],
    links: resolveFinanceExternalLinks(),
  };
}
