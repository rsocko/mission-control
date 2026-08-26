import type { PersistenceJson } from '@/db/persistence/contracts';

export type DatabaseHealthSeverity =
  | 'healthy'
  | 'degraded'
  | 'critical'
  | 'error';

export interface DatabaseHealthProbeResult {
  connected: boolean;
  severity: DatabaseHealthSeverity;
  message: string;
  sizeBytes?: number;
  backend: {
    kind: string;
    details?: Record<string, PersistenceJson>;
  };
}

export interface DatabaseHealthProbe {
  inspect(): Promise<DatabaseHealthProbeResult>;
  hasSeedMarker(): Promise<boolean>;
}
