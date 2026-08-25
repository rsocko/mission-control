/**
 * Smart Text Parser for Quick Add
 * 
 * Parses natural language task input to extract:
 * - Due dates: NLP via chrono-node – "tomorrow", "next friday", "in 3 days",
 *   "jun 25", "end of month", "aug 15 2025", "3pm tomorrow", etc.
 * - Priority: "!critical", "!high", "!medium", "!low", "!0" (critical), "!1" (high), "!2" (medium), "!3" (low)
 * - Effort: "^1" (XS), "^2" (S), "^3" (M), "^4" (L), "^5" (XL)
 * - Planning horizon: "~now", "~next", "~later", "~someday"
 * - Tags: "#tagname"
 * - Destination: "@work", "@personal", "@github"
 * - Project: "/project-name"
 * - Recurrence: "every day", "every 3 days", "weekly", "every 2 weeks",
 *               "monthly", "yearly", "weekdays", "every mon,wed,fri"
 */

import { findAllNLPDates, parseNLPDate } from './date-parser';
import type { PlanningHorizon } from '@/types';

export interface QuickAddProject {
  id: string;
  name: string;
}

export interface ParseTaskInputOptions {
  naturalLanguageDates?: boolean;
  preserveText?: boolean;
  projects?: QuickAddProject[];
  applyDateSuggestions?: boolean;
}

export interface ParsedTask {
  title: string;           // Clean title with tokens removed
  dueDate: string | null;  // ISO date string
  dueDateLabel: string | null; // Human-readable label
  priority: string | null; // critical | high | medium | low
  tags: string[];          // Tag names (without #)
  destination: string | null; // work | personal | github | null
  project: string | null;  // Project name (without +)
  projectId: string | null;
  dateSuggestion: {
    date: string;
    label: string;
    matchedText: string;
  } | null;
  estimatedDuration: number | null; // minutes, parsed from ~30m, ~1h, ~2h etc.
  effort: number | null;   // 1–5, parsed from ^1, ^2, ^3, ^4, ^5
  planningHorizon: PlanningHorizon | null;
  recurrence: string | null; // Recurrence pattern value (e.g. 'daily', 'weekly', 'every 3 days', 'weekly (monday, wednesday)')
  recurrenceLabel: string | null; // Human-readable label for the parsed recurrence
}

// nextDayOfWeek is still needed by getDateSuggestions below
function nextDayOfWeek(from: Date, dayOfWeek: number): Date {
  const d = new Date(from);
  const diff = (dayOfWeek - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff));
  return d;
}

interface RecurrenceResult {
  value: string;   // Internal value for the recurrence field (e.g. 'daily', 'every 3 days', 'weekly (monday, wednesday)')
  label: string;   // Human-readable label (e.g. 'Daily', 'Every 3 days', 'Weekly on Mon, Wed')
}

const DAY_ABBREVIATIONS: Record<string, string> = {
  mon: 'monday', monday: 'monday',
  tue: 'tuesday', tues: 'tuesday', tuesday: 'tuesday',
  wed: 'wednesday', wednesday: 'wednesday',
  thu: 'thursday', thur: 'thursday', thurs: 'thursday', thursday: 'thursday',
  fri: 'friday', friday: 'friday',
  sat: 'saturday', saturday: 'saturday',
  sun: 'sunday', sunday: 'sunday',
};

const DAY_SHORT_LABELS: Record<string, string> = {
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
};

/**
 * Escape special regex characters in a string for safe use in `new RegExp(...)`.
 */
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse recurrence patterns from natural language text.
 * Returns the matched recurrence and the text that was consumed.
 */
