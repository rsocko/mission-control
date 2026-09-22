import {
  CopilotLifecycleError,
  type CopilotRunRecord,
  type CopilotRunState,
  type CopilotRunStore,
} from './copilot-lifecycle-contracts';

export type CopilotRunTransitionListener = (
  record: CopilotRunRecord,
) => void;

export class CopilotRunStateMachine {
  constructor(
    private readonly store: CopilotRunStore,
    private readonly workerId: string,
    private readonly leaseDurationMs: number,
    private readonly now: () => number = Date.now,
    private readonly onTransition: CopilotRunTransitionListener = () => undefined,
  ) {}

  async get(runId: string): Promise<CopilotRunRecord | undefined> {
    return this.store.get(runId);
  }

  async list(): Promise<CopilotRunRecord[]> {
    return this.store.list();
  }

  async require(runId: string): Promise<CopilotRunRecord> {
    const record = await this.store.get(runId);
    if (!record) throw new CopilotLifecycleError('run_not_found');
    return record;
  }

  async create(record: CopilotRunRecord): Promise<void> {
    if (!(await this.store.create(record))) {
      throw new CopilotLifecycleError('run_exists');
    }
  }

  async transition(
    record: CopilotRunRecord,
    state: CopilotRunState,
    changes: Partial<CopilotRunRecord> = {},
  ): Promise<CopilotRunRecord> {
    const timestamp = this.now();
    const updated: CopilotRunRecord = {
      ...record,
      ...changes,
      runId: record.runId,
      state,
      ownerId: this.workerId,
      leaseExpiresAt: timestamp + this.leaseDurationMs,
      revision: record.revision + 1,
      updatedAt: timestamp,
    };
    if (!(await this.store.compareAndSet(record.revision, updated))) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    this.onTransition(updated);
    return updated;
  }

  async updateMetadata(
    record: CopilotRunRecord,
    changes: Partial<CopilotRunRecord>,
  ): Promise<CopilotRunRecord> {
    const updated: CopilotRunRecord = {
      ...record,
      ...changes,
      runId: record.runId,
      state: record.state,
      ownerId: record.ownerId,
      leaseExpiresAt: record.leaseExpiresAt,
      revision: record.revision + 1,
      updatedAt: this.now(),
    };
    if (!(await this.store.compareAndSet(record.revision, updated))) {
      throw new CopilotLifecycleError('lifecycle_conflict');
    }
    this.onTransition(updated);
    return updated;
  }

  async transitionCurrent(
    runId: string,
    state: CopilotRunState | undefined,
    changes: Partial<CopilotRunRecord>,
  ): Promise<CopilotRunRecord> {
    for (;;) {
      const record = await this.require(runId);
      if (record.state === 'cleaned_up') return record;
      try {
        return await this.transition(record, state ?? record.state, changes);
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          throw error;
        }
      }
    }
  }
}
