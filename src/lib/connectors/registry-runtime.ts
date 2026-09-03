import type { ConnectorConfig } from '@/types';
import type { ConnectorNotificationTypeDefinition } from '@/lib/notifications/push-policy/catalog';
import { validateNotificationTypeCatalog } from '@/lib/notifications/push-policy/catalog';
import type { IConnector } from './index';
import {
  assertPersistenceCompositionAccessAllowed,
  assertPersistenceCompositionPublicationAllowed,
} from '@/lib/persistence/composition-lifecycle';

export interface ConnectorRuntimeRegistry {
  createConnector(config: ConnectorConfig): Promise<IConnector>;
  replaceConnector(config: ConnectorConfig): Promise<IConnector>;
  getConnector(id: string): IConnector | undefined;
  getAllConnectors(): IConnector[];
}

export interface ConnectorFactory {
  create(): IConnector;
  readonly notificationTypes?: readonly ConnectorNotificationTypeDefinition[];
  getNotificationTypes?(config: ConnectorConfig): readonly ConnectorNotificationTypeDefinition[];
}

export class ConnectorRegistry implements ConnectorRuntimeRegistry {
  private connectors = new Map<string, IConnector>();
  private factories = new Map<string, ConnectorFactory>();

  registerFactory(type: string, factory: ConnectorFactory): void {
    if (!type.trim()) throw new Error('Connector factory type is required');
    if (factory.notificationTypes) {
      validateNotificationTypeCatalog(type, factory.notificationTypes);
    }
    this.factories.set(type, factory);
  }

  getNotificationTypeCatalog(
    type: string,
    config?: ConnectorConfig,
  ): readonly ConnectorNotificationTypeDefinition[] {
    const factory = this.factories.get(type);
    if (!factory) return Object.freeze([]);
    const catalog = config && factory.getNotificationTypes
      ? factory.getNotificationTypes(config)
      : factory.notificationTypes ?? [];
    return validateNotificationTypeCatalog(type, catalog);
  }

  async createConnector(config: ConnectorConfig): Promise<IConnector> {
    const factory = this.factories.get(config.type);
    if (!factory) {
      throw new Error(`No factory registered for connector type: ${config.type}`);
    }
    this.getNotificationTypeCatalog(config.type, config);
    const connector = factory.create();
    await connector.initialize(config);
    this.connectors.set(config.id, connector);
    return connector;
  }

  async replaceConnector(config: ConnectorConfig): Promise<IConnector> {
    // Existing operations may still hold the old instance; replacing only the
    // map reference lets them finish while new work uses the refreshed one.
    return this.createConnector(config);
  }

  getConnector(id: string): IConnector | undefined {
    return this.connectors.get(id);
  }

  getAllConnectors(): IConnector[] {
    return Array.from(this.connectors.values());
  }

  async removeConnector(id: string): Promise<void> {
    const connector = this.connectors.get(id);
    if (connector) {
      await connector.dispose();
      this.connectors.delete(id);
    }
  }
}

export const connectorRegistry = new ConnectorRegistry();
let selectedConnectorRegistry: ConnectorRuntimeRegistry | null = null;

export function registerConnectorRuntimeRegistry(): void {
  registerConnectorRegistry(connectorRegistry);
}

export function assertCanRegisterConnectorRuntimeRegistry(): void {
  assertCanRegisterConnectorRegistry(connectorRegistry);
}

export function registerConnectorRegistry(registry: ConnectorRuntimeRegistry): void {
  assertCanRegisterConnectorRegistry(registry);
  selectedConnectorRegistry = registry;
}

export function assertCanRegisterConnectorRegistry(
  registry: ConnectorRuntimeRegistry,
): void {
  assertPersistenceCompositionPublicationAllowed();
  if (selectedConnectorRegistry && selectedConnectorRegistry !== registry) {
    throw new Error('Connector registry is already selected');
  }
}

export function getConnectorRegistry(): ConnectorRuntimeRegistry {
  assertPersistenceCompositionAccessAllowed();
  if (!selectedConnectorRegistry) {
    throw new Error('Connector registry must be registered before connectors are accessed');
  }
  return selectedConnectorRegistry;
}
