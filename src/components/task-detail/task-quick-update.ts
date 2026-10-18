import { parseNLPDate } from '@/lib/date-parser';

export interface QuickUpdateSuggestion {
  dueDate: string | null;
  dueDateLabel: string | null;
  subtaskTitle: string | null;
}

const FOLLOW_UP_CUE = /\b(?:follow up|check back|call again|email again|try again|contact again|check whether|check if|verify|confirm)\b/i;

function formatLocalTimestamp(date: Date): string {
  const datePart = [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
  const timePart = [
    String(date.getHours()).padStart(2, '0'),
    String(date.getMinutes()).padStart(2, '0'),
  ].join(':');
  return `${datePart} ${timePart}`;
}

function capitalizeSentence(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function inferSubtaskTitle(text: string, matchedDate?: string): string | null {
  for (const segment of text.split(/[.;\n]+/)) {
    const cue = segment.match(FOLLOW_UP_CUE);
    if (!cue || cue.index === undefined) continue;
    let title = segment.slice(cue.index).trim();
    if (matchedDate) {
      title = title.replace(new RegExp(`\\b${matchedDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'), '');
    }
    title = title.replace(/\s+/g, ' ').replace(/[\s,;:.-]+$/, '').trim();
    return title ? capitalizeSentence(title) : null;
  }
  return null;
}

export function inferQuickUpdate(text: string, referenceDate = new Date()): QuickUpdateSuggestion {
  const parsedDate = parseNLPDate(text, referenceDate);
  return {
    dueDate: parsedDate?.date ?? null,
    dueDateLabel: parsedDate?.label ?? null,
    subtaskTitle: inferSubtaskTitle(text, parsedDate?.matchedText),
  };
}

export function appendQuickUpdate(
  description: string | null,
  update: string,
  occurredAt = new Date(),
): string {
  const entry = `- **${formatLocalTimestamp(occurredAt)}** — ${update.trim()}`;
  const existing = description?.trim() ?? '';
  if (!existing) return `## Updates\n\n${entry}`;

  const updatesHeading = /^## Updates[ \t]*$/m;
  const match = updatesHeading.exec(existing);
  if (!match) return `${existing}\n\n## Updates\n\n${entry}`;

  const insertAt = match.index + match[0].length;
  const remainder = existing.slice(insertAt).trimStart();
  return `${existing.slice(0, insertAt)}\n\n${entry}${remainder ? `\n\n${remainder}` : ''}`;
}
