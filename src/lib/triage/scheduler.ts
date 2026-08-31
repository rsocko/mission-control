/**
 * Triage Auto-Sync Scheduler — #162
 *
 * Manages periodic background imports for triage sources (GitHub Stars, Reddit Saved).
 * Uses node-cron for scheduling, matching the pattern used by SyncScheduler for connectors.
 *
 * Schedule configuration is persisted in app_settings under the key `triage_auto_sync`.
 */
import type { ScheduledTask } from 'node-cron';
import cron from 'node-cron';
import logger from '@/lib/logger';
import { resolveGitHubCredentials, resolveRedditCredentials, resolveYouTubeCredentials } from './credentials';
import { importAllGitHubStars, importAllRedditSaved, importAllYouTubePlaylists } from './importers';
import { importAllDocumentIntelligenceActions } from './importers/document-intelligence-importer';
import { withDatabaseOperation } from '@/lib/telemetry/database-operation-context';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import type { FullSyncResult } from './importers/base-importer';
import type { PersistenceJson } from '@/db/persistence/contracts';

const SETTINGS_KEY = 'triage_auto_sync';

export type TriageSourceId = 'github-stars' | 'reddit-saved' | 'youtube' | 'document-intelligence';

export interface TriageAutoSyncSourceConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface TriageAutoSyncConfig {
  sources: Record<TriageSourceId, TriageAutoSyncSourceConfig>;
}

export interface TriageAutoSyncConfigUpdate {
  sources?: Partial<Record<TriageSourceId, Partial<TriageAutoSyncSourceConfig>>>;
}

const DEFAULT_CONFIG: TriageAutoSyncConfig = {
  sources: {
    'github-stars': { enabled: false, intervalMinutes: 30 },
    'reddit-saved': { enabled: false, intervalMinutes: 60 },
    'youtube': { enabled: false, intervalMinutes: 60 },
    'document-intelligence': { enabled: false, intervalMinutes: 15 },
  },
};

function serializeConfig(config: TriageAutoSyncConfig): PersistenceJson {
  return {
    sources: {
      'github-stars': {
        enabled: config.sources['github-stars'].enabled,
        intervalMinutes: config.sources['github-stars'].intervalMinutes,
      },
      'reddit-saved': {
        enabled: config.sources['reddit-saved'].enabled,
        intervalMinutes: config.sources['reddit-saved'].intervalMinutes,
      },
      youtube: {
        enabled: config.sources.youtube.enabled,
        intervalMinutes: config.sources.youtube.intervalMinutes,
      },
      'document-intelligence': {
        enabled: config.sources['document-intelligence'].enabled,
        intervalMinutes: config.sources['document-intelligence'].intervalMinutes,
      },
    },
  };
}

interface ScheduledTriageJob {
  sourceId: TriageSourceId;
  task: ScheduledTask;
  intervalMinutes: number;
}

export interface ScheduledTriageImportResult {
  sourceId: TriageSourceId;
  outcome: 'missing-config' | 'overlap' | FullSyncResult['outcome'];
  imported: number;
  skipped: number;
  errors: string[];
  durationMs: number;
}

/**
 * TriageSyncScheduler manages periodic import jobs for triage sources.
 */
export class TriageSyncScheduler {
  private jobs = new Map<string, ScheduledTriageJob>();
  private syncInProgress = new Set<string>();

  /**
   * Load config from DB and schedule all enabled sources.
   */
  async initialize(): Promise<void> {
    const config = await this.getConfig();
    for (const [sourceId, sourceConfig] of Object.entries(config.sources)) {
      if (sourceConfig.enabled) {
        this.scheduleSource(sourceId as TriageSourceId, sourceConfig.intervalMinutes);
      }
    }

    logger.info(
      { scheduledSources: Array.from(this.jobs.keys()) },
      'Triage auto-sync scheduler initialized',
    );
  }

  /**
   * Schedule a single source for periodic import.
   */
  scheduleSource(sourceId: TriageSourceId, intervalMinutes: number): void {
    this.unscheduleSource(sourceId);

    const cronExpr = this.intervalToCron(intervalMinutes);
    const task = cron.schedule(cronExpr, () => {
      this.runImport(sourceId)
        .then((result) => {
          logger.info(
            {
              sourceId,
              outcome: result.outcome,
              imported: result.imported,
              skipped: result.skipped,
              errorCount: result.errors.length,
              durationMs: result.durationMs,
            },
            'Triage auto-sync completed',
          );
        })
        .catch((err) => {
          logger.error({ err, sourceId }, 'Triage auto-sync failed');
        });
    });

    this.jobs.set(sourceId, { sourceId, task, intervalMinutes });
    task.start();

    logger.info({ sourceId, intervalMinutes, cronExpr }, 'Triage source scheduled');
  }

  /**
   * Remove a scheduled source.
   */
  unscheduleSource(sourceId: string): void {
    const job = this.jobs.get(sourceId);
    if (job) {
      job.task.stop();
      this.jobs.delete(sourceId);
    }
  }

  /**
   * Run an import for a specific source (called by cron or manually).
   */
  async runImport(sourceId: TriageSourceId): Promise<ScheduledTriageImportResult> {
    return withDatabaseOperation(
      'worker-triage-import',
      () => this.runImportWithAttribution(sourceId),
    );
  }

