import { generateText } from 'ai';
import { resolveGitHubCredentials } from '../credentials';
import { getAIModel } from '@/lib/ai/provider-factory';
import logger from '@/lib/logger';
import type { TriageItem, TriageActionRecord } from '@/types';

export interface KnowledgeBaseOptions {
  category?: string;
  title?: string;
  path?: string;
}

export interface KnowledgeBaseResult {
  success: boolean;
  filePath?: string;
  fileUrl?: string;
  error?: string;
}

// ─── Category Mapping ────────────────────────────────────────────────────────

interface CategoryMap {
  [keyword: string]: string;
}

const DEFAULT_CATEGORY_MAP: CategoryMap = {
  coding: 'coding-tips',
  programming: 'coding-tips',
  dev: 'coding-tips',
  typescript: 'coding-tips',
  javascript: 'coding-tips',
  python: 'coding-tips',
  rust: 'coding-tips',
  'home-automation': 'home-automation',
  'smart-home': 'home-automation',
  homeassistant: 'home-automation',
  esphome: 'home-automation',
  '3d-printing': '3d-printing',
  '3d printing': '3d-printing',
  maker: '3d-printing',
  printing: '3d-printing',
  'self-hosted': 'homelab',
  selfhosted: 'homelab',
  homelab: 'homelab',
  docker: 'homelab',
  linux: 'homelab',
};

function getCategoryMap(): CategoryMap {
  const envCategories = process.env.MC_KNOWLEDGE_CATEGORIES;
  if (envCategories) {
    try {
      return { ...DEFAULT_CATEGORY_MAP, ...JSON.parse(envCategories) };
    } catch {
      logger.warn('MC_KNOWLEDGE_CATEGORIES is not valid JSON, using defaults');
    }
  }
  return DEFAULT_CATEGORY_MAP;
}

function resolveCategory(item: TriageItem, override?: string): string {
  if (override) return override;

  const categoryMap = getCategoryMap();
  const categories = item.aiCategories.map((c) => c.toLowerCase());

  for (const cat of categories) {
    // Direct match
    if (categoryMap[cat]) return categoryMap[cat];
    // Partial match
    for (const [keyword, folder] of Object.entries(categoryMap)) {
      if (cat.includes(keyword) || keyword.includes(cat)) return folder;
    }
  }

  return 'notes';
}

// ─── Slug Generation ─────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

// ─── Note Generation ─────────────────────────────────────────────────────────

interface NoteContent {
  title: string;
  sourceUrl: string;
  sourcePlatform: string;
  category: string;
  tags: string[];
  summary: string;
  keyPoints: string[];
  capturedAt: string;
}

async function generateNoteContent(item: TriageItem, category: string, titleOverride?: string): Promise<NoteContent> {
  const title = titleOverride || item.title || 'Untitled Note';
  const sourceUrl = item.canonicalUrl || item.sourceUrl;
  const tags = item.aiCategories.map((c) => c.toLowerCase().replace(/\s+/g, '-'));
  const summary = item.aiSummary || item.description || '';
  const capturedAt = item.capturedAt || new Date().toISOString();

  let keyPoints: string[] = [];

  // Try AI extraction if available
  try {
    const route = getAIModel('knowledge-base-extraction', {
      sources: item.sourcePlatform ? [item.sourcePlatform] : [],
    });

    const result = await generateText({
      model: route.model,
      system: 'You extract key takeaways from content. Return ONLY a JSON array of strings, each being a concise key point. Return 3-5 points maximum. No markdown, no explanation.',
      messages: [
        {
          role: 'user',
          content: `Extract key points from this content:\n\nTitle: ${title}\nDescription: ${summary}\nSource: ${sourceUrl}\nCategories: ${item.aiCategories.join(', ')}`,
        },
      ],
    });

    const parsed = JSON.parse(result.text);
    if (Array.isArray(parsed)) {
      keyPoints = parsed.map((p: unknown) => String(p));
    }
  } catch (err) {
    logger.debug({ err }, 'AI key point extraction unavailable, using fallback');
    // Fallback: split description into bullet points
    if (summary) {
      keyPoints = summary
        .split(/[.!?]\s+/)
        .filter((s) => s.trim().length > 10)
        .slice(0, 5)
        .map((s) => s.trim());
    }
  }

  if (keyPoints.length === 0 && summary) {
    keyPoints = [summary.slice(0, 200)];
  }

  return {
    title,
    sourceUrl,
    sourcePlatform: item.sourcePlatform,
    category,
    tags,
    summary,
    keyPoints,
    capturedAt,
  };
}

