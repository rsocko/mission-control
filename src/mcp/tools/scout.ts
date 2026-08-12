import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { mcPost, mcGet } from '../client';
import { MC_PUBLIC_URL } from '../public-url';

/** Escape markdown link-breaking characters in text used inside [...] */
function mdEscapeTitle(s: string): string {
  return s.replace(/[[\]]/g, '\\$&');
}

export function registerScoutTools(server: McpServer) {
  server.tool(
    'mc_scout_reconcile',
    'Evaluate sanitized structured M365 signals against open Scout tasks. Confidence is deterministic; completion requires confirmation unless an explicit scoped policy allows it.',
    {
      scope: z.string().trim().max(240).optional().describe('"all", "project:<id>", or "task:<id>"'),
      lookbackHours: z.number().int().min(1).max(168).optional().describe('Bounded evidence lookback; defaults to 48 hours'),
      dryRun: z.boolean().optional().describe('Evaluate without creating suggestions or mutating tasks'),
      sourceIdentity: z.string().trim().min(1).max(160).describe('Unique automation/run identity used for audit provenance'),
      idempotencyKey: z.string().trim().min(8).max(200).optional().describe('Stable retry key for this exact run'),
      signals: z.array(z.object({
        signalId: z.string().trim().min(1).max(160),
        taskId: z.string().trim().min(1).max(200),
        sourceType: z.enum(['email', 'teams', 'meeting', 'planner', 'cross-source']),
        kind: z.enum([
          'planner-completed',
          'user-confirmed-complete',
          'requester-confirmed-resolved',
          'meeting-confirmed-complete',
          'teams-confirmed-handled',
          'source-cancelled',
          'superseded',
          'inactivity',
          'urgent',
          'blocked',
          'ambiguous',
          'sensitive',
        ]),
        occurredAt: z.string().datetime({ offset: true }),
        summary: z.string().trim().min(1).max(240).describe('Sanitized one-line evidence summary; never include message bodies or transcripts'),
        sourceRefHash: z.string().regex(/^[a-f0-9]{64}$/).describe('Required lowercase SHA-256 hash of the M365 source reference; do not send raw identifiers'),
      }).strict()).max(500),
    },
    async ({ scope, lookbackHours, dryRun, sourceIdentity, idempotencyKey, signals }) => {
      const res = await mcPost<{
        runId: string;
        idempotentReplay: boolean;
        dryRun: boolean;
        reconciled: Array<{
          taskId: string;
          title: string;
          action: 'auto-complete' | 'suggest-complete' | 'escalate' | 'no-change';
          confidence: number;
          policyDecision: string;
          policyReason: string;
          applied: boolean;
        }>;
        summary: {
          autoCompleted: number;
          suggestedComplete: number;
          escalated: number;
          unchanged: number;
          ignoredSignals: number;
        };
      }>('/api/scout/reconcile', {
        scope: scope || 'all',
        lookbackHours: lookbackHours ?? 48,
        dryRun: dryRun ?? false,
        source: 'automation',
        sourceIdentity,
        ...(idempotencyKey ? { idempotencyKey } : {}),
        signals,
      });

      if (!res.ok) {
        return {
          content: [{ type: 'text' as const, text: `Scout reconciliation failed: ${res.error}` }],
          isError: true,
        };
      }

      const data = res.data!;
      const summary = data.summary;
      const lines = data.reconciled
        .filter((item) => item.action !== 'no-change')
        .map((item) =>
          `- ${mdEscapeTitle(item.title)}: ${item.action} (${Math.round(item.confidence * 100)}%) — ${item.policyReason}`);
      return {
        content: [{
          type: 'text' as const,
          text: [
            `Reconciliation ${data.runId}${data.idempotentReplay ? ' (idempotent replay)' : ''}: ${summary.autoCompleted} completed, ${summary.suggestedComplete} suggested, ${summary.escalated} escalated, ${summary.unchanged} unchanged.`,
            lines.length ? lines.join('\n') : 'No tasks require action.',
          ].join('\n\n'),
        }],
        structuredContent: data,
      };
    },
  );

  registerAppTool(
    server,
    'mc_scout_push_tasks',
    {
      description: 'Push curated task items from Scout into Mission Control for tracking. Handles deduplication on sourceId.',
      inputSchema: {
        items: z.array(z.object({
          sourceId: z.string().describe('Stable unique ID for dedup (e.g. "scout:email:AAMkAG...")'),
          sourceType: z.enum(['email', 'teams', 'meeting', 'planner', 'cross-source']),
          title: z.string().describe('Action item title (concise, imperative)'),
          description: z.string().optional().describe('AI-generated context summary'),
          priority: z.enum(['critical', 'high', 'medium', 'low', 'none']).optional(),
          dueDate: z.string().optional().describe('ISO date if deadline detected'),
          confidence: z.number().optional().describe('0-1 confidence this is truly actionable'),
          context: z.object({
            from: z.string().optional().describe('Person/entity who triggered this'),
            sourceSubject: z.string().optional().describe('Email subject / Teams channel / Meeting title'),
            extractedAt: z.string().describe('ISO timestamp when Scout extracted this'),
            reasoning: z.string().optional().describe('Why Scout thinks this is actionable'),
            relatedSourceIds: z.array(z.string()).optional().describe('Other Scout items this relates to'),
          }).optional(),
          suggestedTags: z.array(z.string()).optional().describe('Tag slugs Scout recommends'),
          suggestedProjectId: z.string().optional().describe('MC project ID if Scout can infer'),
        })).describe('Array of curated items to push'),
      },
      _meta: {
        ui: {
          resourceUri: 'ui://mc/task-list',
          visibility: ['model'],
        },
      },
    },
    async ({ items }) => {
      const res = await mcPost<{
        created: number;
        updated: number;
        triaged: number;
        skipped: number;
        total: number;
        items: Array<{ sourceId: string; mcTaskId: string | null; action: string; reason?: string }>;
      }>('/api/scout/ingest', { items });

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const data = res.data!;
      const summary = `Processed in Mission Control: ${data.created} new tasks, ${data.updated} update${data.updated !== 1 ? 's' : ''}, ${data.triaged} sent to triage.`;

      // Build a readable list with hyperlinks to each task
      const itemLines = data.items.map((item, idx) => {
        const inputItem = items[idx];
        const title = mdEscapeTitle(inputItem?.title || item.sourceId);
        if (item.mcTaskId) {
          const url = `${MC_PUBLIC_URL}/tasks/${item.mcTaskId}`;
          return `- [${title}](${url}) — ${item.action}`;
        }
        return `- ${title} — ${item.action}${item.reason ? ` (${item.reason})` : ''}`;
      }).join('\n');

      // Build widget data from response items
      const widgetTasks = data.items
        .map((item, idx) => ({ item, inputItem: items[idx] }))
        .filter(({ item }) => item.mcTaskId)
        .map(({ item, inputItem }) => ({
          id: item.mcTaskId,
          title: inputItem?.title || item.sourceId,
          priority: inputItem?.priority || 'none',
          status: 'todo',
          dueDate: inputItem?.dueDate || null,
        }));

      const uiMeta = widgetTasks.length > 0 ? {
        resourceUri: 'ui://mc/task-list',
        url: `${MC_PUBLIC_URL}/mcp-widgets/task-list.html`,
        title: `${widgetTasks.length} Tasks Pushed`,
        data: {
          tasks: widgetTasks,
          mcBaseUrl: MC_PUBLIC_URL,
          listTitle: `Pushed ${widgetTasks.length} tasks to Mission Control`,
        }
      } : undefined;

      return {
        content: [{ type: 'text' as const, text: `${summary}\n\n${itemLines}` }],
        structuredContent: {
          tasks: widgetTasks,
          mcBaseUrl: MC_PUBLIC_URL,
          listTitle: `Pushed ${widgetTasks.length} tasks to Mission Control`,
        },
        ...(uiMeta ? { _meta: { ui: uiMeta } } : {}),
      };
    }
  );

  server.tool(
    'mc_scout_status_sync',
    'Get status changes for Scout-originated tasks (for write-back to business M365). Auto-uses last acknowledged cursor if no "since" provided.',
    {
      since: z.string().optional().describe('ISO timestamp — only changes after this time. If omitted, uses last acknowledged cursor.'),
      sourceTypes: z.array(z.string()).optional().describe('Filter by source type'),
      acknowledge: z.boolean().optional().describe('If true, automatically acknowledge the returned changes (advance cursor to queriedAt)'),
    },
    async ({ since, sourceTypes, acknowledge }) => {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      if (sourceTypes?.length) params.set('sourceTypes', sourceTypes.join(','));

      const res = await mcGet<{ changes: unknown[]; count: number; since: string | null; cursorSource: string; queriedAt: string }>(`/api/scout/status-changes?${params.toString()}`);

      if (!res.ok) {
        return { content: [{ type: 'text' as const, text: `Error: ${res.error}` }], isError: true };
      }

      const data = res.data!;

      // Auto-acknowledge if requested and there were changes
      if (acknowledge && data.count > 0) {
        const ackRes = await mcPost<{ success: boolean; cursor: string }>('/api/scout/status-changes/ack', {
          acknowledgedAt: data.queriedAt,
        });
        if (!ackRes.ok) {
          return { content: [{ type: 'text' as const, text: `Got ${data.count} changes but failed to acknowledge: ${ackRes.error}` }], isError: true };
        }
      }

      const cursorInfo = data.cursorSource === 'write_back_cursor' ? ' (auto from last ack)' : data.cursorSource === 'explicit' ? ' (explicit)' : '';
      const ackInfo = acknowledge && data.count > 0 ? ' — cursor advanced' : '';
      const summary = `Status sync: ${data.count} change(s) found (since: ${data.since || 'all time'}${cursorInfo}, queried at: ${data.queriedAt})${ackInfo}`;

      return {
        content: [{ type: 'text' as const, text: `${summary}\n\n${JSON.stringify(data.changes, null, 2)}` }],
      };
    }
  );
}
