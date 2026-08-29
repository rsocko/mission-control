/**
 * parseFilterQuery – parses a free-form filter string into structured tokens.
 *
 * Supported prefixes:
 *   title:text       – title substring match
 *   tag:slug         – exact tag slug match
 *   priority:level   – priority value (high / medium / low / critical / urgent)
 *   horizon:value    – planning horizon (next / soon / later / someday / none)
 *   status:value     – status value (todo / in_progress / done / cancelled …)
 *   source:type      – connector type (github-issues / todoist …)
 *   list:name        – source list name substring
 *   listid:id        – exact source list identity (optionally connector:id)
 *   assignee:name    – assignee name match
 *   due:value        – due-date preset or comparison (<2026-08-01 / overdue / none)
 *   project:id       – exact hub project ID (or none)
 *   phase:id         – exact project phase ID (or none)
 *   disposition:value – Mission Control local disposition (active / handled / dismissed)
 *
 * Any word without a recognised prefix is treated as a free-text term that
 * matches against title, tags and notes.
 *
 * Quoted values are supported for any prefix, e.g.  title:"hello world"
 */

export type FilterTokenType =
  | 'title'
  | 'tag'
  | 'priority'
  | 'horizon'
  | 'status'
  | 'source'
  | 'list'
  | 'listid'
  | 'assignee'
  | 'due'
  | 'project'
  | 'phase'
  | 'disposition'
  | 'text';

export interface FilterToken {
  /** The parsed token type */
  type: FilterTokenType;
  /** Normalised value (lowercased except for exact identifiers) */
  value: string;
  /** The original substring that produced this token (for display / removal) */
  raw: string;
  /** Whether this condition excludes matching tasks */
  negated: boolean;
}

export interface ParsedFilterQuery {
  tokens: FilterToken[];
  /** Convenience accessors by type */
  titleTokens: string[];
  tagTokens: string[];
  priorityTokens: string[];
  horizonTokens: string[];
  statusTokens: string[];
  sourceTokens: string[];
  listTokens: string[];
  listIdTokens: string[];
  assigneeTokens: string[];
  dueTokens: string[];
  projectTokens: string[];
  phaseTokens: string[];
  dispositionTokens: string[];
  textTerms: string[];
  negatedTokens: FilterToken[];
  /** True when at least one structured (prefixed) token is present */
  hasStructuredTokens: boolean;
}

const RECOGNISED_PREFIXES: FilterTokenType[] = [
  'title',
  'tag',
  'priority',
  'horizon',
  'status',
  'source',
  'list',
  'listid',
  'assignee',
  'due',
  'project',
  'phase',
  'disposition',
];

/**
 * Tokenise the raw query string.
 * Handles:
 *   - `prefix:"quoted value"` – value with spaces
 *   - `prefix:unquoted`
 *   - bare words (no prefix)
 */
export function parseFilterQuery(query: string): ParsedFilterQuery {
  const tokens: FilterToken[] = [];

  if (!query.trim()) {
    return buildResult(tokens);
  }

  // Regex: optionally match a negation marker and prefix, then a quoted or unquoted value.
  const TOKEN_RE =
    /(?:((?:NOT\s+|-))?([a-z]+):(?:"([^"]*)"|(\S+)))|(\S+)/gi;

  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(query)) !== null) {
    const negation = match[1];
    const prefix = match[2]?.toLowerCase();
    const quotedValue = match[3];
    const unquotedValue = match[4];
    const bareWord = match[5];

    if (prefix && (RECOGNISED_PREFIXES as string[]).includes(prefix)) {
      const rawValue = quotedValue ?? unquotedValue ?? '';
      const preservesIdentifierCase = prefix === 'listid' || prefix === 'project' || prefix === 'phase';
      const value = preservesIdentifierCase && rawValue.toLowerCase() !== 'none'
        ? rawValue
        : rawValue.toLowerCase();
      const raw = match[0];
      tokens.push({
        type: prefix as FilterTokenType,
        value,
        raw,
        negated: Boolean(negation),
      });
    } else if (prefix) {
      // Unrecognised prefix – treat the whole thing as a free-text term
      const value = match[0].toLowerCase();
      tokens.push({ type: 'text', value, raw: match[0], negated: false });
    } else if (bareWord) {
      tokens.push({ type: 'text', value: bareWord.toLowerCase(), raw: bareWord, negated: false });
    }
  }

  return buildResult(tokens);
}

