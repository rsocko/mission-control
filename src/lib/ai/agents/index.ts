import { generateText } from 'ai';
import { getAIModel } from '../provider-factory';
import db from '@/db';
import { tasks, notifications } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { previewIntake, executeIntake, type IntakeResult } from '@/lib/intake';
import {
  executeMaintenanceAgent,
  type MaintenanceAgentOptions,
} from './maintenance';
import { notificationNeedsAttention } from '@/lib/notifications/lifecycle-sql';

export {
  MAINTENANCE_AGENT_BUDGETS,
  MaintenanceAgentConflictError,
} from './maintenance';

/**
 * Agent Dispatch System
 * 
 * Allows the AI to execute multi-step actions on behalf of the user.
 * Each agent is a focused automation that performs a specific task.
 */

export type AgentType =
  | 'complete-overdue'    // Mark overdue low-priority tasks as done
  | 'bulk-prioritize'     // Re-prioritize all tasks based on due dates
  | 'cleanup-done'        // Archive/clean completed tasks older than X days
  | 'tag-all-untagged'    // Apply AI-inferred tags to untagged tasks
  | 'snooze-low-priority' // Push low-priority task due dates forward
  | 'dismiss-old-notifications'  // Mark old low-severity notifications as read
  | 'intake-document'     // Parse a structured doc and create project + issues + phases
  | 'custom';             // Execute a custom instruction

export interface AgentResult {
  agent: AgentType;
  status: 'success' | 'partial' | 'failed';
  summary: string;
  actionsPerformed: number;
  details: Array<{ action: string; target: string; result: string }>;
  startedAt: string;
  completedAt: string;
  checkpoint?: string | null;
  hasMore?: boolean;
  scanned?: number;
  remainingWork?: 'none' | 'more' | 'unknown';
  stopReason?: 'cancelled' | 'timed_out' | 'error';
}

export async function dispatchAgent(
  agentType: AgentType,
  options?: { dryRun?: boolean; customInstruction?: string; document?: string; documentUrl?: string; filePath?: string; repo?: string; projectName?: string; cursor?: string; signal?: AbortSignal }
): Promise<AgentResult> {
  const startedAt = new Date().toISOString();
  const dryRun = options?.dryRun ?? false;

  switch (agentType) {
    case 'dismiss-old-notifications':
    case 'bulk-prioritize':
    case 'cleanup-done':
    case 'snooze-low-priority':
      return executeMaintenanceAgent(agentType, {
        dryRun,
        cursor: options?.cursor,
        signal: options?.signal,
      } satisfies MaintenanceAgentOptions);
    case 'intake-document':
      return intakeDocumentAgent(options?.document || '', options?.documentUrl, options?.filePath, options?.repo || '', dryRun, startedAt, options?.projectName);
    case 'custom':
      return customAgent(options?.customInstruction || '', startedAt);
    default:
      return { agent: agentType, status: 'failed', summary: `Unknown agent: ${agentType}`, actionsPerformed: 0, details: [], startedAt, completedAt: new Date().toISOString() };
  }
}

