import type { MonarchBridgeError } from './client';

export function describeTyrionConnectionError(
  error: Pick<MonarchBridgeError, 'code'>,
): string {
  switch (error.code) {
    case 'missing_server_credential':
      return 'Tyrion service token is not configured. Enter it in connector setup or set FINANCE_MANAGER_API_TOKEN on the server.';
    case 'invalid_bridge_url':
      return 'Tyrion Bridge API URL is invalid. Edit the connector and enter its protected Bridge v1 base URL.';
    case 'invalid_contract':
    case 'unsupported_contract':
      return 'The configured Tyrion service does not expose the Monarch Bridge v1 API.';
    case 'bridge_unavailable':
      return 'The configured Tyrion bridge is unavailable.';
    case 'upstream_timeout':
      return 'Tyrion bridge timed out.';
    default:
      return `Tyrion connection failed (${error.code})`;
  }
}
