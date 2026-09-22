export class ConnectorSyncControlError extends Error {
  constructor(
    readonly code:
      | 'connector_sync_quarantined'
      | 'operator_canary_authorization_invalid',
    readonly status = 409,
  ) {
    super(code);
    this.name = 'ConnectorSyncControlError';
  }
}
