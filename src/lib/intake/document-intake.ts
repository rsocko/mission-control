/**
 * Document Intake Service
 *
 * Parses structured audit/planning documents and orchestrates creation of
 * GitHub issues, MC projects, phases, tags, and task assignments.
 *
 * Used by:
 * - POST /api/ai/intake-document (API endpoint)
 * - scripts/audit-to-project.ts (CLI)
 * - Future MCP tool: mc_intake_document
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Finding = {
  id: string;
  area: string;
  issue: string;
  impact: string;
  suggestedFix: string;
  effort: string;
  priorityOrder: number;
  priorityTitle: string;
  priorityLabel: string;
  /** GitHub issue numbers referenced in this finding (e.g. [865, 900]) — indicates existing issues */
  linkedIssueNumbers: number[];
};

export type PhaseDefinition = {
  name: string;
  description: string;
  estimatedDays: number | null;
  sortOrder: number;
  findingIds: string[];
};

export type PriorityGroup = {
  order: number;
  title: string;
  label: string;
  findingIds: string[];
};

export type ParsedDocument = {
  title: string | null;
  findings: Finding[];
  phases: PhaseDefinition[];
  priorityGroups: PriorityGroup[];
};

export type IntakeConfig = {
  mcUrl: string;
  repo: string;
  dryRun: boolean;
  projectName?: string;
  projectColor?: string;
  category?: string;
  /** Finding IDs to skip during execution */
  skipFindingIds?: string[];
  /** Optional override list of tags to create/use for this intake */
  tags?: string[];
  /** When provided, phases and tasks are appended to this existing project instead of creating a new one */
  existingProjectId?: string;
  /** Cancels document parsing before mutation work begins. */
  signal?: AbortSignal;
  /** Reuses a document parsed under the route's bounded processing phase. */
  parsedDocument?: ParsedDocument;
};

export type CreatedIssue = {
  findingId: string;
  title: string;
  issueNumber: number | null;
  htmlUrl: string | null;
  /** Whether this issue was linked to an existing task rather than newly created */
  linkedExisting?: boolean;
};

export type CreatedPhase = PhaseDefinition & { id: string };

export type TaskAssignment = {
  findingId: string;
  issueNumber: number | null;
  taskId: string | null;
  phaseId: string | null;
  phaseName: string | null;
  status: 'assigned' | 'missing-task' | 'skipped';
};

export type IntakeResult = {
  dryRun: boolean;
  document: ParsedDocument;
  projectId: string | null;
  /** True when phases/tasks were appended to an existing project rather than creating a new one */
  appendedToExisting: boolean;
  phases: CreatedPhase[];
  issues: CreatedIssue[];
  assignments: TaskAssignment[];
  tags: string[];
  errors: string[];
};

export type IntakePreview = {
  document: ParsedDocument;
  proposedProjectName: string;
  proposedPhases: PhaseDefinition[];
  proposedIssueCount: number;
  proposedTags: string[];
};

// ─── Parser ─────────────────────────────────────────────────────────────────

function normalizeHeader(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitMarkdownRow(row: string) {
  return row
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim());
}

