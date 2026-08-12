/**
 * Paste Parser for Quick Add
 *
 * Detects and parses structured text formats commonly pasted into the Quick Add bar,
 * including markdown tables, checkbox lists, nested/indented lists, and phase-prefixed items.
 *
 * Each format is auto-detected and converted into an array of ExtractedTask objects
 * that carry optional metadata (subtask relationships, completion status, extra token syntax).
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ExtractedTask {
  /** The task text, optionally enriched with token syntax (e.g. "!high" appended from a table column). */
  text: string;
  /** Index of the parent task in the same extraction batch (for nested lists). null = top-level. */
  parentIndex: number | null;
  /** Whether the task was marked as already complete (e.g. `- [x]`). */
  isComplete: boolean;
}

export interface ExtractionResult {
  /** Tasks that are fully extracted and ready to become pending chips. */
  committed: ExtractedTask[];
  /** Text that remains in the input (typically the last unfinished line). */
  remaining: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function normalizePendingTaskText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\s+/g, ' ').trim();
}

export function stripTaskListPrefix(line: string): string {
  return line.replace(/^\s*(?:[-•*]|\d+\.)\s+/, '');
}

/** Strip "Phase N:", "Step N:", "Stage N:" etc. prefixes from a task title. */
export function stripPhasePrefix(text: string): string {
  return text.replace(/^\s*(?:phase|step|stage)\s+\d+[:.]\s*/i, '').trim();
}

/** Strip checkbox prefix `[ ]` or `[x]` and return whether it was checked. */
function stripCheckbox(line: string): { text: string; checked: boolean } | null {
  const m = line.match(/^\s*[-•*]\s+\[([ xX])\]\s+(.*)/);
  if (!m) return null;
  return { text: m[2], checked: m[1].toLowerCase() === 'x' };
}

/** Measure leading whitespace to determine indent level. */
function indentLevel(line: string): number {
  const m = line.match(/^(\s*)/);
  if (!m) return 0;
  // Normalize tabs to 2 spaces for consistency
  const raw = m[1].replace(/\t/g, '  ');
  return raw.length;
}

// ─── Markdown Table Parser ──────────────────────────────────────────────────

/** Column name aliases mapping to ParsedTask token syntax. */
const COLUMN_MAP: Record<string, string> = {
  // Title columns (value used as task text, not appended as token)
  task: 'title',
  title: 'title',
  name: 'title',
  item: 'title',
  'work item': 'title',
  description: 'title',

  // Priority
  priority: 'priority',
  pri: 'priority',
  urgency: 'priority',

  // Due date
  due: 'due',
  'due date': 'due',
  deadline: 'due',
  date: 'due',
  when: 'due',

  // Effort
  effort: 'effort',
  size: 'effort',
  estimate: 'effort',
  points: 'effort',

  // Tags
  tag: 'tag',
  tags: 'tag',
  label: 'tag',
  labels: 'tag',
  category: 'tag',

  // Project
  project: 'project',
  phase: 'project',
};

/** Map effort text labels to ^N syntax values. */
const EFFORT_LABEL_MAP: Record<string, string> = {
  xs: '^1', 'extra small': '^1', '1': '^1',
  s: '^2', small: '^2', '2': '^2',
  m: '^3', medium: '^3', '3': '^3',
  l: '^4', large: '^4', '4': '^4',
  xl: '^5', 'extra large': '^5', '5': '^5',
};

/** Map priority text labels to !level syntax. */
const PRIORITY_LABEL_MAP: Record<string, string> = {
  critical: '!critical', '0': '!critical', p0: '!critical',
  high: '!high', '1': '!high', p1: '!high',
  medium: '!medium', '2': '!medium', p2: '!medium', med: '!medium',
  low: '!low', '3': '!low', p3: '!low',
};

function isTableSeparator(line: string): boolean {
  // Matches lines like |---|---|---| or |:---:|:---|
  return /^\s*\|(\s*:?-+:?\s*\|)+\s*$/.test(line);
}

