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
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import logger from '@/lib/logger';
import { resolveGitHubCredentials, resolveRedditCredentials, resolveYouTubeCredentials } from './credentials';
import { importAllGitHubStars, importAllRedditSaved, importAllYouTubePlaylists } from './importers';
import { importAllDocumentIntelligenceActions } from './importers/document-intelligence-importer';

const SETTINGS_KEY = 'triage_auto_sync';

export type TriageSourceId = 'github-stars' | 'reddit-saved' | 'youtube' | 'document-intelligence';

export interface TriageAutoSyncSourceConfig {
  enabled: boolean;
  intervalMinutes: number;
}

export interface TriageAutoSyncConfig {
  sources: Record<TriageSourceId, TriageAutoSyncSourceConfig>;
}

const DEFAULT_CONFIG: TriageAutoSyncConfig = {
  sources: {
    'github-stars': { enabled: false, intervalMinutes: 30 },
    'reddit-saved': { enabled: false, intervalMinutes: 60 },
    'youtube': { enabled: false, intervalMinutes: 60 },
    'document-intelligence': { enabled: false, intervalMinutes: 15 },
  },
};

interface ScheduledTriageJob {
  sourceId: TriageSourceId;
  task: ScheduledTask;
  intervalMinutes: number;
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
      this.runImport(sourceId).catch((err) => {
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
  async runImport(sourceId: TriageSourceId): Promise<void> {
    if (this.syncInProgress.has(sourceId)) {
      logger.warn({ sourceId }, 'Triage auto-sync already in progress, skipping');
      return;
    }

    this.syncInProgress.add(sourceId);
    try {
      if (sourceId === 'github-stars') {
        const creds = await resolveGitHubCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no GitHub credentials configured');
          return;
        }
        const result = await importAllGitHubStars({
          token: creds.token,
          username: creds.username,
          incremental: true,
        });
        logger.info(
          { sourceId, imported: result.imported, skipped: result.skipped, pages: result.pagesProcessed, durationMs: result.durationMs },
          'Triage auto-sync completed',
        );
      }
      if (sourceId === 'reddit-saved') {
        const creds = await resolveRedditCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no Reddit credentials configured');
          return;
        }
        const result = await importAllRedditSaved({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          username: creds.username,
          incremental: true,
        });
        logger.info(
          { sourceId, imported: result.imported, skipped: result.skipped, pages: result.pagesProcessed, durationMs: result.durationMs },
          'Triage auto-sync completed',
        );
      }
      if (sourceId === 'youtube') {
        const creds = await resolveYouTubeCredentials();
        if (!creds) {
          logger.warn({ sourceId }, 'Triage auto-sync: no YouTube credentials configured');
          return;
        }
        const result = await importAllYouTubePlaylists({
          clientId: creds.clientId,
          clientSecret: creds.clientSecret,
          refreshToken: creds.refreshToken,
          playlistIds: creds.playlistIds,
          incremental: true,
        });
        logger.info(
          { sourceId, imported: result.imported, skipped: result.skipped, pages: result.pagesProcessed, durationMs: result.durationMs },
          'Triage auto-sync completed',
        );
      }
      if (sourceId === 'document-intelligence') {
        const result = await importAllDocumentIntelligenceActions({ incremental: true });
        logger.info(
          { sourceId, imported: result.imported, skipped: result.skipped, durationMs: result.durationMs },
          'Triage auto-sync completed',
        );
      }
    } finally {
      this.syncInProgress.delete(sourceId);
    }
  }

  /**
   * Read the persisted config (or return defaults).
   */
  async getConfig(): Promise<TriageAutoSyncConfig> {
    try {
      const [row] = await db.select().from(appSettings).where(eq(appSettings.key, SETTINGS_KEY)).limit(1);
      if (row?.value && typeof row.value === 'object') {
        const stored = row.value as Partial<TriageAutoSyncConfig>;
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
    } catch {
      // Table may not exist yet
    }
    return structuredClone(DEFAULT_CONFIG);
  }

  /**
   * Update config in DB and re-schedule affected sources.
   */
  async updateConfig(update: Partial<TriageAutoSyncConfig>): Promise<TriageAutoSyncConfig> {
    const current = await this.getConfig();
    const merged: TriageAutoSyncConfig = {
      sources: {
        'github-stars': { ...current.sources['github-stars'], ...update.sources?.['github-stars'] },
        'reddit-saved': { ...current.sources['reddit-saved'], ...update.sources?.['reddit-saved'] },
        'youtube': { ...current.sources['youtube'], ...update.sources?.['youtube'] },
        'document-intelligence': { ...current.sources['document-intelligence'], ...update.sources?.['document-intelligence'] },
      },
    };

    // Persist
    const now = new Date().toISOString();
    await db.insert(appSettings).values({
      key: SETTINGS_KEY,
      value: merged as unknown as Record<string, unknown>,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: appSettings.key,
      set: { value: merged as unknown as Record<string, unknown>, updatedAt: now },
    });

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

  private intervalToCron(minutes: number): string {
    if (minutes <= 1) return '* * * * *';
    if (minutes < 60) return `*/${minutes} * * * *`;
    const hours = Math.floor(minutes / 60);
    return `0 */${hours} * * *`;
  }
}

// Singleton
export const triageSyncScheduler = new TriageSyncScheduler();