function isSeparatorRow(cells: string[]) {
  return cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

function parseEstimatedDays(value: string): number | null {
  const rangeMatch = value.match(/(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*(day|week)/i);
  if (rangeMatch) {
    const avg = (Number(rangeMatch[1]) + Number(rangeMatch[2])) / 2;
    return rangeMatch[3].toLowerCase().startsWith('week') ? Math.round(avg * 5) : Math.round(avg);
  }
  const singleMatch = value.match(/(\d+(?:\.\d+)?)\s*(day|week)/i);
  if (!singleMatch) return null;
  const amount = Number(singleMatch[1]);
  return singleMatch[2].toLowerCase().startsWith('week') ? Math.round(amount * 5) : Math.round(amount);
}

function extractFindingIds(value: string): string[] {
  return Array.from(new Set(value.match(/[A-Z]{2,}-\d+/g) ?? []));
}

/** Extract GitHub issue numbers (#NNN) from text */
function extractIssueNumbers(value: string): number[] {
  const matches = Array.from(value.matchAll(/#(\d+)/g), m => Number(m[1]));
  return Array.from(new Set(matches));
}

function stripMarkdownFormatting(value: string) {
  return value.replace(/\*\*/g, '').replace(/`/g, '').replace(/[–—]/g, '-').trim();
}

/**
 * Parse a structured audit/findings Markdown document.
 * Expects:
 * - Sections: `## Priority N: Title` with markdown tables (ID, Area, Issue, Impact, Suggested Fix, Effort)
 * - Section: `## Recommended Fix Order` with numbered phases containing finding IDs
 */
export function parseDocument(content: string): ParsedDocument {
  return runParserSync(parseDocumentGenerator(content));
}

export async function parseDocumentAsync(
  content: string,
  signal?: AbortSignal,
): Promise<ParsedDocument> {
  return runParserAsync(parseDocumentGenerator(content), signal);
}

function* parseDocumentGenerator(
  content: string,
): Generator<void, ParsedDocument, void> {
  const lines = content.split(/\r?\n/);
  const findings: Finding[] = [];
  const priorityGroups: PriorityGroup[] = [];
  const titleMatch = content.match(/^#\s+(.+)$/m);
  let currentPriority: { order: number; title: string; label: string } | null = null;

  for (let index = 0; index < lines.length; index++) {
    if ((index & 255) === 0) yield;
    const line = lines[index].trim();
    const priorityMatch = line.match(/^##\s+Priority\s+(\d+):\s*(.+)$/i);
    if (priorityMatch) {
      const order = Number(priorityMatch[1]);
      const title = priorityMatch[2].trim();
      currentPriority = { order, title, label: `Priority ${order}: ${title}` };
      continue;
    }

    if (!currentPriority || !line.startsWith('|')) continue;

    const tableLines: string[] = [];
    while (index < lines.length && lines[index].trim().startsWith('|')) {
      if ((tableLines.length & 255) === 0) yield;
      tableLines.push(lines[index].trim());
      index++;
    }
    index--;

    if (tableLines.length < 2) continue;

    const headers = splitMarkdownRow(tableLines[0]).map(normalizeHeader);
    const headerIndex = {
      id: headers.indexOf('id'),
      area: headers.indexOf('area'),
      issue: headers.indexOf('issue'),
      impact: headers.indexOf('impact'),
      suggestedFix: headers.indexOf('suggested fix'),
      effort: headers.indexOf('effort'),
    };

    if (Object.values(headerIndex).some(v => v < 0)) continue;

    const groupFindingIds: string[] = [];
    for (const [rowIndex, row] of tableLines.slice(1).entries()) {
      if ((rowIndex & 255) === 0) yield;
      const cells = splitMarkdownRow(row);
      if (isSeparatorRow(cells)) continue;

      const finding: Finding = {
        id: cells[headerIndex.id] ?? '',
        area: cells[headerIndex.area] ?? '',
        issue: cells[headerIndex.issue] ?? '',
        impact: cells[headerIndex.impact] ?? '',
        suggestedFix: cells[headerIndex.suggestedFix] ?? '',
        effort: cells[headerIndex.effort] ?? '',
        priorityOrder: currentPriority.order,
        priorityTitle: currentPriority.title,
        priorityLabel: currentPriority.label,
        linkedIssueNumbers: extractIssueNumbers(cells[headerIndex.issue] ?? ''),
      };

      if (!finding.id) continue;
      findings.push(finding);
      groupFindingIds.push(finding.id);
    }

    if (groupFindingIds.length > 0) {
      priorityGroups.push({
        order: currentPriority.order,
        title: currentPriority.title,
        label: currentPriority.label,
        findingIds: groupFindingIds,
      });
    }
  }

  // Parse phases from "Recommended Fix Order"
  const phases: PhaseDefinition[] = [];
  const fixOrderIndex = lines.findIndex(l => /^##\s+Recommended Fix Order\s*$/i.test(l.trim()));
  if (fixOrderIndex >= 0) {
    let currentPhase: PhaseDefinition | null = null;

    const flushPhase = () => {
      if (!currentPhase) return;
      currentPhase.description = currentPhase.description.trim();
      currentPhase.findingIds = Array.from(new Set(currentPhase.findingIds));
      phases.push(currentPhase);
    };

    for (let index = fixOrderIndex + 1; index < lines.length; index++) {
      if ((index & 255) === 0) yield;
      const line = lines[index].trim();
      if (/^##\s+/.test(line) && !/^##\s+Recommended Fix Order\s*$/i.test(line)) break;

      const phaseMatch = line.match(/^\d+\.\s+\*\*(.+?)\*\*\s*(?:\(([^)]*)\))?\s*$/);
      if (phaseMatch) {
        flushPhase();
        currentPhase = {
          name: stripMarkdownFormatting(phaseMatch[1]),
          description: '',
          estimatedDays: null,
          sortOrder: phases.length,
          findingIds: extractFindingIds(phaseMatch[2] ?? ''),
        };
        continue;
      }

      if (!currentPhase || !line) continue;

      const bulletMatch = line.match(/^[-*]\s+(.*)$/);
      const value = stripMarkdownFormatting((bulletMatch?.[1] ?? line).trim());
      if (!value) continue;

      if (/^Estimated effort:/i.test(value)) {
        currentPhase.estimatedDays = parseEstimatedDays(value);
        continue;
      }

      currentPhase.findingIds.push(...extractFindingIds(value));
      currentPhase.description = currentPhase.description
        ? `${currentPhase.description}\n- ${value}`
        : `- ${value}`;
    }

    flushPhase();
  }

  // If the audit-format parser found nothing, try the project-planning format
  if (findings.length === 0 && phases.length === 0) {
    const projectResult = yield* parseProjectPlanningDocument(content, lines, titleMatch);
    if (projectResult.findings.length > 0) return projectResult;

    // Try generic list parser (bullet/numbered lists without phase structure)
    const listResult = yield* parseGenericListDocument(content, lines, titleMatch);
    if (listResult.findings.length > 0) return listResult;
  }

  return { title: titleMatch?.[1]?.trim() ?? null, findings, phases, priorityGroups };
}

/**
 * Fallback parser for project planning documents that use:
 * - `### Phase N — Name` or `## Phase N: Name` style headers
 * - `- [ ]` / `- [x]` checklist items as individual work items (findings)
 * - `#NNN` GitHub issue references
 * - Optional `**Estimated Effort:**` and `**Dependencies:**` metadata
 * - Optional priority markers like `🟠 P1`, `🔴 P0` in the project title
 */
function* parseProjectPlanningDocument(
  content: string,
  lines: string[],
  titleMatch: RegExpMatchArray | null,
): Generator<void, ParsedDocument, void> {
  const findings: Finding[] = [];
  const phases: PhaseDefinition[] = [];
  const priorityGroups: PriorityGroup[] = [];

  // Extract project title — prioritize explicit `Project N: Name` patterns, then fall back to first header
  const projectTitleMatch = content.match(/^#{1,3}\s+Project\s+\d+:\s*(.+)$/m)
    ?? content.match(/^Project\s+\d+:\s*(.+)$/m)
    ?? content.match(/^#{1,3}\s+(.+)$/m);
  const rawTitle = projectTitleMatch?.[1]?.trim() ?? titleMatch?.[1]?.trim() ?? null;
  // Strip emoji and priority markers from the title for cleanliness
  const title = rawTitle
    ?.replace(/\s*[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{26AA}\u{1F535}]\s*P\d+\s*$/u, '')
    .replace(/\s+$/, '')
    .trim() ?? rawTitle;

  // Detect overall priority from markers like 🟠 P1
  const priorityMarkerMatch = content.match(/[\u{1F534}\u{1F7E0}\u{1F7E1}\u{1F7E2}\u{26AA}\u{1F535}]\s*P(\d+)/u);
  const overallPriority = priorityMarkerMatch ? Number(priorityMarkerMatch[1]) : 1;

  // Extract global issue refs from **Issues:** line
  const issuesLineMatch = content.match(/\*\*Issues?:\*\*\s*(.+)/i);
  const globalIssueRefs = issuesLineMatch
    ? Array.from(issuesLineMatch[1].matchAll(/#(\d+)/g), m => m[1])
    : [];

  // Parse estimated effort from **Estimated Effort:** line
  const effortMatch = content.match(/\*\*Estimated\s+Effort:\*\*\s*(.+)/i);
  const globalEffort = effortMatch ? effortMatch[1].trim() : '';

  let currentPhase: {
    name: string;
    description: string;
    estimatedDays: number | null;
    sortOrder: number;
    findingIds: string[];
    items: string[];
  } | null = null;

  let findingCounter = 0;

  const flushPhase = function* (): Generator<void, void, void> {
    if (!currentPhase) return;

    // Convert collected items into findings
    for (const [index, item] of currentPhase.items.entries()) {
      if ((index & 255) === 0) yield;
      findingCounter++;
      const id = `F-${findingCounter}`;

      // Extract issue refs from the item text
      const itemIssueRefs = Array.from(item.matchAll(/#(\d+)/g), m => m[1]);
      const issueRefNote = itemIssueRefs.length > 0
        ? ` (${itemIssueRefs.map(r => `#${r}`).join(', ')})`
        : '';

      findings.push({
        id,
        area: currentPhase.name,
        issue: item,
        impact: '',
        suggestedFix: issueRefNote ? `See issue${issueRefNote}` : '',
        effort: globalEffort,
        priorityOrder: overallPriority,
        priorityTitle: title ?? 'Project',
        priorityLabel: `Priority ${overallPriority}`,
        linkedIssueNumbers: itemIssueRefs.map(Number),
      });

      currentPhase.findingIds.push(id);
    }

    if (currentPhase.findingIds.length > 0 || currentPhase.description) {
      phases.push({
        name: currentPhase.name,
        description: currentPhase.description.trim(),
        estimatedDays: currentPhase.estimatedDays,
        sortOrder: currentPhase.sortOrder,
        findingIds: currentPhase.findingIds,
      });
    }
  };

  for (let index = 0; index < lines.length; index++) {
    if ((index & 255) === 0) yield;
    const line = lines[index].trim();

    // Detect phase headers: `### Phase N — Name`, `### Phase N: Name`, `## Phase N — Name`
    // Also handles alphanumeric phase ids like `Phase 4A`, `Phase 4B`, etc.
    const phaseMatch = line.match(
      /^#{2,3}\s+Phase\s+(\d+[A-Za-z]?)\s*[-–—:]\s*(.+)$/i,
    );
    if (phaseMatch) {
      yield* flushPhase();
      const phaseName = phaseMatch[2]
        .replace(/\s*\([^)]*\)\s*$/, '') // strip trailing parenthetical like (MVP)
        .trim();
      const phaseNameWithSuffix = phaseMatch[2].trim();

      currentPhase = {
        name: phaseNameWithSuffix,
        description: '',
        estimatedDays: null,
        sortOrder: phases.length,
        findingIds: [],
        items: [],
      };
      continue;
    }

    // Checklist items: `- [ ] Task description` or `- [x] Completed task`
    if (currentPhase) {
      const checklistMatch = line.match(/^-\s+\[[ x]\]\s+(.+)$/i);
      if (checklistMatch) {
        currentPhase.items.push(checklistMatch[1].trim());
        continue;
      }

      // Regular bullet items under a phase (non-checklist)
      const bulletMatch = line.match(/^[-*]\s+(.+)$/);
      if (bulletMatch && !line.startsWith('**')) {
        currentPhase.items.push(bulletMatch[1].trim());
        continue;
      }
    }

    // Stop collecting on next ## header (but not ###)
    if (/^##\s+/.test(line) && !/^###/.test(line) && currentPhase) {
      yield* flushPhase();
      currentPhase = null;
    }
  }

  // Flush the last phase
  yield* flushPhase();

  // Build priority groups from all findings
  if (findings.length > 0) {
    const findingIds: string[] = [];
    for (const [index, finding] of findings.entries()) {
      if ((index & 255) === 0) yield;
      findingIds.push(finding.id);
    }
    priorityGroups.push({
      order: overallPriority,
      title: title ?? 'Project',
      label: `Priority ${overallPriority}`,
      findingIds,
    });
  }

  return { title, findings, phases, priorityGroups };
}

/**
 * Generic list parser for documents that are just bullet lists, numbered lists,
 * or checklists without any phase/priority structure.
 * Handles:
 * - `- item` / `* item` / `- [ ] item` / `- [x] item`
 * - `1. item` / `2. item` numbered lists
 * - Sections under `##` or `###` headers (used as area grouping)
 */
function* parseGenericListDocument(
  content: string,
  lines: string[],
  titleMatch: RegExpMatchArray | null,
): Generator<void, ParsedDocument, void> {
  const findings: Finding[] = [];
  const priorityGroups: PriorityGroup[] = [];

  const title = titleMatch?.[1]?.trim() ?? null;
  let currentSection = title ?? 'General';
  let findingCounter = 0;

  for (const [index, line] of lines.entries()) {
    if ((index & 255) === 0) yield;
    const trimmed = line.trim();

    // Track section headers for area grouping
    const headerMatch = trimmed.match(/^#{1,4}\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].replace(/\*\*/g, '').trim();
      continue;
    }

    // Match bullet items: - item, * item, - [ ] item, - [x] item
    const bulletMatch = trimmed.match(/^[-*]\s+(?:\[[ x]\]\s+)?(.+)$/i);
    // Match numbered items: 1. item, 2) item
    const numberedMatch = !bulletMatch ? trimmed.match(/^\d+[.)]\s+(.+)$/) : null;

    const itemText = bulletMatch?.[1] ?? numberedMatch?.[1];
    if (!itemText) continue;

    // Skip metadata-like lines
    if (/^\*\*(Why|Issues?|Estimated|Dependencies|Notes?):/i.test(itemText)) continue;
    if (/^(Why|Issues?|Estimated|Dependencies|Notes?):/i.test(itemText)) continue;

    findingCounter++;
    const id = `F-${findingCounter}`;

    // Extract issue refs
    const issueRefs = Array.from(itemText.matchAll(/#(\d+)/g), m => m[1]);
    const suggestedFix = issueRefs.length > 0
      ? `See issue${issueRefs.length > 1 ? 's' : ''} ${issueRefs.map(r => `#${r}`).join(', ')}`
      : '';

    findings.push({
      id,
      area: currentSection,
      issue: itemText.trim(),
      impact: '',
      suggestedFix,
      effort: '',
      priorityOrder: 1,
      priorityTitle: title ?? 'Document',
      priorityLabel: 'Priority 1',
      linkedIssueNumbers: issueRefs.map(Number),
    });
  }

  if (findings.length > 0) {
    const findingIds: string[] = [];
    for (const [index, finding] of findings.entries()) {
      if ((index & 255) === 0) yield;
      findingIds.push(finding.id);
    }
    priorityGroups.push({
      order: 1,
      title: title ?? 'Document',
      label: 'Priority 1',
      findingIds,
    });
  }

  // Group findings into phases by area (section)
  const phases: PhaseDefinition[] = [];
  const areaOrder: string[] = [];
  const areaFindings = new Map<string, string[]>();

  for (const [index, f] of findings.entries()) {
    if ((index & 255) === 0) yield;
    if (!areaFindings.has(f.area)) {
      areaOrder.push(f.area);
      areaFindings.set(f.area, []);
    }
    areaFindings.get(f.area)!.push(f.id);
  }

  for (let idx = 0; idx < areaOrder.length; idx++) {
    if ((idx & 255) === 0) yield;
    const area = areaOrder[idx];
    phases.push({
      name: area,
      description: '',
      estimatedDays: null,
      sortOrder: idx,
      findingIds: areaFindings.get(area) ?? [],
    });
  }

  return { title, findings, phases, priorityGroups };
}

function runParserSync(
  parser: Generator<void, ParsedDocument, void>,
): ParsedDocument {
  let step = parser.next();
  while (!step.done) step = parser.next();
  return step.value;
}

async function runParserAsync(
  parser: Generator<void, ParsedDocument, void>,
  signal?: AbortSignal,
): Promise<ParsedDocument> {
  signal?.throwIfAborted();
  let step = parser.next();
  while (!step.done) {
    await new Promise(resolve => setImmediate(resolve));
    signal?.throwIfAborted();
    step = parser.next();
  }
  return step.value;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

export function getProjectName(doc: ParsedDocument, customName?: string): string {
  if (customName) return customName;
  if (!doc.title) {
    return 'Untitled Project';
  }
  // Only append "Remediation" if the title looks like an audit document
  const lower = doc.title.toLowerCase();
  const isAuditDoc = lower.includes('audit') || lower.includes('findings');
  if (isAuditDoc && !lower.includes('remediation')) {
    return `${doc.title} Remediation`;
  }
  return doc.title;
}

export function getProposedTags(findings: Finding[]): string[] {
  const tagSet = new Set<string>();
  for (const f of findings) {
    tagSet.add(`Priority ${f.priorityOrder}`);
    if (f.effort) tagSet.add(`Effort ${f.effort}`);
    if (f.area) tagSet.add(`Area: ${f.area}`);
  }
  return Array.from(tagSet);
}

function sanitizeTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(tag);
  }
  return normalized;
}

function applyIntakeTweaks(
  document: ParsedDocument,
  config: Pick<IntakeConfig, 'skipFindingIds'>,
): ParsedDocument {
  const skipSet = new Set(config.skipFindingIds ?? []);
  if (skipSet.size === 0) return document;

  const findings = document.findings.filter(f => !skipSet.has(f.id));
  const findingIds = new Set(findings.map(f => f.id));

  return {
    ...document,
    findings,
    phases: document.phases
      .map(phase => ({ ...phase, findingIds: phase.findingIds.filter(id => findingIds.has(id)) }))
      .filter(phase => phase.findingIds.length > 0),
    priorityGroups: document.priorityGroups
      .map(group => ({ ...group, findingIds: group.findingIds.filter(id => findingIds.has(id)) }))
      .filter(group => group.findingIds.length > 0),
  };
}

export function buildIssueTitle(finding: Finding): string {
  const title = `[${finding.id}] ${finding.issue}`;
  return title.length > 120 ? `${title.slice(0, 117)}...` : title;
}

export function buildIssueBody(finding: Finding): string {
  return [
    '## Finding',
    `- **Finding ID:** ${finding.id}`,
    `- **Priority:** ${finding.priorityLabel}`,
    `- **Area:** ${finding.area}`,
    `- **Effort:** ${finding.effort}`,
    '',
    '## Issue',
    finding.issue,
    '',
    '## Impact',
    finding.impact,
    '',
    '## Suggested Fix',
    finding.suggestedFix,
  ].join('\n');
}

export function getFindingTags(finding: Finding): string[] {
  return [
    `Priority ${finding.priorityOrder}`,
    `Effort ${finding.effort}`,
    `Area: ${finding.area}`,
  ];
}

// ─── Preview (no side effects) ──────────────────────────────────────────────

export function previewIntake(content: string, config?: { projectName?: string }): IntakePreview {
  const document = parseDocument(content);
  return {
    document,
    proposedProjectName: getProjectName(document, config?.projectName),
    proposedPhases: document.phases,
    proposedIssueCount: document.findings.length,
    proposedTags: getProposedTags(document.findings),
  };
}

/**
 * Async preview that falls back to AI parsing when deterministic parsers find nothing.
 * Use this in API routes / server contexts where async is available.
 */
export async function previewIntakeAsync(
  content: string,
  config?: { projectName?: string; enableAI?: boolean; signal?: AbortSignal },
): Promise<IntakePreview & { parseMethod: 'deterministic' | 'ai' }> {
  let document = await parseDocumentAsync(content, config?.signal);
  let parseMethod: 'deterministic' | 'ai' = 'deterministic';

  // If deterministic parsing found nothing and AI is enabled, try AI fallback
  if (document.findings.length === 0 && config?.enableAI !== false) {
    try {
      const { parseDocumentWithAI } = await import('./ai-parser');
      const aiResult = await parseDocumentWithAI(content, config?.signal);
      if (aiResult && aiResult.findings.length > 0) {
        document = aiResult;
        parseMethod = 'ai';
      }
    } catch {
      config?.signal?.throwIfAborted();
      // AI not available — graceful degradation
    }
  }

  return {
    document,
    proposedProjectName: getProjectName(document, config?.projectName),
    proposedPhases: document.phases,
    proposedIssueCount: document.findings.length,
    proposedTags: getProposedTags(document.findings),
    parseMethod,
  };
}

// ─── Execution (creates real resources) ─────────────────────────────────────

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${init?.method ?? 'GET'} ${url} failed (${response.status}): ${text}`);
  }
  if (response.status === 204) return {} as T;
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  return fetchJson<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export async function executeIntake(content: string, config: IntakeConfig): Promise<IntakeResult> {
  config.signal?.throwIfAborted();
  const parsedDocument = config.parsedDocument
    ?? await parseDocumentAsync(content, config.signal);
  config.signal?.throwIfAborted();
  const document = applyIntakeTweaks(parsedDocument, config);
  const errors: string[] = [];
  const { mcUrl, repo, dryRun } = config;

  if (document.findings.length === 0) {
    const noFindingsError =
      parsedDocument.findings.length > 0 && (config.skipFindingIds?.length ?? 0) > 0
        ? 'No findings selected for intake'
        : 'No findings parsed from document';
    return {
      dryRun,
      document,
      projectId: null,
      appendedToExisting: false,
      phases: [],
      issues: [],
      assignments: [],
      tags: [],
      errors: [noFindingsError],
    };
  }

  // 1. Validate existing project (if specified) before any side effects
  let existingPhaseSortOffset = 0;
  let validatedExistingProjectId: string | null = null;

  if (config.existingProjectId) {
    if (!dryRun) {
      try {
        await fetchJson(`${mcUrl}/api/hub-projects/${config.existingProjectId}`);
        validatedExistingProjectId = config.existingProjectId;

        // Fetch existing phases to determine sort offset
        const phasesRes = await fetchJson<{ phases?: Array<{ sortOrder?: number }> }>(
          `${mcUrl}/api/project-phases?project_id=${encodeURIComponent(config.existingProjectId)}`,
        );
        const existingPhases = phasesRes.phases ?? [];
        if (existingPhases.length > 0) {
          existingPhaseSortOffset = Math.max(...existingPhases.map(p => (p.sortOrder ?? 0) + 1));
        }
      } catch (err) {
        return {
          dryRun,
          document,
          projectId: null,
          appendedToExisting: false,
          phases: [],
          issues: [],
          assignments: [],
          tags: [],
          errors: [`Existing project not found or inaccessible (${config.existingProjectId}): ${err instanceof Error ? err.message : String(err)}`],
        };
      }
    } else {
      validatedExistingProjectId = config.existingProjectId;
    }
  }

  // 2. Create tasks via MC API (or link to existing issues)
  const issues: CreatedIssue[] = [];
  const createdTaskIds: Array<{ findingId: string; taskId: string; title: string }> = [];
  // Track existing tasks that were linked (not created) so we can assign them to projects/phases
  const linkedTaskIds: Array<{ findingId: string; taskId: string; title: string; issueNumber: number }> = [];

  for (const finding of document.findings) {
    const title = buildIssueTitle(finding);
    if (dryRun) {
      issues.push({ findingId: finding.id, title, issueNumber: null, htmlUrl: null });
      continue;
    }

    // If finding references an existing GitHub issue, search for the existing task
    if (finding.linkedIssueNumbers && finding.linkedIssueNumbers.length > 0) {
      const issueNumber = finding.linkedIssueNumbers[0];
      const expectedSourceId = `${repo}:${issueNumber}`;
      let existingTaskId: string | null = null;

      try {
        // Search scoped to the target repo's list, matching the exact sourceId
        const res = await fetchJson<{ tasks?: Array<{ id: string; sourceId?: string; title?: string }> }>(
          `${mcUrl}/api/tasks?listId=${encodeURIComponent(repo)}&search=${encodeURIComponent(`#${issueNumber}`)}&limit=5`,
        );
        const match = res.tasks?.find(t => t.sourceId === expectedSourceId);
        if (match) {
          existingTaskId = match.id;
        }
      } catch {
        // Search failed — will fall through to create
      }

      if (existingTaskId) {
        // Link to existing task instead of creating a duplicate
        const [owner, repoName] = repo.split('/');
        linkedTaskIds.push({ findingId: finding.id, taskId: existingTaskId, title, issueNumber });
        issues.push({
          findingId: finding.id,
          title,
          issueNumber,
          htmlUrl: `https://github.com/${owner}/${repoName}/issues/${issueNumber}`,
          linkedExisting: true,
        });
        continue;
      }
      // If existing task not found, fall through to create a new one
    }

    try {
      const res = await postJson<{ id: string }>(`${mcUrl}/api/tasks`, {
        title,
        description: buildIssueBody(finding),
        connectorType: 'github-issues',
        sourceListId: repo,
        sourceListName: repo,
        tagSlugs: getFindingTags(finding),
      });

      createdTaskIds.push({ findingId: finding.id, taskId: res.id, title });
    } catch (err) {
      errors.push(`Task creation failed for ${finding.id}: ${err instanceof Error ? err.message : String(err)}`);
      issues.push({ findingId: finding.id, title, issueNumber: null, htmlUrl: null });
    }
  }

  // Wait for write-through to push issues to GitHub, then resolve issue numbers
  if (!dryRun && createdTaskIds.length > 0) {
    await new Promise(resolve => setTimeout(resolve, 3000));

    for (const { findingId, taskId, title } of createdTaskIds) {
      try {
        const res = await fetchJson<{ tasks?: Array<{ id: string; sourceId?: string }> }>(
          `${mcUrl}/api/tasks?search=${encodeURIComponent(taskId)}&limit=1`,
        );
        const task = res.tasks?.find(t => t.id === taskId);
        const sourceId = task?.sourceId;

        if (sourceId && !sourceId.startsWith('local:') && sourceId.includes(':')) {
          const issueNumber = parseInt(sourceId.substring(sourceId.lastIndexOf(':') + 1), 10);
          const [owner, repoName] = repo.split('/');
          issues.push({
            findingId,
            title,
            issueNumber,
            htmlUrl: `https://github.com/${owner}/${repoName}/issues/${issueNumber}`,
          });
        } else {
          // Write-through may still be in progress
          issues.push({ findingId, title, issueNumber: null, htmlUrl: null });
        }
      } catch {
        issues.push({ findingId, title, issueNumber: null, htmlUrl: null });
      }
    }
  }

  // 3. Create or resolve MC project
  let projectId: string | null = null;
  let appendedToExisting = false;
  const projectName = getProjectName(document, config.projectName);

  if (validatedExistingProjectId) {
    projectId = validatedExistingProjectId;
    appendedToExisting = true;
  } else if (!dryRun) {
    try {
      const res = await postJson<{ id: string }>(`${mcUrl}/api/hub-projects`, {
        name: projectName,
        description: `${document.findings.length} findings, ${document.phases.length} phases. Source repo: ${repo}.`,
        color: config.projectColor || '#f59e0b',
        icon: 'shield',
        category: config.category || null,
        metadata: { source: 'document-intake', createdAt: new Date().toISOString(), repo },
      });
      projectId = res.id;
    } catch (err) {
      errors.push(`MC project creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    projectId = `preview-${projectName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  }

  // 3. Create phases
  const createdPhases: CreatedPhase[] = [];
  let previousPhaseId: string | null = null;

  for (const phase of document.phases) {
    if (!dryRun && projectId) {
      try {
        const res = await postJson<{ phase: { id: string } }>(`${mcUrl}/api/project-phases`, {
          projectId,
          name: phase.name,
          description: phase.description || null,
          sortOrder: phase.sortOrder + existingPhaseSortOffset,
          estimatedDays: phase.estimatedDays,
          startAfterPhaseId: previousPhaseId,
        });
        const created: CreatedPhase = { ...phase, id: res.phase.id };
        createdPhases.push(created);
        previousPhaseId = created.id;
      } catch (err) {
        errors.push(`Phase creation failed for "${phase.name}": ${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      const created: CreatedPhase = { ...phase, id: `preview-phase-${phase.sortOrder + 1}` };
      createdPhases.push(created);
      previousPhaseId = created.id;
    }
  }

  // 4. Create tags
  const proposedTags = sanitizeTags(config.tags ?? getProposedTags(document.findings));
  if (!dryRun && projectId) {
    try {
      const existing = await fetchJson<{ tags?: Array<{ name: string }> }>(
        `${mcUrl}/api/tags?type=hub`,
      );
      const existingNames = new Set((existing.tags ?? []).map(t => t.name.toLowerCase()));

      for (const tagName of proposedTags) {
        if (!existingNames.has(tagName.toLowerCase())) {
          await postJson(`${mcUrl}/api/tags`, { name: tagName, color: '#f59e0b' });
          existingNames.add(tagName.toLowerCase());
        }
      }
    } catch (err) {
      errors.push(`Tag creation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // 5. Assign tasks to project + phases
  const assignments: TaskAssignment[] = [];

  if (!dryRun && projectId) {
    const phaseByFindingId = new Map<string, CreatedPhase>();
    for (const phase of createdPhases) {
      for (const fid of phase.findingIds) {
        phaseByFindingId.set(fid, phase);
      }
    }

    // Build a findingId → taskId map from created AND linked tasks
    const taskIdByFinding = new Map<string, string>();
    for (const { findingId, taskId } of createdTaskIds) {
      taskIdByFinding.set(findingId, taskId);
    }
    for (const { findingId, taskId } of linkedTaskIds) {
      taskIdByFinding.set(findingId, taskId);
    }

    for (const issue of issues) {
      const finding = document.findings.find(f => f.id === issue.findingId);
      const phase = phaseByFindingId.get(issue.findingId) ?? null;
      const taskId = taskIdByFinding.get(issue.findingId) ?? null;

      if (!finding || !taskId) {
        assignments.push({
          findingId: issue.findingId,
          issueNumber: issue.issueNumber,
          taskId: null,
          phaseId: phase?.id ?? null,
          phaseName: phase?.name ?? null,
          status: 'missing-task',
        });
        continue;
      }

      // Assign to project
      try {
        await postJson(`${mcUrl}/api/hub-projects/${projectId}/tasks`, { taskId });
      } catch (err) {
        errors.push(`Task ${taskId} project assignment failed: ${err instanceof Error ? err.message : String(err)}`);
      }

      // Assign to phase
      if (phase) {
        try {
          await postJson(`${mcUrl}/api/project-phases/${phase.id}/items`, {
            taskId,
            sortOrder: phase.findingIds.indexOf(finding.id),
          });
        } catch (err) {
          errors.push(`Phase item assignment failed for ${finding.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      assignments.push({
        findingId: issue.findingId,
        issueNumber: issue.issueNumber,
        taskId,
        phaseId: phase?.id ?? null,
        phaseName: phase?.name ?? null,
        status: 'assigned',
      });
    }
  } else {
    // Dry run assignments
    const phaseByFindingId = new Map<string, CreatedPhase>();
    for (const phase of createdPhases) {
      for (const fid of phase.findingIds) {
        phaseByFindingId.set(fid, phase);
      }
    }

    for (const issue of issues) {
      const phase = phaseByFindingId.get(issue.findingId) ?? null;
      assignments.push({
        findingId: issue.findingId,
        issueNumber: issue.issueNumber,
        taskId: null,
        phaseId: phase?.id ?? null,
        phaseName: phase?.name ?? null,
        status: 'skipped',
      });
    }
  }

  return {
    dryRun,
    document,
    projectId,
    appendedToExisting,
    phases: createdPhases,
    issues,
    assignments,
    tags: proposedTags,
    errors,
  };
}
