import { parseNLPDate } from '@/lib/date-parser';
import type {
  IdeationNode,
  IdeationProperty,
  IdeationPropertyKey,
} from '@/lib/graph/ideation-types';
import {
  IDEATION_PRIORITIES,
  IDEATION_STATUSES,
} from '@/lib/graph/ideation-types';

const PROPERTY_PATTERN = /^([a-z][a-z-]*)::\s*(.*)$/i;
const VALID_PRIORITIES = new Set<string>(IDEATION_PRIORITIES);
const VALID_STATUSES = new Set<string>(IDEATION_STATUSES);
const PROPERTY_KEYS = new Set<IdeationPropertyKey>([
  'priority',
  'status',
  'due',
  'effort',
  'tags',
  'assignee',
  'depends-on',
  'related',
  'notes',
]);

export const IDEATION_PROPERTY_DEFINITIONS: ReadonlyArray<{
  key: IdeationPropertyKey;
  description: string;
  values?: readonly string[];
}> = [
  { key: 'priority', description: 'Set priority', values: IDEATION_PRIORITIES },
  { key: 'status', description: 'Set workflow status', values: IDEATION_STATUSES },
  { key: 'due', description: 'Set a due date' },
  { key: 'effort', description: 'Estimate effort', values: ['1', '2', '3', '4', '5'] },
  { key: 'tags', description: 'Add comma-separated tags' },
  { key: 'assignee', description: 'Assign a person', values: ['me'] },
  { key: 'depends-on', description: 'Add blocking task links' },
  { key: 'related', description: 'Add related task links' },
  { key: 'notes', description: 'Add notes' },
];

export interface ParsedIdeationProperty {
  property: IdeationProperty | null;
  error: string | null;
}

export function getIdeationRelationshipTargetLabels(
  nodes: IdeationNode[],
  sourceNodeId: string,
): string[] {
  return nodes
    .filter((node) => node.kind === 'task' && node.id !== sourceNodeId)
    .map((node) => node.label);
}

export function extractWikiLinks(value: string): string[] {
  return [...new Set(Array.from(value.matchAll(/\[\[([^\]]+)\]\]/g))
    .map((match) => match[1].trim())
    .filter(Boolean))];
}

export interface ParsedIdeationTitle {
  label: string;
  properties: IdeationProperty[];
}

export function parseIdeationTitleTokens(input: string): ParsedIdeationTitle {
  const tags: string[] = [];
  let priority: string | null = null;
  const words = input.trim().split(/\s+/);
  const labelWords = words.filter((word) => {
    const priorityMatch = word.match(/^!(critical|urgent|high|medium|low|none)$/i);
    if (priorityMatch) {
      priority = priorityMatch[1].toLowerCase() === 'urgent'
        ? 'critical'
        : priorityMatch[1].toLowerCase();
      return false;
    }
    const tagMatch = word.match(/^#([a-z0-9][a-z0-9_-]*)$/i);
    if (tagMatch) {
      tags.push(tagMatch[1]);
      return false;
    }
    return true;
  });
  const label = labelWords.join(' ').trim();
  if (!label) return { label: input.trim(), properties: [] };

  const properties: IdeationProperty[] = [];
  if (priority) {
    properties.push({ key: 'priority', rawValue: priority, value: priority });
  }
  if (tags.length) {
    properties.push({ key: 'tags', rawValue: tags.map((tag) => `#${tag}`).join(', '), value: tags });
  }
  return { label, properties };
}

export function getIdeationPropertySuggestions(input: string): Array<{
  value: string;
  label: string;
  description: string;
}> {
  const separator = input.indexOf('::');
  if (separator === -1) {
    const query = input.trim().toLowerCase();
    return IDEATION_PROPERTY_DEFINITIONS
      .filter(({ key }) => key.includes(query))
      .map(({ key, description }) => ({
        value: `${key}:: `,
        label: `${key}::`,
        description,
      }));
  }

  const key = input.slice(0, separator).trim().toLowerCase();
  const query = input.slice(separator + 2).trim().toLowerCase();
  const definition = IDEATION_PROPERTY_DEFINITIONS.find((candidate) => candidate.key === key);
  return (definition?.values ?? [])
    .filter((value) => value.replaceAll('_', ' ').includes(query))
    .map((value) => ({
      value: `${key}:: ${value}`,
      label: value.replaceAll('_', ' '),
      description: `Set ${key}`,
    }));
}

export function parseIdeationProperty(input: string): ParsedIdeationProperty {
  const match = input.trim().match(PROPERTY_PATTERN);
  if (!match) {
    return { property: null, error: 'Use key:: value syntax' };
  }

  const rawKey = match[1].toLowerCase();
  const rawValue = match[2].trim();
  if (!PROPERTY_KEYS.has(rawKey as IdeationPropertyKey)) {
    if (rawKey === 'duplicates') {
      return { property: null, error: 'Duplicate relationships are not supported by the task data model' };
    }
    return { property: null, error: `Unknown property "${match[1]}"` };
  }
  const key = rawKey as IdeationPropertyKey;
  if (!rawValue) {
    return { property: null, error: 'Enter a property value' };
  }

  if (key === 'priority') {
    const value = rawValue.toLowerCase();
    return VALID_PRIORITIES.has(value)
      ? { property: { key, rawValue, value }, error: null }
      : { property: null, error: 'Priority must be critical, high, medium, low, or none' };
  }

  if (key === 'status') {
    const value = rawValue.toLowerCase().replaceAll(' ', '_');
    return VALID_STATUSES.has(value)
      ? { property: { key, rawValue, value }, error: null }
      : { property: null, error: 'Status must be todo, in progress, done, or blocked' };
  }

  if (key === 'effort') {
    const value = Number(rawValue);
    return Number.isInteger(value) && value >= 1 && value <= 5
      ? { property: { key, rawValue, value }, error: null }
      : { property: null, error: 'Effort must be a whole number from 1 to 5' };
  }

  if (key === 'due') {
    const parsed = parseNLPDate(rawValue);
    return parsed
      ? { property: { key, rawValue, value: parsed.date }, error: null }
      : { property: null, error: 'Enter a recognizable date, such as next Friday' };
  }

  if (key === 'tags') {
    const value = rawValue
      .split(',')
      .map((tag) => tag.trim().replace(/^#/, ''))
      .filter(Boolean);
    return value.length > 0
      ? { property: { key, rawValue, value }, error: null }
      : { property: null, error: 'Enter at least one tag' };
  }

  if (key === 'depends-on' || key === 'related') {
    const value = extractWikiLinks(rawValue);
    return value.length > 0
      ? { property: { key, rawValue, value }, error: null }
      : { property: null, error: `Use a wiki-link, for example ${key}:: [[First task]]` };
  }

  return {
    property: { key, rawValue, value: rawValue },
    error: null,
  };
}
