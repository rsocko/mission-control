export type NotificationWritebackAction =
  | 'mark_read'
  | 'mark_done'
  | 'mute'
  | 'unmute';

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
