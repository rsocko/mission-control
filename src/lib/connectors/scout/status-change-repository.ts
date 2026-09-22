export const SCOUT_WRITE_BACK_CURSOR_KEY = 'scout_write_back_synced_at';

export interface ScoutStatusChangeRecord {
  readonly mcTaskId: string;
  readonly sourceId: string;
  readonly sourceType: string;
  readonly title: string;
  readonly status: string;
  readonly statusReason: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly snoozedUntil: string | null;
}

export interface ScoutStatusChangePage {
  readonly changes: ScoutStatusChangeRecord[];
  readonly hasMore: boolean;
}

export interface ListScoutStatusChangesInput {
  readonly since: string | null;
  readonly through: string;
  readonly sourceTypes: readonly string[] | null;
  readonly limit: number;
}

export interface AcknowledgeScoutStatusChangesInput {
  readonly acknowledgedAt: string;
  readonly updatedAt: string;
}

export interface ScoutStatusChangeAcknowledgement {
  readonly cursor: string;
  readonly updatedAt: string;
  readonly advanced: boolean;
}

export interface ScoutStatusChangeRepository {
  getAcknowledgedCursor(): Promise<string | null>;
  listChanges(input: ListScoutStatusChangesInput): Promise<ScoutStatusChangePage>;
  acknowledge(
    input: AcknowledgeScoutStatusChangesInput,
  ): Promise<ScoutStatusChangeAcknowledgement>;
}