export function parseRecurrence(text: string): { result: RecurrenceResult; matchedText: string } | null {
  const lower = text.toLowerCase();

  // "every day" / "daily"
  const dailyMatch = lower.match(/\b(every\s+day|daily)\b/);
  if (dailyMatch) {
    return { result: { value: 'daily', label: 'Daily' }, matchedText: dailyMatch[0] };
  }

  // "weekdays" / "every weekday" / "mon-fri" / "mon–fri"
  const weekdaysMatch = lower.match(/\b(weekdays|every\s+weekday|mon[\u2013-]fri)\b/);
  if (weekdaysMatch) {
    return { result: { value: 'weekdays', label: 'Weekdays (Mon\u2013Fri)' }, matchedText: weekdaysMatch[0] };
  }

  // "every N days/weeks/months/years" (N >= 1)
  const everyNMatch = lower.match(/\bevery\s+(\d+)\s+(days?|weeks?|months?|years?)\b/);
  if (everyNMatch) {
    const n = parseInt(everyNMatch[1], 10);
    if (n < 1) return null; // reject zero/negative
    const unit = everyNMatch[2].replace(/s$/, '');
    if (n === 1) {
      const simpleMap: Record<string, RecurrenceResult> = {
        day: { value: 'daily', label: 'Daily' },
        week: { value: 'weekly', label: 'Weekly' },
        month: { value: 'monthly', label: 'Monthly' },
        year: { value: 'yearly', label: 'Yearly' },
      };
      if (simpleMap[unit]) return { result: simpleMap[unit], matchedText: everyNMatch[0] };
    }
    if (n === 2 && unit === 'week') {
      return { result: { value: 'biweekly', label: 'Every 2 weeks' }, matchedText: everyNMatch[0] };
    }
    const pluralUnit = n === 1 ? unit : unit + 's';
    return {
      result: { value: `every ${n} ${pluralUnit}`, label: `Every ${n} ${pluralUnit}` },
      matchedText: everyNMatch[0],
    };
  }

  // "every mon,wed,fri" / "every monday, wednesday" / "weekly on mon,wed,fri"
  // Also supports a single day: "every monday" / "weekly on friday"
  const dayListMatch = lower.match(/\b(?:every|weekly\s+on)\s+((?:(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s*[,&]\s*|\s+and\s+|\s+)?)+)\b/);
  if (dayListMatch) {
    const dayTokens = dayListMatch[1].split(/\s*[,&]\s*|\s+and\s+|\s+/).filter(Boolean);
    const fullDays = dayTokens
      .map(t => DAY_ABBREVIATIONS[t])
      .filter((d): d is string => !!d);
    const uniqueDays = [...new Set(fullDays)];
    if (uniqueDays.length > 0) {
      const value = `weekly (${uniqueDays.join(', ')})`;
      const label = `Weekly on ${uniqueDays.map(d => DAY_SHORT_LABELS[d]).join(', ')}`;
      return { result: { value, label }, matchedText: dayListMatch[0].trim() };
    }
  }

  // "weekly" / "every week"
  const weeklyMatch = lower.match(/\b(weekly|every\s+week)\b/);
  if (weeklyMatch) {
    return { result: { value: 'weekly', label: 'Weekly' }, matchedText: weeklyMatch[0] };
  }

  // "biweekly" / "every other week" / "every 2 weeks" (already handled above but alias here)
  const biweeklyMatch = lower.match(/\b(biweekly|every\s+other\s+week)\b/);
  if (biweeklyMatch) {
    return { result: { value: 'biweekly', label: 'Every 2 weeks' }, matchedText: biweeklyMatch[0] };
  }

  // "monthly" / "every month"
  const monthlyMatch = lower.match(/\b(monthly|every\s+month)\b/);
  if (monthlyMatch) {
    return { result: { value: 'monthly', label: 'Monthly' }, matchedText: monthlyMatch[0] };
  }

  // "yearly" / "annually" / "every year"
  const yearlyMatch = lower.match(/\b(yearly|annually|every\s+year)\b/);
  if (yearlyMatch) {
    return { result: { value: 'yearly', label: 'Yearly' }, matchedText: yearlyMatch[0] };
  }

  return null;
}

function formatDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function removeMatchedText(text: string, matchedText: string): string {
  return text.replace(new RegExp(`(?<!\\\\)${escapeRegex(matchedText)}`, 'i'), '').trim();
}

function findTrailingDate(text: string, today: Date) {
  const trimmed = text.trim();
  const matches = findAllNLPDates(trimmed, today);
  return matches.find((match) =>
    match.index + match.matchedText.length === trimmed.length
  ) ?? null;
}

function findEscapedDateRanges(text: string, today: Date) {
  const dateProbe = text.replace(/(^|\s)\\(?=\S)/g, (match) =>
    match.slice(0, -1) + ' '
  );

  return findAllNLPDates(dateProbe, today).flatMap((match) => {
    const end = match.index + match.matchedText.length;
    const escapeOffsets: number[] = [];
    for (let offset = Math.max(0, match.index - 1); offset < end; offset++) {
      if (
        text[offset] === '\\'
        && (offset === 0 || /\s/.test(text[offset - 1]))
      ) {
        escapeOffsets.push(offset);
      }
    }

    return escapeOffsets.length > 0
      ? [{ start: escapeOffsets[0], end, escapeOffsets }]
      : [];
  });
}

function maskEscapedDateExpressions(text: string, today: Date): string {
  const masked = text.split('');
  for (const range of findEscapedDateRanges(text, today)) {
    for (let offset = range.start; offset < range.end; offset++) {
      masked[offset] = '_';
    }
  }

  return masked.join('').replace(/\\(\S+)/g, (match) => '_'.repeat(match.length));
}