function renderMarkdown(note: NoteContent): string {
  const tagsYaml = note.tags.map((t) => `"${t}"`).join(', ');
  const keyPointsList = note.keyPoints.map((p) => `- ${p}`).join('\n');

  return `---
title: "${note.title.replace(/"/g, '\\"')}"
source: "${note.sourceUrl}"
captured: "${note.capturedAt.split('T')[0]}"
tags: [${tagsYaml}]
category: "${note.category}"
---

# ${note.title}

> Source: [${note.sourcePlatform}](${note.sourceUrl})

## Summary

${note.summary || 'No summary available.'}

## Key Points

${keyPointsList || '- No key points extracted.'}

## References

- [${note.sourceUrl}](${note.sourceUrl})
`;
}

// ─── File Writers ─────────────────────────────────────────────────────────────

async function writeToGitHub(
  repo: string,
  filePath: string,
  content: string,
  commitMessage: string,
): Promise<{ success: boolean; fileUrl?: string; error?: string }> {
  const credentials = await resolveGitHubCredentials();
  if (!credentials) {
    return { success: false, error: 'No GitHub credentials configured' };
  }

  const contentBase64 = Buffer.from(content).toString('base64');

  // Check if file already exists (to get SHA for update)
  let existingSha: string | undefined;
  try {
    const checkRes = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
      headers: {
        Authorization: `token ${credentials.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (checkRes.ok) {
      const data = (await checkRes.json()) as { sha?: string };
      existingSha = data.sha;
    }
  } catch {
    // File doesn't exist, that's fine
  }

  const payload: Record<string, string> = {
    message: commitMessage,
    content: contentBase64,
  };
  if (existingSha) {
    payload.sha = existingSha;
  }

  const res = await fetch(`https://api.github.com/repos/${repo}/contents/${filePath}`, {
    method: 'PUT',
    headers: {
      Authorization: `token ${credentials.token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const errorBody = await res.text().catch(() => '');
    logger.error({ status: res.status, body: errorBody, repo, filePath }, 'GitHub file creation failed');
    return { success: false, error: `GitHub API error ${res.status}: ${errorBody}` };
  }

  const data = (await res.json()) as { content?: { html_url?: string } };
  const fileUrl = data.content?.html_url || `https://github.com/${repo}/blob/main/${filePath}`;

  return { success: true, fileUrl };
}

async function writeToLocalFilesystem(
  basePath: string,
  filePath: string,
  content: string,
): Promise<{ success: boolean; fullPath?: string; error?: string }> {
  // Dynamic import for Node.js fs/path (works in Next.js server context)
  const { writeFile, mkdir } = await import('fs/promises');
  const { join, dirname } = await import('path');

  const fullPath = join(basePath, filePath);
  const dir = dirname(fullPath);

  try {
    await mkdir(dir, { recursive: true });
    await writeFile(fullPath, content, 'utf-8');
    return { success: true, fullPath };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, fullPath }, 'Failed to write knowledge base file locally');
    return { success: false, error: `Failed to write file: ${message}` };
  }
}

// ─── Main Export ─────────────────────────────────────────────────────────────

export async function saveToKnowledgeBase(
  item: TriageItem,
  options: KnowledgeBaseOptions = {},
): Promise<KnowledgeBaseResult> {
  const repo = process.env.MC_KNOWLEDGE_REPO;
  const localPath = process.env.MC_KNOWLEDGE_PATH;

  if (!repo && !localPath) {
    return {
      success: false,
      error: 'Knowledge base not configured. Set MC_KNOWLEDGE_REPO or MC_KNOWLEDGE_PATH.',
    };
  }

  const category = resolveCategory(item, options.category);
  const note = await generateNoteContent(item, category, options.title);
  const slug = slugify(note.title);
  const filePath = options.path || `${category}/${slug}.md`;
  const markdown = renderMarkdown(note);
  const commitMessage = `docs: add knowledge base note — ${note.title}`;

  if (repo) {
    const result = await writeToGitHub(repo, filePath, markdown, commitMessage);
    if (!result.success) {
      return { success: false, error: result.error };
    }
    logger.info({ repo, filePath, fileUrl: result.fileUrl }, 'Saved triage item to knowledge base (GitHub)');
    return { success: true, filePath, fileUrl: result.fileUrl };
  }

  // Local filesystem
  const result = await writeToLocalFilesystem(localPath!, filePath, markdown);
  if (!result.success) {
    return { success: false, error: result.error };
  }
  logger.info({ localPath, filePath, fullPath: result.fullPath }, 'Saved triage item to knowledge base (local)');
  return { success: true, filePath: result.fullPath };
}

export function buildKnowledgeBaseActionRecord(result: KnowledgeBaseResult): TriageActionRecord {
  return {
    actionType: 'save_knowledge_base',
    appliedAt: new Date().toISOString(),
    note: result.fileUrl
      ? `Saved to knowledge base: ${result.fileUrl}`
      : `Saved to knowledge base: ${result.filePath}`,
    metadata: {
      filePath: result.filePath,
      fileUrl: result.fileUrl,
    },
  };
}
