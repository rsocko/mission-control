export interface StoredHealthSnapshot<TSummary> {
  schemaVersion: number;
  generatedAt: string;
  worker: {
    instanceId: string;
    revision: string;
  };
  generationDurationMs: number;
  summary: TSummary;
}

export interface HealthSnapshotStore<TSummary> {
  write(
    snapshot: StoredHealthSnapshot<TSummary>,
    validate?: () => void,
  ): Promise<void>;
  read(): Promise<StoredHealthSnapshot<TSummary> | null>;
}
