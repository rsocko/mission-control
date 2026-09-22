import * as connectorLease from './sqlite-connector-operation-lease-repository';
import * as controlState from './sqlite-control-state';
import * as keywordSearch from './sqlite-fts-repository';
import * as maintenanceLock from './sqlite-maintenance-lock';
import * as operatorControl from './sqlite-operator-control';
import * as syncJobs from './sqlite-sync-job-repository';
import {
  clearConnectorOperationLeaseRepository,
  registerConnectorOperationLeaseRepository,
} from '@/lib/sync/connector-lock-runtime';
import {
  clearSyncControlStateRepository,
  registerSyncControlStateRepository,
} from '@/lib/sync/control-state';
import {
  clearSyncJobRepository,
  registerSyncJobRepository,
} from '@/lib/sync/job-runtime';
import {
  clearConnectorMaintenanceLockRepository,
  registerConnectorMaintenanceLockRepository,
} from '@/lib/sync/maintenance-lock';
import {
  clearSqliteConnectorOperationLeaseCapability,
  registerSqliteConnectorOperationLeaseCapability,
} from '@/lib/sync/sqlite-connector-operation-lease-repository';
import {
  clearSqliteSyncControlStateCapability,
  registerSqliteSyncControlStateCapability,
  sqliteSyncControlStateRepository,
} from '@/lib/sync/sqlite-control-state';
import {
  clearSqliteSyncJobCapability,
  registerSqliteSyncJobCapability,
  sqliteSyncJobRepository,
} from '@/lib/sync/sqlite-job-repository';
import {
  clearSqliteConnectorMaintenanceLockCapability,
  registerSqliteConnectorMaintenanceLockCapability,
  sqliteConnectorMaintenanceLockRepository,
} from '@/lib/sync/sqlite-maintenance-lock';
import {
  clearSqliteSyncOperatorCapability,
  clearSyncOperatorControlRepository,
  registerSqliteSyncOperatorCapability,
  registerSyncOperatorControlRepository,
  sqliteSyncOperatorControlRepository,
} from '@/lib/sync/operator-control';
import {
  clearSqliteKeywordSearchCapability,
  registerSqliteKeywordSearchCapability,
} from '@/lib/search/sqlite-fts-repository';

export function registerSqliteSyncInfrastructure(): void {
  registerSqliteConnectorOperationLeaseCapability(connectorLease);
  registerSqliteSyncControlStateCapability(controlState);
  registerSqliteSyncJobCapability(syncJobs);
  registerSqliteConnectorMaintenanceLockCapability(maintenanceLock);
  registerSqliteKeywordSearchCapability(keywordSearch);
  registerSqliteSyncOperatorCapability(operatorControl);
  registerSyncJobRepository(sqliteSyncJobRepository);
  registerConnectorOperationLeaseRepository(
    connectorLease.sqliteConnectorOperationLeaseRepository,
  );
  registerSyncControlStateRepository(sqliteSyncControlStateRepository);
  registerConnectorMaintenanceLockRepository(sqliteConnectorMaintenanceLockRepository);
  registerSyncOperatorControlRepository(sqliteSyncOperatorControlRepository);
}

export function clearSqliteSyncInfrastructure(): void {
  clearSyncOperatorControlRepository(sqliteSyncOperatorControlRepository);
  clearConnectorMaintenanceLockRepository(sqliteConnectorMaintenanceLockRepository);
  clearSyncControlStateRepository(sqliteSyncControlStateRepository);
  clearConnectorOperationLeaseRepository(
    connectorLease.sqliteConnectorOperationLeaseRepository,
  );
  clearSyncJobRepository(sqliteSyncJobRepository);
  clearSqliteSyncOperatorCapability();
  clearSqliteKeywordSearchCapability();
  clearSqliteConnectorMaintenanceLockCapability();
  clearSqliteSyncJobCapability();
  clearSqliteSyncControlStateCapability();
  clearSqliteConnectorOperationLeaseCapability();
}