function parseTableRow(line: string): string[] {
  // Split on | but ignore leading/trailing pipes
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function detectMarkdownTable(lines: string[]): {
  headerLine: number;
  separatorLine: number;
  headers: string[];
} | null {
  for (let i = 0; i < lines.length - 1; i++) {
    if (isTableSeparator(lines[i + 1]) && lines[i].includes('|')) {
      const headers = parseTableRow(lines[i]);
      if (headers.length >= 2) {
        return { headerLine: i, separatorLine: i + 1, headers };
      }
    }
  }
  return null;
}

function extractFromTable(lines: string[]): ExtractionResult | null {
  const table = detectMarkdownTable(lines);
  if (!table) return null;

  // Map header names to field types
  const columnTypes: (string | null)[] = table.headers.map(h => {
    const key = h.toLowerCase().replace(/[*_`#]/g, '').trim();
    return COLUMN_MAP[key] || null;
  });

  // Must have at least a title column
  const titleIndex = columnTypes.indexOf('title');
  if (titleIndex === -1) return null;

  const committed: ExtractedTask[] = [];
  let lastDataLine = table.separatorLine;

  for (let i = table.separatorLine + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || !line.includes('|')) break; // End of table
    lastDataLine = i;

    const cells = parseTableRow(line);
    if (cells.length === 0) break;

    // Skip rows that look like separator duplicates or are empty
    if (isTableSeparator(line)) continue;

    const titleCell = cells[titleIndex] || '';
    if (!titleCell.trim()) continue;

    // Start with the title, then append tokens from other columns
    let taskText = titleCell.trim();

    for (let c = 0; c < cells.length; c++) {
      if (c === titleIndex || !columnTypes[c]) continue;
      const cellValue = cells[c]?.trim();
      if (!cellValue || cellValue === '-' || cellValue === 'N/A' || cellValue === 'n/a') continue;

      const fieldType = columnTypes[c];
      switch (fieldType) {
        case 'priority': {
          const mapped = PRIORITY_LABEL_MAP[cellValue.toLowerCase()];
          if (mapped) taskText += ` ${mapped}`;
          break;
        }
        case 'due':
          // Append raw date text — parseTaskInput will pick it up
          taskText += ` ${cellValue}`;
          break;
        case 'effort': {
          const mapped = EFFORT_LABEL_MAP[cellValue.toLowerCase()];
          if (mapped) taskText += ` ${mapped}`;
          break;
        }
        case 'tag': {
          // Split on commas/spaces and add # prefix
          const tags = cellValue.split(/[,;\s]+/).filter(Boolean);
          for (const tag of tags) {
            const clean = tag.replace(/^#/, '');
            if (clean) taskText += ` #${clean}`;
          }
          break;
        }
        case 'project': {
          const clean = cellValue.replace(/^\//, '');
          if (clean) taskText += ` /${clean}`;
          break;
        }
      }
    }

    committed.push({
      text: stripPhasePrefix(normalizePendingTaskText(taskText)),
      parentIndex: null,
      isComplete: false,
    });
  }

  if (committed.length === 0) return null;

  // Check for any text before/after the table
  const preTableLines = lines.slice(0, table.headerLine).filter(l => l.trim());
  const postTableLines = lines.slice(lastDataLine + 1).filter(l => l.trim());
  const remaining = [...preTableLines, ...postTableLines].join('\n').trim();

  return { committed, remaining };
}

// ─── Checkbox List Parser ───────────────────────────────────────────────────

function isCheckboxList(lines: string[]): boolean {
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length === 0) return false;
  return nonEmpty.every(l => /^\s*[-•*]\s+\[[ xX]\]\s+/.test(l));
}

function extractFromCheckboxList(lines: string[]): ExtractionResult | null {
  const nonEmpty = lines.filter(l => l.trim());
  if (!isCheckboxList(nonEmpty)) return null;

  const committed: ExtractedTask[] = [];

  for (const line of nonEmpty) {
    const parsed = stripCheckbox(line);
    if (!parsed) continue;
    const text = stripPhasePrefix(normalizePendingTaskText(stripTaskListPrefix(parsed.text)));
    if (!text) continue;
    committed.push({
      text,
      parentIndex: null,
      isComplete: parsed.checked,
    });
  }

  if (committed.length === 0) return null;
  return { committed, remaining: '' };
}

// ─── Nested List Parser ─────────────────────────────────────────────────────

function isListLine(line: string): boolean {
  return /^\s*(?:[-•*]|\d+\.)\s+/.test(line);
}