function stripEscapeBackslashes(text: string, today: Date): string {
  let cleaned = text.replace(/\\([#@!~^/+])/g, '$1');
  const escapedDateOffsets = findEscapedDateRanges(cleaned, today)
    .flatMap((range) => range.escapeOffsets)
    .sort((a, b) => b - a);

  for (const offset of escapedDateOffsets) {
    cleaned = cleaned.slice(0, offset) + cleaned.slice(offset + 1);
  }

  return cleaned;
}

function findProjectToken(text: string, projects: QuickAddProject[]) {
  const sortedProjects = [...projects].sort((a, b) => b.name.length - a.name.length);
  for (const project of sortedProjects) {
    const match = text.match(new RegExp(`(?:^|\\s)\\+${escapeRegex(project.name)}(?=\\s|$)`, 'i'));
    if (match) {
      return { matchedText: match[0].trim(), project };
    }
  }

  const fallback = text.match(/(?:^|\s)\+(?:"([^"]+)"|([a-zA-Z][a-zA-Z0-9_-]*))(?=\s|$)/);
  if (!fallback) return null;
  const name = fallback[1] || fallback[2];
  return {
    matchedText: fallback[0].trim(),
    project: projects.find((project) => project.name.toLowerCase() === name.toLowerCase()) ?? { id: '', name },
  };
}

export function parseTaskInput(input: string, options: ParseTaskInputOptions = {}): ParsedTask {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const naturalLanguageDates = options.naturalLanguageDates ?? true;
  const preserveText = options.preserveText ?? false;
  const applyDateSuggestions = options.applyDateSuggestions ?? false;
  let remaining = input;
  let title = input;
  let dueDate: string | null = null;
  let dueDateLabel: string | null = null;
  let priority: string | null = null;
  const foundTags: string[] = [];
  let destination: string | null = null;
  let project: string | null = null;
  let projectId: string | null = null;
  let dateSuggestion: ParsedTask['dateSuggestion'] = null;
  let estimatedDuration: number | null = null;
  let effort: number | null = null;
  let planningHorizon: PlanningHorizon | null = null;
  let recurrence: string | null = null;
  let recurrenceLabel: string | null = null;

  // Extract recurrence patterns (before date parsing to avoid conflicts with day names)
  const recurrenceResult = parseRecurrence(remaining);
  if (recurrenceResult) {
    recurrence = recurrenceResult.result.value;
    recurrenceLabel = recurrenceResult.result.label;
    remaining = removeMatchedText(remaining, recurrenceResult.matchedText);
    if (!preserveText) title = removeMatchedText(title, recurrenceResult.matchedText);
  }

  // Extract planning horizon. All recognized tokens are consumed; the last one wins.
  const horizonMatches = [...remaining.matchAll(/(?<!\\)~(now|next|later|someday)\b/gi)];
  if (horizonMatches.length > 0) {
    planningHorizon = horizonMatches[horizonMatches.length - 1][1].toLowerCase() as PlanningHorizon;
    remaining = remaining.replace(/(?<!\\)~(?:now|next|later|someday)\b/gi, '').trim();
    if (!preserveText) {
      title = title.replace(/(?<!\\)~(?:now|next|later|someday)\b/gi, '').trim();
    }
  }

  // Extract estimated duration: ~30m, ~1h, ~1.5h, ~90m, ~2h (not escaped with \)
  const durationMatch = remaining.match(/(?<!\\)~(\d+(?:\.\d+)?)\s*(m|min|mins|h|hr|hrs|hour|hours)\b/i);
  if (durationMatch) {
    const value = parseFloat(durationMatch[1]);
    const unit = durationMatch[2].toLowerCase();
    if (unit.startsWith('h')) {
      estimatedDuration = Math.round(value * 60);
    } else {
      estimatedDuration = Math.round(value);
    }
    remaining = removeMatchedText(remaining, durationMatch[0]);
    if (!preserveText) title = removeMatchedText(title, durationMatch[0]);
  }

  // Extract priority: !critical, !high, !medium, !low, !0, !1, !2, !3 (not escaped with \)
  const priorityMatch = remaining.match(/(?<!\\)!(critical|high|medium|low|[0-3])\b/i);
  if (priorityMatch) {
    const numericPriorityMap: Record<string, string> = {
      '0': 'critical',
      '1': 'high',
      '2': 'medium',
      '3': 'low',
    };
    const matched = priorityMatch[1].toLowerCase();
    priority = numericPriorityMap[matched] || matched;
    remaining = removeMatchedText(remaining, priorityMatch[0]);
    if (!preserveText) title = removeMatchedText(title, priorityMatch[0]);
  }

  // Extract effort: ^1, ^2, ^3, ^4, ^5 (not escaped with \)
  const effortMatch = remaining.match(/(?<!\\)\^([1-5])\b/);
  if (effortMatch) {
    effort = parseInt(effortMatch[1], 10);
    remaining = removeMatchedText(remaining, effortMatch[0]);
    if (!preserveText) title = removeMatchedText(title, effortMatch[0]);
  }

  // Extract tags: #tagname (not escaped with \)
  // Colons and dots are allowed so namespaced tags like "area:projects" or "v2.0" work
  const tagMatches = remaining.matchAll(/(?<!\\)#([a-zA-Z0-9_:./-]+)/g);
  for (const match of tagMatches) {
    foundTags.push(match[1]);
  }
  remaining = remaining.replace(/(?<!\\)#[a-zA-Z0-9_:./-]+/g, '').trim();
  if (!preserveText) title = title.replace(/(?<!\\)#[a-zA-Z0-9_:./-]+/g, '').trim();

  // Extract destination: @work, @personal, @github (not escaped with \)
  const destMatch = remaining.match(/(?<!\\)@(work|personal|github|todo)\b/i);
  if (destMatch) {
    destination = destMatch[1].toLowerCase();
    remaining = removeMatchedText(remaining, destMatch[0]);
    if (!preserveText) title = removeMatchedText(title, destMatch[0]);
  }

  // Extract project: +Project or +"Project with spaces"
  const projectMatch = findProjectToken(remaining, options.projects ?? []);
  if (projectMatch) {
    project = projectMatch.project.name;
    projectId = projectMatch.project.id || null;
    remaining = removeMatchedText(remaining, projectMatch.matchedText);
    if (!preserveText) title = removeMatchedText(title, projectMatch.matchedText);
  }

  // Explicit date commands are applied immediately. Free-form trailing dates are
  // suggestions so ambiguous titles are never changed without confirmation.
  const explicitDueMatch = remaining.match(/(?:^|\s)\/due:\s*(.+?)(?=\s+(?:[#@!~^+]|\w+\/)|$)/i);
  if (explicitDueMatch) {
    const explicitDate = parseNLPDate(explicitDueMatch[1], today);
    if (explicitDate) {
      dueDate = explicitDate.date;
      dueDateLabel = explicitDate.label;
      const dateExpression = explicitDueMatch[1];
      const expressionOffset = explicitDueMatch[0].lastIndexOf(dateExpression);
      const matchedCommand = explicitDueMatch[0]
        .slice(0, expressionOffset + explicitDate.index + explicitDate.matchedText.length)
        .trimStart();
      remaining = removeMatchedText(remaining, matchedCommand);
      if (!preserveText) {
        const titleWithoutDate = removeMatchedText(title, matchedCommand);
        if (titleWithoutDate) title = titleWithoutDate;
      }
    }
  } else if (naturalLanguageDates) {
    const dateInput = maskEscapedDateExpressions(remaining, today);
    const trailingDate = findTrailingDate(dateInput, today);
    if (trailingDate) {
      if (applyDateSuggestions) {
        dueDate = trailingDate.date;
        dueDateLabel = trailingDate.label;
        if (!preserveText) {
          const titleWithoutDate = title
            .replace(new RegExp(`${escapeRegex(trailingDate.matchedText)}\\s*$`, 'i'), '')
            .trim();
          if (titleWithoutDate) title = titleWithoutDate;
        }
      } else {
        dateSuggestion = {
          date: trailingDate.date,
          label: trailingDate.label,
          matchedText: trailingDate.matchedText,
        };
      }
    }
  }

  // Strip escape backslashes from the title.
  // Users can prefix token-triggering characters with \ to prevent detection
  // (e.g. \#tag becomes #tag in the title, \friday becomes friday).
  title = stripEscapeBackslashes(title, today);
  title = title.replace(/\s{2,}/g, ' ').trim();

  return {
    title,
    dueDate,
    dueDateLabel,
    priority,
    tags: foundTags,
    destination,
    project,
    projectId,
    dateSuggestion,
    estimatedDuration,
    effort,
    planningHorizon,
    recurrence,
    recurrenceLabel,
  };
}

export function parseTaskInputForSubmission(
  input: string,
  options: ParseTaskInputOptions = {},
): ParsedTask {
  return parseTaskInput(input, { ...options, applyDateSuggestions: true });
}

/**
 * Extract a due date from free-form text (title, description, shared text).
 * Unlike parseTaskInput, this doesn't strip tokens — it only looks for date phrases.
 * Uses chrono-node for NLP parsing, supporting rich phrases like
 * "next Friday", "end of month", "aug 15", "in 3 days", etc.
 */
export function parseDateFromText(text: string): { dueDate: string; dueDateLabel: string } | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const result = parseNLPDate(text, today);
  if (!result) return null;
  return { dueDate: result.date, dueDateLabel: result.label };
}

// Date suggestions for the dropdown
export function getDateSuggestions(): Array<{ label: string; value: string; computed: string }> {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const nextMonday = nextDayOfWeek(today, 1);
  const friday = nextDayOfWeek(today, 5);

  const fmt = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

  return [
    { label: 'Today', value: formatDate(today), computed: fmt(today) },
    { label: 'Tomorrow', value: formatDate(tomorrow), computed: fmt(tomorrow) },
    { label: 'Next Monday', value: formatDate(nextMonday), computed: fmt(nextMonday) },
    { label: 'Friday', value: formatDate(friday), computed: fmt(friday) },
    { label: 'No due date', value: '', computed: '' },
  ];
}
