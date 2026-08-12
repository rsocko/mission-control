import { connectorRegistry } from '@/lib/connectors';
import { syncScheduler } from '@/lib/sync';
import {
  financeManagerFactory,
} from '@/lib/connectors/monarch-money';
import { defaultTyrionBridgeUrlForEnvironment } from './constants';
import type { ConnectorConfig } from '@/types';

/**
 * Default Tyrion connector configuration.
 * Polls Tyrion every 4 hours for fresh finance data.
 */
const defaultBridgeUrl = defaultTyrionBridgeUrlForEnvironment(process.env.NODE_ENV);

export const FINANCE_MANAGER_CONNECTOR_CONFIG: ConnectorConfig = {
  id: 'finance-manager-default',
  type: 'finance-manager',
  name: 'Tyrion',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 240, // 4 hours
  capabilities: {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: false,
    tags: true,
    tagWriteBack: false,
  },
  credentials: {},
  settings: defaultBridgeUrl ? { bridgeUrl: defaultBridgeUrl } : {},
  syncedLists: [],
};

/**
 * Register and schedule the Tyrion connector.
 * Call this during app startup.
 */
export async function initializeFinanceManagerConnector(): Promise<void> {
  connectorRegistry.registerFactory('finance-manager', financeManagerFactory);
  connectorRegistry.registerFactory('monarch-money', financeManagerFactory);
  connectorRegistry.registerFactory('finance', financeManagerFactory);
  await connectorRegistry.createConnector(FINANCE_MANAGER_CONNECTOR_CONFIG);
  syncScheduler.schedule(FINANCE_MANAGER_CONNECTOR_CONFIG);
}

export const MONARCH_CONNECTOR_CONFIG = FINANCE_MANAGER_CONNECTOR_CONFIG;
export const initializeMonarchConnector = initializeFinanceManagerConnector;
