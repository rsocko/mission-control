import type Database from 'better-sqlite3';
import { normalizeNotificationUrl } from '@/lib/notifications/providers/registry';

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    let parsed: unknown = JSON.parse(value);
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function _repairInboundWebhookNotificationActions(
  sqlite: Database.Database,
): void {
  const actions = sqlite.prepare(`
    SELECT
      notification_actions.id,
      notification_actions.notification_id AS notificationId,
      notification_actions.payload,
      notification_actions.is_primary AS isPrimary,
      notification_actions.sort_order AS sortOrder
    FROM notification_actions
    INNER JOIN notifications
      ON notifications.id = notification_actions.notification_id
    WHERE notifications.connector_type = 'inbound-webhook'
      AND notification_actions.action_type = 'open_url'
    ORDER BY
      notification_actions.notification_id,
      notification_actions.is_primary DESC,
      notification_actions.sort_order,
      notification_actions.id
  `).all() as Array<{
    id: string;
    notificationId: string;
    payload: string;
    isPrimary: number;
    sortOrder: number;
  }>;

  const repair = sqlite.transaction(() => {
    sqlite.prepare(`
      UPDATE notifications
      SET is_actionable = 0, primary_action_id = NULL
      WHERE connector_type = 'inbound-webhook'
    `).run();
    sqlite.prepare(`
      UPDATE notification_actions
      SET is_primary = 0
      WHERE action_type = 'open_url'
        AND notification_id IN (
          SELECT id FROM notifications WHERE connector_type = 'inbound-webhook'
        )
    `).run();

    const updateAction = sqlite.prepare(`
      UPDATE notification_actions
      SET payload = ?, opens_external = 1, is_primary = ?, sort_order = 0, created_by = 'connector'
      WHERE id = ?
    `);
    const updateNotification = sqlite.prepare(`
      UPDATE notifications
      SET is_actionable = 1, primary_action_id = ?
      WHERE id = ?
    `);
    const deleteAction = sqlite.prepare('DELETE FROM notification_actions WHERE id = ?');
    const linkedNotifications = new Set<string>();

    for (const action of actions) {
      const payload = parseJsonRecord(action.payload);
      const url = normalizeNotificationUrl(payload?.url);
      if (!url) {
        deleteAction.run(action.id);
        continue;
      }

      const isPrimary = !linkedNotifications.has(action.notificationId);
      updateAction.run(JSON.stringify({ ...payload, url }), isPrimary ? 1 : 0, action.id);
      if (isPrimary) {
        updateNotification.run(action.id, action.notificationId);
        linkedNotifications.add(action.notificationId);
      }
    }
  });
  repair();
}
