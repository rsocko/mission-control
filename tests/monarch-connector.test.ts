/**
 * Smoke tests for the Finance Manager connector and API routes.
 *
 * Run with: npx tsx tests/monarch-connector.test.ts
 */

import { FinanceManagerConnector } from '../src/lib/connectors/monarch-money';
import type { ConnectorConfig } from '../src/types';

const CONNECTOR_CONFIG: ConnectorConfig = {
  id: 'test-monarch',
  type: 'finance-manager',
  name: 'Test Finance Manager',
  enabled: true,
  syncMode: 'poll',
  pollIntervalMinutes: 240,
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
  settings: {},
  syncedLists: [],
};

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

async function testConnectorMetadata() {
  console.log('\n🧪 Connector Metadata');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  assert(connector.type === 'finance-manager', 'type is finance-manager');
  assert(connector.displayName === 'Finance Manager', 'displayName is Finance Manager');
  assert(connector.icon === '💰', 'icon is 💰');
  assert(connector.id === 'test-monarch', 'id is set from config');
}

async function testCapabilities() {
  console.log('\n🧪 Capabilities');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  assert(connector.capabilities.read === true, 'can read');
  assert(connector.capabilities.write === true, 'can write');
  assert(connector.capabilities.delete === false, 'cannot delete');
  assert(connector.capabilities.sync === true, 'can sync');
  assert(connector.capabilities.subtasks === false, 'no subtasks');
  assert(connector.capabilities.lists === false, 'no lists');
  assert(connector.capabilities.tags === true, 'has tags');
  assert(connector.capabilities.tagWriteBack === false, 'no tag write-back');
}

async function testFetchTasksReturnsEmpty() {
  console.log('\n🧪 fetchTasks returns empty (finance connector)');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  const tasks = (await Array.fromAsync(connector.fetchTasks())).flat();
  assert(Array.isArray(tasks), 'returns array');
  assert(tasks.length === 0, 'returns empty array');
}

async function testFetchNotificationsReturnsEmpty() {
  console.log('\n🧪 fetchNotifications returns empty');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  const notifications = await connector.fetchNotifications();
  assert(Array.isArray(notifications), 'returns array');
  assert(notifications.length === 0, 'returns empty array');
}

async function testFetchSourceListsReturnsEmpty() {
  console.log('\n🧪 fetchSourceLists returns empty');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  const lists = await connector.fetchSourceLists();
  assert(Array.isArray(lists), 'returns array');
  assert(lists.length === 0, 'returns empty array');
}

async function testGetLastSyncTokenReturnsNull() {
  console.log('\n🧪 getLastSyncToken returns null');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  const token = await connector.getLastSyncToken();
  assert(token === null, 'returns null');
}

async function testConnectionFailsGracefully() {
  console.log('\n🧪 testConnection fails gracefully when Finance Manager is unreachable');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  // This will fail since no bridge is running, but should not throw
  const result = await connector.testConnection();
  assert(result.success === false, 'reports failure');
  assert(typeof result.message === 'string', 'provides error message');
  assert(result.message.length > 0, 'message is non-empty');
}

async function testSyncFailsGracefully() {
  console.log('\n🧪 sync fails gracefully when Finance Manager is unreachable');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);

  const result = await connector.sync();
  assert(result.success === false, 'reports failure');
  assert(result.errors.length > 0, 'has error messages');
  assert(result.connectorId === 'test-monarch', 'correct connector ID');
}

async function testDispose() {
  console.log('\n🧪 dispose works');
  const connector = new FinanceManagerConnector();
  await connector.initialize(CONNECTOR_CONFIG);
  await connector.dispose();
  // Should not throw
  assert(true, 'dispose completed without error');
}

async function main() {
  console.log('═══════════════════════════════════════════');
  console.log(' Finance Manager Connector — Smoke Tests');
  console.log('═══════════════════════════════════════════');

  await testConnectorMetadata();
  await testCapabilities();
  await testFetchTasksReturnsEmpty();
  await testFetchNotificationsReturnsEmpty();
  await testFetchSourceListsReturnsEmpty();
  await testGetLastSyncTokenReturnsNull();
  await testConnectionFailsGracefully();
  await testSyncFailsGracefully();
  await testDispose();

  console.log('\n───────────────────────────────────────────');
  console.log(` Results: ${passed} passed, ${failed} failed`);
  console.log('───────────────────────────────────────────\n');

  if (failed > 0) process.exit(1);
}

main().catch(err => {
  console.error('Test runner error:', err);
  process.exit(1);
});