async function customAgent(instruction: string, startedAt: string): Promise<AgentResult> {
  // Get context for the AI
  const openTasks = await db.select().from(tasks).where(eq(tasks.status, 'todo')).limit(20);
  const unreadNotifs = await db.select().from(notifications).where(notificationNeedsAttention()).limit(10);
  const route = getAIModel('custom-agent', {
    sources: [
      ...openTasks.map((task) => task.connectorType),
      ...unreadNotifs.map((notification) => notification.connectorType),
    ],
  });

  const context = `
OPEN TASKS (${openTasks.length}):
${openTasks.map(t => `- [${t.id}] "${t.title}" priority:${t.priority} due:${t.dueDate || 'none'} source:${t.connectorType}`).join('\n')}

UNREAD NOTIFICATIONS (${unreadNotifs.length}):
${unreadNotifs.map(a => `- [${a.id}] "${a.title}" level:${a.level}`).join('\n')}
`;

  const result = await generateText({
    model: route.model,
    system: `You are an agent that analyzes the user's tasks and notifications and provides a structured action plan. Given the instruction, analyze the data and respond in JSON: {"plan": "what you would do", "steps": [{"action": "describe", "target": "task/notification title"}]}`,
    messages: [{ role: 'user', content: `Instruction: ${instruction}\n\nContext:\n${context}` }],
  });

  try {
    const parsed = JSON.parse(result.text);
    return {
      agent: 'custom',
      status: 'success',
      summary: parsed.plan || 'Custom agent completed',
      actionsPerformed: parsed.steps?.length || 0,
      details: (parsed.steps || []).map((s: { action: string; target: string }) => ({
        action: s.action, target: s.target, result: 'planned (requires confirmation)',
      })),
      startedAt,
      completedAt: new Date().toISOString(),
    };
  } catch {
    return {
      agent: 'custom',
      status: 'success',
      summary: result.text,
      actionsPerformed: 0,
      details: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}

async function intakeDocumentAgent(document: string, documentUrl: string | undefined, filePath: string | undefined, repo: string, dryRun: boolean, startedAt: string, projectName?: string): Promise<AgentResult> {
  // Resolve content from URL or filePath if no direct document
  let content = document;

  if (!content.trim() && documentUrl) {
    try {
      const headers: Record<string, string> = { Accept: 'text/plain, text/markdown, */*' };
      if ((documentUrl.includes('github.com') || documentUrl.includes('raw.githubusercontent.com')) && process.env.GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
      }
      const res = await fetch(documentUrl, { headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      content = await res.text();
    } catch (err) {
      return {
        agent: 'intake-document',
        status: 'failed',
        summary: `Failed to fetch document from URL: ${documentUrl} — ${err instanceof Error ? err.message : 'unknown error'}`,
        actionsPerformed: 0,
        details: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  if (!content.trim() && filePath) {
    try {
      const { readFile } = await import('node:fs/promises');
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      return {
        agent: 'intake-document',
        status: 'failed',
        summary: `Failed to read file: ${filePath} — ${err instanceof Error ? err.message : 'unknown error'}`,
        actionsPerformed: 0,
        details: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }
  }

  if (!content.trim()) {
    return {
      agent: 'intake-document',
      status: 'failed',
      summary: 'No document content provided. Pass markdown content in "document", a URL in "documentUrl", or a file path in "filePath".',
      actionsPerformed: 0,
      details: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // Preview mode if no repo provided
  if (!repo || dryRun) {
    const preview = previewIntake(content, { projectName });
    return {
      agent: 'intake-document',
      status: 'success',
      summary: `Parsed ${preview.proposedIssueCount} findings into ${preview.proposedPhases.length} phases. Project: "${preview.proposedProjectName}". Tags: ${preview.proposedTags.length}. Provide a "repo" (owner/repo) to execute.`,
      actionsPerformed: 0,
      details: [
        ...preview.document.findings.map(f => ({
          action: 'would_create_issue',
          target: `[${f.id}] ${f.issue.slice(0, 60)}`,
          result: `Priority ${f.priorityOrder}, Effort ${f.effort}`,
        })),
        ...preview.proposedPhases.map(p => ({
          action: 'would_create_phase',
          target: p.name,
          result: `${p.findingIds.length} items, ~${p.estimatedDays ?? '?'}d`,
        })),
      ],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }

  // Execute mode
  const mcUrl = process.env.MC_INTERNAL_URL || process.env.NEXTAUTH_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`;

  const result: IntakeResult = await executeIntake(content, {
    mcUrl,
    repo,
    dryRun: false,
    projectName,
  });

  const tasksCreated = result.issues.filter(i => i.issueNumber).length;
  const assigned = result.assignments.filter(a => a.status === 'assigned').length;

  return {
    agent: 'intake-document',
    status: result.errors.length > 0 ? 'partial' : 'success',
    summary: `Created ${tasksCreated} tasks (synced to GitHub), project "${result.projectId}", ${result.phases.length} phases, ${result.tags.length} tags. ${assigned} tasks assigned to phases.${result.errors.length ? ` (${result.errors.length} warnings)` : ''}`,
    actionsPerformed: tasksCreated + result.phases.length + assigned,
    details: [
      ...result.issues.filter(i => i.issueNumber).map(i => ({
        action: 'created_issue',
        target: i.findingId,
        result: `#${i.issueNumber}`,
      })),
      ...result.phases.map(p => ({
        action: 'created_phase',
        target: p.name,
        result: p.id,
      })),
      ...result.errors.map(e => ({
        action: 'error',
        target: '',
        result: e,
      })),
    ],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}
