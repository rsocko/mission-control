import {
  CopilotLifecycleError,
  cloneCopilotRun,
  type CopilotRunRecord,
  type CopilotRunSnapshot,
} from './copilot-lifecycle-contracts';
import type { CopilotLeaseManager } from './copilot-lease-manager';
import type { CopilotRunStateMachine } from './copilot-run-state-machine';

export interface CopilotRunReaperHooks {
  deleteSession(runId: string, sessionId: string): Promise<void>;
  ensureTelemetry?(record: CopilotRunRecord): void;
  reportError?(operation: string, error: CopilotLifecycleError): void;
}

export class CopilotRunReaper {
  constructor(
    private readonly stateMachine: CopilotRunStateMachine,
    private readonly leases: CopilotLeaseManager,
    private readonly hooks: CopilotRunReaperHooks,
  ) {}

  async reapExpiredDisconnectedRuns(): Promise<CopilotRunSnapshot[]> {
    const expired = await this.leases.expiredDisconnectedRuns();
    const reaped: CopilotRunSnapshot[] = [];
    for (const record of expired) {
      this.hooks.ensureTelemetry?.(record);
      const terminal = await this.stateMachine.transition(record, 'timed_out', {
        terminalState: 'timed_out',
      });
      const cleanupStarted = await this.stateMachine.transition(
        terminal,
        'timed_out',
        {
          cleanupPending: true,
          cleanupFailure: undefined,
        },
      );
      try {
        await this.hooks.deleteSession(
          record.runId,
          record.providerSessionId!,
        );
        reaped.push(
          cloneCopilotRun(
            await this.stateMachine.transition(cleanupStarted, 'cleaned_up', {
              cleanupPending: undefined,
              cleanupFailure: undefined,
              providerSessionId: undefined,
            }),
          ),
        );
      } catch {
        await this.stateMachine.transition(cleanupStarted, 'failed', {
          cleanupPending: true,
          cleanupFailure: true,
        });
        this.hooks.reportError?.(
          'detached-session-reaper',
          new CopilotLifecycleError('cleanup_failed'),
        );
      }
    }
    return reaped;
  }

  async recoverExpiredWorkerLeases(): Promise<CopilotRunSnapshot[]> {
    const expired = await this.leases.expiredAttachedLeases();
    const recovered: CopilotRunSnapshot[] = [];
    for (const record of expired) {
      this.hooks.ensureTelemetry?.(record);
      try {
        if (
          record.providerSessionId &&
          (record.state === 'idle' || record.state === 'resuming')
        ) {
          recovered.push(
            cloneCopilotRun(
              await this.stateMachine.transition(record, 'idle', {
                connection: 'detached',
              }),
            ),
          );
          continue;
        }

        let terminal = await this.stateMachine.transition(record, 'failed', {
          terminalState: record.terminalState ?? 'failed',
        });
        if (record.providerSessionId) {
          terminal = await this.stateMachine.transition(terminal, 'failed', {
            cleanupPending: true,
            cleanupFailure: undefined,
          });
          try {
            await this.hooks.deleteSession(
              record.runId,
              record.providerSessionId,
            );
          } catch {
            terminal = await this.stateMachine.transition(terminal, 'failed', {
              cleanupPending: true,
              cleanupFailure: true,
            });
            this.hooks.reportError?.(
              'expired-worker-lease-recovery',
              new CopilotLifecycleError('cleanup_failed'),
            );
            recovered.push(cloneCopilotRun(terminal));
            continue;
          }
        }
        recovered.push(
          cloneCopilotRun(
            await this.stateMachine.transition(terminal, 'cleaned_up', {
              cleanupPending: undefined,
              cleanupFailure: undefined,
              providerSessionId: undefined,
            }),
          ),
        );
      } catch (error) {
        if (
          !(error instanceof CopilotLifecycleError) ||
          error.code !== 'lifecycle_conflict'
        ) {
          throw error;
        }
      }
    }
    return recovered;
  }
}