  private async runImportWithAttribution(
    sourceId: TriageSourceId,
  ): Promise<ScheduledTriageImportResult> {
    if (this.syncInProgress.has(sourceId)) {
      logger.warn({ sourceId }, 'Triage auto-sync already in progress, skipping');
      return {
        sourceId,
        outcome: 'overlap',
        imported: 0,
        skipped: 0,
        errors: [],
        durationMs: 0,
      };
    }

    this.syncInProgress.add(sourceId);
    const startedAt = Date.now();
    try {
      if (sourceId === 'github-stars') {
        const creds = await resolveGitHubCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no GitHub credentials configured');
          return this.missingConfigResult(sourceId, startedAt);
        }
        const result = await importAllGitHubStars({
          token: creds.token,
          username: creds.username,
          incremental: true,
        });
        return this.scheduledResult(sourceId, result);
      }
      if (sourceId === 'reddit-saved') {
        const creds = await resolveRedditCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no Reddit credentials configured');
          return this.missingConfigResult(sourceId, startedAt);
        }
        const result = await importAllRedditSaved({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          username: creds.username,
          incremental: true,
        });
        return this.scheduledResult(sourceId, result);
      }
      if (sourceId === 'youtube') {
        const creds = await resolveYouTubeCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no YouTube credentials configured');
          return this.missingConfigResult(sourceId, startedAt);
        }
        const result = await importAllYouTubePlaylists({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          playlistIds: creds.playlistIds,
          incremental: true,
        });
        return this.scheduledResult(sourceId, result);
      }
      if (sourceId === 'document-intelligence') {
        const result = await importAllDocumentIntelligenceActions({ incremental: true });
        return this.scheduledResult(sourceId, result);
      }
      throw new Error('Unsupported triage source');
    } finally {
      this.syncInProgress.delete(sourceId);
    }
  }

  /**
   * Read the persisted config (or return defaults).
   */
  async getConfig(): Promise<TriageAutoSyncConfig> {
    const value = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const stored = value as Partial<TriageAutoSyncConfig>;
      return {
        sources: {
          'github-stars': {
            ...DEFAULT_CONFIG.sources['github-stars'],
            ...stored.sources?.['github-stars'],
          },
          'reddit-saved': {
            ...DEFAULT_CONFIG.sources['reddit-saved'],
            ...stored.sources?.['reddit-saved'],
          },
          'youtube': {
            ...DEFAULT_CONFIG.sources['youtube'],
            ...stored.sources?.['youtube'],
          },
          'document-intelligence': {
            ...DEFAULT_CONFIG.sources['document-intelligence'],
            ...stored.sources?.['document-intelligence'],
          },
        },
      };
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  /**
   * Update config in DB and re-schedule affected sources.
   */
  async updateConfig(update: TriageAutoSyncConfigUpdate): Promise<TriageAutoSyncConfig> {
    const current = await this.getConfig();
    const merged: TriageAutoSyncConfig = {
      sources: {
        'github-stars': { ...current.sources['github-stars'], ...update.sources?.['github-stars'] },
        'reddit-saved': { ...current.sources['reddit-saved'], ...update.sources?.['reddit-saved'] },
        'youtube': { ...current.sources['youtube'], ...update.sources?.['youtube'] },
        'document-intelligence': { ...current.sources['document-intelligence'], ...update.sources?.['document-intelligence'] },
      },
    };

    await getCorePersistenceRepositories().settings.set(
      SETTINGS_KEY,
      serializeConfig(merged),
    );

    // Re-schedule each source according to new config
    for (const [sourceId, cfg] of Object.entries(merged.sources)) {
      if (cfg.enabled) {
        this.scheduleSource(sourceId as TriageSourceId, cfg.intervalMinutes);
      } else {
        this.unscheduleSource(sourceId);
      }
    }

    return merged;
  }

  /**
   * Get status of all scheduled jobs.
   */
  getStatus(): Array<{ sourceId: string; intervalMinutes: number; isRunning: boolean }> {
    return Array.from(this.jobs.values()).map((job) => ({
      sourceId: job.sourceId,
      intervalMinutes: job.intervalMinutes,
      isRunning: this.syncInProgress.has(job.sourceId),
    }));
  }

  /**
   * Stop all scheduled jobs.
   */
  stopAll(): void {
    for (const job of this.jobs.values()) {
      job.task.stop();
    }
    this.jobs.clear();
  }

  private missingConfigResult(
    sourceId: TriageSourceId,
    startedAt: number,
  ): ScheduledTriageImportResult {
    return {
      sourceId,
      outcome: 'missing-config',
      imported: 0,
      skipped: 0,
      errors: [],
      durationMs: Date.now() - startedAt,
    };
  }

  private scheduledResult(
    sourceId: TriageSourceId,
    result: FullSyncResult,
  ): ScheduledTriageImportResult {
    return {
      sourceId,
      outcome: result.outcome,
      imported: result.imported,
      skipped: result.skipped,
      errors: result.errors,
      durationMs: result.durationMs,
    };
  }

  private intervalToCron(minutes: number): string {
    if (minutes <= 1) return '* * * * *';
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.floor(minutes / 60);
    return `0 */${hours} * * *`;
  }
}

// Singleton
export const triageSyncScheduler = new TriageSyncScheduler();