function extractFromNestedList(lines: string[]): ExtractionResult | null {
  const nonEmpty = lines.filter(l => l.trim());
  if (nonEmpty.length < 2) return null;

  // Need at least some list lines
  const listLineCount = nonEmpty.filter(isListLine).length;
  if (listLineCount < nonEmpty.length * 0.5) return null;

  // Determine indent levels
  const lineInfos = nonEmpty.map(line => {
    const checkbox = stripCheckbox(line);
    const indent = indentLevel(line);
    const stripped = stripTaskListPrefix(line);
    return {
      raw: line,
      indent,
      text: checkbox ? checkbox.text : stripped,
      isComplete: checkbox ? checkbox.checked : false,
      isList: isListLine(line),
    };
  });

  // Find distinct indent levels to determine what counts as "child"
  const indents = [...new Set(lineInfos.filter(l => l.isList).map(l => l.indent))].sort((a, b) => a - b);
  const baseIndent = indents[0] ?? 0;

  // If all same indent level, this is a flat list not a nested one — let other parsers handle it
  if (indents.length < 2) return null;

  const committed: ExtractedTask[] = [];
  let lastParentIndex: number | null = null;

  for (const info of lineInfos) {
    const text = stripPhasePrefix(normalizePendingTaskText(info.text));
    if (!text) continue;

    const isChild = info.indent > baseIndent;

    if (isChild && lastParentIndex !== null) {
      committed.push({
        text,
        parentIndex: lastParentIndex,
        isComplete: info.isComplete,
      });
    } else {
      lastParentIndex = committed.length;
      committed.push({
        text,
        parentIndex: null,
        isComplete: info.isComplete,
      });
    }
  }

  if (committed.length === 0) return null;

  // Must have at least one parent-child relationship to qualify as nested
  const hasNesting = committed.some(t => t.parentIndex !== null);
  if (!hasNesting) return null;

  return { committed, remaining: '' };
}

// ─── Compound Task Splitter (NLP "and" detection) ───────────────────────────

/**
 * Common action verbs that signal the start of a task.
 * Used to detect compound tasks joined by "and", e.g.
 * "Email Sarah about Q3 and schedule dentist for next week" → two tasks.
 */
const ACTION_VERBS = new Set([
  'buy', 'call', 'check', 'clean', 'create', 'do', 'drop', 'email',
  'file', 'find', 'finish', 'fix', 'get', 'go', 'grab', 'look',
  'make', 'message', 'move', 'order', 'organize', 'pay', 'pick',
  'plan', 'post', 'prep', 'prepare', 'print', 'put', 'read',
  'remind', 'reply', 'research', 'reserve', 'return', 'review',
  'run', 'schedule', 'send', 'set', 'setup', 'ship', 'sign',
  'sort', 'start', 'stop', 'submit', 'take', 'talk', 'tell',
  'text', 'update', 'upload', 'wash', 'watch', 'write',
  'ask', 'book', 'cancel', 'change', 'close', 'complete',
  'configure', 'confirm', 'contact', 'debug', 'delete', 'deploy',
  'design', 'discuss', 'draft', 'edit', 'explore', 'figure',
  'follow', 'forward', 'handle', 'install', 'investigate',
  'launch', 'look', 'measure', 'meet', 'migrate', 'open',
  'pack', 'paint', 'push', 'refactor', 'register', 'release',
  'remove', 'rename', 'repair', 'replace', 'respond', 'restart',
  'scan', 'share', 'test', 'transfer', 'try', 'uninstall', 'verify',
]);

/**
 * Detect compound tasks in single-line input and split them.
 *
 * Recognized patterns:
 * - "verb ... and verb ..." (e.g. "Email Sarah and call dentist")
 * - "verb ..., verb ..." (comma before a verb phrase)
 * - "verb ...; verb ..." (single semicolon between verb phrases)
 * - "verb ... then verb ..." / "verb ... also verb ..."
 *
 * Only splits when both sides start with a recognized action verb.
 * Returns null if no compound task is detected.
 */
