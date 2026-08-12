export const DEFAULT_TYRION_BRIDGE_URL = 'http://localhost:8100';
export const DEFAULT_TYRION_PRODUCTION_BRIDGE_URL = 'https://tyrion.example/api/connector/v1';
export const MONARCH_BRIDGE_CONTRACT_VERSION = 'bridge-v1';
export const MONARCH_TRANSACTION_MAX_BACKFILL_DAYS = 365;

export function defaultTyrionBridgeUrlForEnvironment(
  nodeEnvironment: string | undefined,
): string {
  return nodeEnvironment === 'production'
    ? DEFAULT_TYRION_PRODUCTION_BRIDGE_URL
    : DEFAULT_TYRION_BRIDGE_URL;
}
