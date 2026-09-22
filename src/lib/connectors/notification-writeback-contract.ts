export type NotificationWritebackAction =
  | 'mark_read'
  | 'mark_done'
  | 'mute'
  | 'unmute';

const NOTIFICATION_DISMISSAL_WRITEBACK_CONNECTORS = new Set([
  'document-intelligence',
  'github-issues',
]);

export function supportsNotificationDismissalWriteback(connectorType: string): boolean {
  return NOTIFICATION_DISMISSAL_WRITEBACK_CONNECTORS.has(connectorType);
}

export class ConnectorWritebackError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAt?: Date,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ConnectorWritebackError';
  }
}
