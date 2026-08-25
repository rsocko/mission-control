import { parseFilterQuery, replacePositiveFilterValues } from '@/lib/utils/parseFilterQuery';

describe('parseFilterQuery', () => {
  it('returns empty result for empty string', () => {
    const result = parseFilterQuery('');
    expect(result.tokens).toHaveLength(0);
    expect(result.hasStructuredTokens).toBe(false);
  });

  it('returns empty result for whitespace-only string', () => {
    const result = parseFilterQuery('   ');
    expect(result.tokens).toHaveLength(0);
  });

  it('parses a single free-text term', () => {
    const result = parseFilterQuery('connector');
    expect(result.textTerms).toEqual(['connector']);
    expect(result.hasStructuredTokens).toBe(false);
  });

  it('parses multiple free-text terms', () => {
    const result = parseFilterQuery('connector alerts');
    expect(result.textTerms).toEqual(['connector', 'alerts']);
  });

  it('parses title: token', () => {
    const result = parseFilterQuery('title:connector');
    expect(result.titleTokens).toEqual(['connector']);
    expect(result.hasStructuredTokens).toBe(true);
  });

  it('parses tag: token', () => {
    const result = parseFilterQuery('tag:area:tasks');
    expect(result.tagTokens).toEqual(['area:tasks']);
  });

  it('parses priority: token', () => {
    const result = parseFilterQuery('priority:high');
    expect(result.priorityTokens).toEqual(['high']);
  });

  it('parses positive and negated planning horizon tokens', () => {
    const result = parseFilterQuery('horizon:now -horizon:none');

    expect(result.horizonTokens).toEqual(['now']);
    expect(result.negatedTokens).toEqual([
      expect.objectContaining({ type: 'horizon', value: 'none' }),
    ]);
  });

  it('replaces positive horizon filters while preserving other and negated tokens', () => {
    const query = replacePositiveFilterValues(
      'release horizon:now -horizon:none priority:high horizon:later',
      'horizon',
      ['next', 'someday'],
    );

    expect(query).toBe('release -horizon:none priority:high horizon:next horizon:someday');
    expect(replacePositiveFilterValues(query, 'horizon', []))
      .toBe('release -horizon:none priority:high');
  });

  it('parses status: token', () => {
    const result = parseFilterQuery('status:todo');
    expect(result.statusTokens).toEqual(['todo']);
  });

  it('parses source: token', () => {
    const result = parseFilterQuery('source:github-issues');
    expect(result.sourceTokens).toEqual(['github-issues']);
  });

  it('parses list: token', () => {
    const result = parseFilterQuery('list:backlog');
    expect(result.listTokens).toEqual(['backlog']);
  });

  it('parses exact list identity tokens', () => {
    const result = parseFilterQuery('listid:Account-A:Backlog listid:backlog');
    expect(result.listIdTokens).toEqual(['Account-A:Backlog', 'backlog']);
  });

  it('parses assignee: token', () => {
    const result = parseFilterQuery('assignee:octo-org');
    expect(result.assigneeTokens).toEqual(['octo-org']);
  });

  it('parses project and phase identifiers without changing their case', () => {
    const result = parseFilterQuery('project:Project-A phase:Phase-B project:NONE phase:None');

    expect(result.projectTokens).toEqual(['Project-A', 'none']);
    expect(result.phaseTokens).toEqual(['Phase-B', 'none']);
  });

  it('handles quoted values', () => {
    const result = parseFilterQuery('title:"hello world"');
    expect(result.titleTokens).toEqual(['hello world']);
  });

  it('handles multiple structured tokens', () => {
    const result = parseFilterQuery('priority:high status:todo');
    expect(result.priorityTokens).toEqual(['high']);
    expect(result.statusTokens).toEqual(['todo']);
    expect(result.hasStructuredTokens).toBe(true);
  });

  it('handles mixed structured and free-text tokens', () => {
    const result = parseFilterQuery('priority:high connector');
    expect(result.priorityTokens).toEqual(['high']);
    expect(result.textTerms).toEqual(['connector']);
  });

  it('normalises token values to lowercase', () => {
    const result = parseFilterQuery('priority:HIGH title:Connector');
    expect(result.priorityTokens).toEqual(['high']);
    expect(result.titleTokens).toEqual(['connector']);
  });

  it('treats unrecognised prefixes as free-text', () => {
    const result = parseFilterQuery('unknown:value');
    expect(result.textTerms).toEqual(['unknown:value']);
    expect(result.hasStructuredTokens).toBe(false);
  });

  it('preserves raw token string', () => {
    const result = parseFilterQuery('priority:high');
    expect(result.tokens[0].raw).toBe('priority:high');
  });

  it('preserves raw quoted token string', () => {
    const result = parseFilterQuery('title:"hello world"');
    expect(result.tokens[0].raw).toBe('title:"hello world"');
  });

  it('parses dash and NOT negation without including excluded values as positive tokens', () => {
    const result = parseFilterQuery('-tag:wontfix NOT priority:low status:todo');

    expect(result.tagTokens).toEqual([]);
    expect(result.priorityTokens).toEqual([]);
    expect(result.statusTokens).toEqual(['todo']);
    expect(result.negatedTokens.map((token) => [token.type, token.value])).toEqual([
      ['tag', 'wontfix'],
      ['priority', 'low'],
    ]);
  });

  it('parses due-date presets and comparison values', () => {
    const result = parseFilterQuery('due:overdue due:<2026-08-01');

    expect(result.dueTokens).toEqual(['overdue', '<2026-08-01']);
  });

  it('parses positive and negated local disposition tokens', () => {
    const result = parseFilterQuery('disposition:handled -disposition:dismissed');

    expect(result.dispositionTokens).toEqual(['handled']);
    expect(result.negatedTokens).toEqual([
      expect.objectContaining({ type: 'disposition', value: 'dismissed' }),
    ]);
  });
});
