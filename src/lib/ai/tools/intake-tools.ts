import { tool, zodSchema } from 'ai';
import { z } from 'zod';
import { previewIntake, executeIntake } from '@/lib/intake';

export const intakeTools = {
  intakeDocument: tool({
    description:
      'Parse a structured document (report, planning doc, etc.) into a project with issues and phases. ' +
      'Use mode "preview" first to show the user what would be created, then "execute" after confirmation. ' +
      'Accepts either direct document content or a URL to fetch from.',
    inputSchema: zodSchema(
      z.object({
        document: z
          .string()
          .optional()
          .describe('Direct markdown/text content of the document'),
        documentUrl: z
          .string()
          .optional()
          .describe('URL to fetch the document from (e.g., a GitHub raw URL or public link)'),
        repo: z
          .string()
          .optional()
          .describe('Target GitHub repo in owner/repo format for issue creation (required for execute mode)'),
        mode: z
          .enum(['preview', 'execute'])
          .default('preview')
          .describe('Preview shows what would be created; execute actually creates issues/project'),
        projectName: z
          .string()
          .optional()
          .describe('Optional custom project name override'),
        category: z
          .string()
          .optional()
          .describe('Optional project category (e.g. "audit", "development"). If not specified, the project will be uncategorized'),
        skipFindingIds: z
          .array(z.string())
          .optional()
          .describe('Optional finding IDs to skip during execute mode'),
        tags: z
          .array(z.string())
          .optional()
          .describe('Optional tag override list to use during execute mode'),
      }),
    ),
    execute: async ({ document, documentUrl, repo, mode, projectName, category, skipFindingIds, tags }) => {
      // Resolve document content
      let content = document || '';

      if (!content && documentUrl) {
        const headers: Record<string, string> = { Accept: 'text/plain, text/markdown, */*' };
        if (
          (documentUrl.includes('github.com') || documentUrl.includes('raw.githubusercontent.com')) &&
          process.env.GITHUB_TOKEN
        ) {
          headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
        }
        const res = await fetch(documentUrl, { headers });
        if (!res.ok) {
          return { error: `Failed to fetch document from URL (${res.status}): ${documentUrl}` };
        }
        content = await res.text();
      }

      if (!content.trim()) {
        return { error: 'No document content provided. Supply either "document" (text) or "documentUrl" (URL to fetch).' };
      }

      // Preview mode
      if (mode === 'preview' || !mode) {
        const preview = previewIntake(content, { projectName });
        return {
          mode: 'preview',
          projectName: preview.proposedProjectName,
          issueCount: preview.proposedIssueCount,
          phases: preview.proposedPhases.map(p => ({
            name: p.name,
            itemCount: p.findingIds.length,
            estimatedDays: p.estimatedDays,
          })),
          tags: preview.proposedTags,
          findings: preview.document.findings.slice(0, 15).map(f => ({
            id: f.id,
            issue: f.issue.slice(0, 100),
            priority: f.priorityOrder,
            effort: f.effort,
          })),
          hint: repo
            ? 'Ready to execute. Call again with mode "execute" to create issues.'
            : 'Provide a "repo" (owner/repo) and call again with mode "execute" to create GitHub issues.',
        };
      }

      // Execute mode
      if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
        return { error: 'repo (owner/repo format) is required for execute mode' };
      }

      const mcUrl = process.env.MC_INTERNAL_URL || process.env.NEXTAUTH_URL || `http://127.0.0.1:${process.env.PORT || '3000'}`;
      const result = await executeIntake(content, {
        mcUrl,
        repo,
        dryRun: false,
        projectName,
        category,
        skipFindingIds,
        tags,
      });

      const tasksCreated = result.issues.filter(i => i.issueNumber).length;
      return {
        mode: 'execute',
        projectId: result.projectId,
        tasksCreated,
        phases: result.phases.map(p => ({ name: p.name, id: p.id })),
        tags: result.tags,
        errors: result.errors.length > 0 ? result.errors : undefined,
        summary: `Created ${tasksCreated} tasks (synced to GitHub) in ${repo}, project "${result.projectId}", ${result.phases.length} phases.`,
      };
    },
  }),
};