export function removeFilterQueryToken(
  query: string,
  tokenIndex: number,
  expectedToken?: Pick<FilterToken, 'type' | 'value' | 'raw' | 'negated'>,
): string {
  const tokens = parseFilterQuery(query).tokens;
  let index = tokenIndex;
  if (expectedToken && !sameToken(tokens[index], expectedToken)) {
    index = tokens.findIndex((token) => sameToken(token, expectedToken));
  }
  if (index < 0 || index >= tokens.length) return query;
  return tokens
    .filter((_, candidateIndex) => candidateIndex !== index)
    .map((token) => token.raw)
    .join(' ');
}

export function replacePositiveFilterValues(
  query: string,
  type: FilterTokenType,
  values: readonly string[],
): string {
  return [
    ...parseFilterQuery(query).tokens
      .filter((token) => token.type !== type || token.negated)
      .map((token) => token.raw),
    ...values.map((value) => `${type}:${value}`),
  ].join(' ');
}

function sameToken(
  token: FilterToken | undefined,
  expected: Pick<FilterToken, 'type' | 'value' | 'raw' | 'negated'>,
): boolean {
  return Boolean(
    token
    && token.type === expected.type
    && token.value === expected.value
    && token.raw === expected.raw
    && token.negated === expected.negated,
  );
}

function buildResult(tokens: FilterToken[]): ParsedFilterQuery {
  const titleTokens: string[] = [];
  const tagTokens: string[] = [];
  const priorityTokens: string[] = [];
  const horizonTokens: string[] = [];
  const statusTokens: string[] = [];
  const sourceTokens: string[] = [];
  const listTokens: string[] = [];
  const listIdTokens: string[] = [];
  const assigneeTokens: string[] = [];
  const dueTokens: string[] = [];
  const projectTokens: string[] = [];
  const phaseTokens: string[] = [];
  const dispositionTokens: string[] = [];
  const textTerms: string[] = [];
  const negatedTokens: FilterToken[] = [];

  for (const t of tokens) {
    if (t.negated) {
      negatedTokens.push(t);
      continue;
    }

    switch (t.type) {
      case 'title':    titleTokens.push(t.value); break;
      case 'tag':      tagTokens.push(t.value); break;
      case 'priority': priorityTokens.push(t.value); break;
      case 'horizon': horizonTokens.push(t.value); break;
      case 'status':   statusTokens.push(t.value); break;
      case 'source':   sourceTokens.push(t.value); break;
      case 'list':     listTokens.push(t.value); break;
      case 'listid':   listIdTokens.push(t.value); break;
      case 'assignee': assigneeTokens.push(t.value); break;
      case 'due':      dueTokens.push(t.value); break;
      case 'project':  projectTokens.push(t.value); break;
      case 'phase':    phaseTokens.push(t.value); break;
      case 'disposition': dispositionTokens.push(t.value); break;
      case 'text':     textTerms.push(t.value); break;
    }
  }

  const hasStructuredTokens = tokens.some((t) => t.type !== 'text');

  return {
    tokens,
    titleTokens,
    tagTokens,
    priorityTokens,
    horizonTokens,
    statusTokens,
    sourceTokens,
    listTokens,
    listIdTokens,
    assigneeTokens,
    dueTokens,
    projectTokens,
    phaseTokens,
    dispositionTokens,
    textTerms,
    negatedTokens,
    hasStructuredTokens,
  };
}