export function splitCompoundTask(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Don't split if text already has structured formatting
  if (/\n/.test(trimmed)) return null;

  // Try splitting on connectors: " and ", " then ", " also ", "; ", ", "
  // Order matters: try more specific patterns first
  const connectors = [
    /\s+and\s+then\s+/i,
    /\s+and\s+also\s+/i,
    /\s+and\s+/i,
    /\s+then\s+/i,
    /\s+also\s+/i,
    /\s*;\s+/,
  ];

  for (const connector of connectors) {
    const parts = trimmed.split(connector);
    if (parts.length < 2) continue;

    // Check if the resulting segments each start with an action verb
    const validSegments = parts.map(s => s.trim()).filter(Boolean);
    if (validSegments.length < 2) continue;

    // First segment must start with a verb
    const firstWord = validSegments[0].split(/\s+/)[0]?.toLowerCase();
    if (!firstWord || !ACTION_VERBS.has(firstWord)) continue;

    // At least the second segment must start with a verb (subsequent splits might not)
    const allVerbLed = validSegments.slice(1).every(seg => {
      const word = seg.split(/\s+/)[0]?.toLowerCase();
      return word && ACTION_VERBS.has(word);
    });
    if (!allVerbLed) continue;

    return validSegments;
  }

  return null;
}

// ─── Main Extraction ────────────────────────────────────────────────────────

/**
 * Extract pending tasks from pasted or typed multi-format text.
 *
 * Detection order (first match wins):
 * 1. `;;` delimiter (inline multi-task shorthand)
 * 1b. Compound task NLP splitting ("verb and verb" patterns)
 * 2. Markdown table
 * 3. Checkbox list (`- [ ]` / `- [x]`)
 * 4. Nested/indented list (2-level → parent + subtask)
 * 5. Bullet/numbered list (flat)
 * 6. Plain multi-line text
 */
export function extractPendingTasks(text: string): ExtractionResult {
  const normalized = text.replace(/\r\n?/g, '\n');

  // 1. Semicolon delimiter (works in single-line or multi-line)
  if (normalized.includes(';;')) {
    const segments = normalized.split(/;;+/).map(normalizePendingTaskText).filter(Boolean);
    if (segments.length > 1) {
      return {
        committed: segments.slice(0, -1).map(s => ({
          text: stripPhasePrefix(s),
          parentIndex: null,
          isComplete: false,
        })),
        remaining: segments[segments.length - 1] ?? '',
      };
    }
  }

  // 1b. Compound task NLP splitting (single-line only, "verb and verb" patterns)
  if (!normalized.includes('\n')) {
    const compoundParts = splitCompoundTask(normalized);
    if (compoundParts && compoundParts.length >= 2) {
      return {
        committed: compoundParts.slice(0, -1).map(s => ({
          text: normalizePendingTaskText(s),
          parentIndex: null,
          isComplete: false,
        })),
        remaining: normalizePendingTaskText(compoundParts[compoundParts.length - 1] ?? ''),
      };
    }
    return { committed: [], remaining: text };
  }

  const lines = normalized.split('\n');
  const nonEmptyLines = lines.map(l => l.trim()).filter(Boolean);

  if (nonEmptyLines.length === 0) {
    return { committed: [], remaining: text };
  }

  // 2. Markdown table
  const tableResult = extractFromTable(lines);
  if (tableResult) return tableResult;

  // 3. Checkbox list
  const checkboxResult = extractFromCheckboxList(lines);
  if (checkboxResult) return checkboxResult;

  // 4. Nested list (must check before flat list)
  const nestedResult = extractFromNestedList(lines);
  if (nestedResult) return nestedResult;

  // 5. Flat bullet/numbered list (all lines are list items)
  const allBulletOrNumbered = nonEmptyLines.length > 0 &&
    nonEmptyLines.every(line => /^\s*(?:[-•*]|\d+\.)\s+/.test(line));

  if (allBulletOrNumbered) {
    return {
      committed: nonEmptyLines
        .map(line => ({
          text: stripPhasePrefix(normalizePendingTaskText(stripTaskListPrefix(line))),
          parentIndex: null,
          isComplete: false,
        }))
        .filter(t => t.text),
      remaining: '',
    };
  }

  // 6. Plain multi-line text — each line becomes a task, last line stays as remaining
  if (nonEmptyLines.length > 1) {
    return {
      committed: nonEmptyLines.slice(0, -1)
        .map(line => ({
          text: stripPhasePrefix(normalizePendingTaskText(stripTaskListPrefix(line))),
          parentIndex: null,
          isComplete: false,
        }))
        .filter(t => t.text),
      remaining: normalizePendingTaskText(
        stripTaskListPrefix(nonEmptyLines[nonEmptyLines.length - 1] ?? '')
      ),
    };
  }

  return { committed: [], remaining: text };
}
