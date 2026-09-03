import type { ConnectorConfig } from '@/types';
import type { IConnector } from './index';

export interface ConnectorRuntimeRegistry {
  createConnector(config: ConnectorConfig): Promise<IConnector>;
  replaceConnector(config: ConnectorConfig): Promise<IConnector>;
  getConnector(id: string): IConnector | undefined;
  getAllConnectors(): IConnector[];
}

let selectedConnectorRegistry: ConnectorRuntimeRegistry | null = null;

export function registerConnectorRegistry(registry: ConnectorRuntimeRegistry): void {
  if (selectedConnectorRegistry && selectedConnectorRegistry !== registry) {
    throw new Error('Connector registry is already selected');
  }
  selectedConnectorRegistry = registry;
}

export function getConnectorRegistry(): ConnectorRuntimeRegistry {
  if (!selectedConnectorRegistry) {
    throw new Error('Connector registry must be registered before connectors are accessed');
  }
  return selectedConnectorRegistry;
}
