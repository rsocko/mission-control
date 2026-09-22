import { describe, expect, it } from 'vitest';
import {
  ALERT_PROJECTION_VERSION,
  PROJECT_PROJECTION_VERSION,
  SEMANTIC_PROJECTION_VERSION,
  SEMANTIC_EMBEDDING_FIELD_WEIGHTS,
  TAG_PROJECTION_VERSION,
  TASK_PROJECTION_VERSION,
  TRIAGE_ITEM_PROJECTION_VERSION,
  buildEmbeddingText,
  projectAlert,
  projectProject,
  projectSource,
  projectTag,
  projectTask,
  projectTriageItem,
} from '@/lib/semantic-index/projections';
import {
  SEMANTIC_BODY_MAX_LENGTH,
  SEMANTIC_MAX_KEYWORDS,
  SEMANTIC_TITLE_MAX_LENGTH,
  latestTimestamp,
  normalizeBlock,
  normalizeInline,
  normalizeKeywords,
  truncateStable,
} from '@/lib/semantic-index/projections/normalize';
import type {
  SemanticAlertSource,
  SemanticProjectSource,
  SemanticTagSource,
  SemanticTaskSource,
  SemanticTriageItemSource,
} from '@/lib/semantic-index/source/contracts';
import type { SemanticSensitivity } from '@/lib/semantic-index/contracts';

const standard = () => 'standard' as SemanticSensitivity;
const options = { resolveSensitivity: standard };

function makeTask(overrides: Partial<SemanticTaskSource> = {}): SemanticTaskSource {
  return {
    entityType: 'task',
    semanticEligible: true,
    id: 'task-1',
    title: 'Ship the durable semantic index',
    description: 'Persist versioned documents and vectors.',
    status: 'in_progress',
    statusReason: null,
    microStatus: 'blocked_on_review',
    priority: 'high',
    planningHorizon: 'next',
    localDisposition: 'active',
    effort: 3,
    dueDate: '2026-09-01T00:00:00.000Z',
    connectorType: 'github-issues',
    sourceListName: 'Platform',
    parentId: null,
    isChecklistItem: false,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    completedAt: null,
    tags: ['Platform', 'search'],
    projects: [],
    ...overrides,
  };
}

function makeAlert(overrides: Partial<SemanticAlertSource> = {}): SemanticAlertSource {
  return {
    entityType: 'alert',
    semanticEligible: true,
    id: 'alert-1',
    title: 'Sync failed',
    body: 'The connector could not reach the upstream API.',
    level: 'critical',
    category: 'sync',
    state: 'unread',
    readState: 'unread',
    disposition: 'inbox',
    sourceState: 'active',
    connectorType: 'microsoft-todo',
    isActionable: true,
    receivedAt: '2026-08-20T10:00:00.000Z',
    sortAt: '2026-08-20T10:00:00.000Z',
    expiresAt: null,
    lastSourceActivityAt: null,
    readAt: null,
    handledAt: null,
    resolvedAt: null,
    archivedAt: null,
    dismissedAt: null,
    relatedTaskId: null,
    relatedProjectId: null,
    ...overrides,
  };
}

function makeProject(overrides: Partial<SemanticProjectSource> = {}): SemanticProjectSource {
  return {
    entityType: 'project',
    semanticEligible: true,
    id: 'project-1',
    name: 'Semantic platform',
    description: 'Ship cross-entity retrieval.',
    status: 'active',
    statusOverride: null,
    hidden: false,
    category: 'engineering',
    targetDate: '2026-10-01T00:00:00.000Z',
    startedAt: null,
    completedAt: null,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    tags: ['Search', 'Platform'],
    representativeTasks: ['Build adapters', 'Test parity'],
    representativeTaskConnectorTypes: ['github-issues', 'local'],
    taskCount: 2,
    latestTaskUpdatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function makeTag(overrides: Partial<SemanticTagSource> = {}): SemanticTagSource {
  return {
    entityType: 'tag',
    semanticEligible: true,
    id: 'tag-1',
    name: 'Semantic Search',
    slug: 'semantic-search',
    type: 'hub',
    source: null,
    confirmed: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    unifiedInto: null,
    usageCount: 2,
    representativeTasks: ['Build adapters', 'Test parity'],
    representativeTaskConnectorTypes: ['github-issues', 'local'],
    latestTaskUpdatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function makeTriageItem(
  overrides: Partial<SemanticTriageItemSource> = {},
): SemanticTriageItemSource {
  return {
    entityType: 'triage-item',
    semanticEligible: true,
    id: 'triage-1',
    sourcePlatform: 'github',
    title: 'Vector database research',
    description: 'Compare bounded local indexes.',
    contentType: 'repo',
    capturedAt: '2026-08-01T00:00:00.000Z',
    ingestedAt: '2026-08-20T00:00:00.000Z',
    status: 'pending',
    snoozedUntil: null,
    aiSummary: 'Candidate libraries for semantic retrieval.',
    aiCategories: ['software-development'],
    aiRelevanceScore: 85,
    aiUrgency: 'evergreen',
    ...overrides,
  };
}

describe('semantic projection normalization', () => {
  it('collapses whitespace inline and preserves paragraphs in blocks', () => {
    expect(normalizeInline('  a \n\n  b\t c ')).toBe('a b c');
    expect(normalizeBlock('a  \n\n\n\n b   \n  c  ')).toBe('a\n\nb\nc');
  });

  it('truncates without splitting a surrogate pair', () => {
    // U+1F600 occupies two UTF-16 code units; cutting between them would emit a
    // lone surrogate.
    const value = `${'a'.repeat(9)}\u{1F600}bbbb`;
    const truncated = truncateStable(value, 11);
    expect(truncated.length).toBeLessThanOrEqual(11);
    expect(truncated.endsWith('…')).toBe(true);
    for (const char of truncated) {
      expect(char.charCodeAt(0)).not.toBeGreaterThanOrEqual(0xdc00);
    }
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u.test(truncated)).toBe(false);
  });

  it('lower-cases, de-duplicates, sorts and bounds keywords', () => {
    const keywords = normalizeKeywords([
      'Zeta', 'alpha', 'ALPHA', '  ', null, undefined,
      ...Array.from({ length: 40 }, (_, index) => `kw-${index}`),
    ]);
    expect(keywords.length).toBe(SEMANTIC_MAX_KEYWORDS);
    expect(keywords).toEqual([...keywords].sort());
    expect(keywords.filter((keyword) => keyword === 'alpha')).toHaveLength(1);
  });

  it('picks the newest usable timestamp and ignores junk', () => {
    expect(latestTimestamp(
      ['2026-01-01T00:00:00.000Z', 'not-a-date', null, '2026-05-01T00:00:00.000Z'],
      '1999-01-01T00:00:00.000Z',
    )).toBe('2026-05-01T00:00:00.000Z');
    expect(latestTimestamp(['nope'], '1999-01-01T00:00:00.000Z'))
      .toBe('1999-01-01T00:00:00.000Z');
  });
});

describe('projection versions', () => {
  it('keeps the index-wide version at or above every per-kind version', () => {
    expect(SEMANTIC_PROJECTION_VERSION).toBeGreaterThanOrEqual(TASK_PROJECTION_VERSION);
    expect(SEMANTIC_PROJECTION_VERSION).toBeGreaterThanOrEqual(PROJECT_PROJECTION_VERSION);
    expect(SEMANTIC_PROJECTION_VERSION).toBeGreaterThanOrEqual(TAG_PROJECTION_VERSION);
    expect(SEMANTIC_PROJECTION_VERSION).toBeGreaterThanOrEqual(TRIAGE_ITEM_PROJECTION_VERSION);
    expect(SEMANTIC_PROJECTION_VERSION).toBeGreaterThanOrEqual(ALERT_PROJECTION_VERSION);
  });

  describe('project, tag, and triage projections', () => {
    it('projects bounded representative project context and authoritative navigation', () => {
      const document = projectProject(makeProject(), options);
      expect(document).toMatchObject({
        entityType: 'project',
        title: 'Semantic platform',
        sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
        metadata: {
          status: 'active',
          category: 'engineering',
          taskCount: 2,
          navigationTarget: '/projects/project-1',
        },
      });
      expect(document.body).toContain('Representative tasks: Build adapters; Test parity');
      expect(document.keywords).toEqual(['active', 'engineering', 'platform', 'search']);
    });

    it('projects canonical tags with bounded usage examples', () => {
      const document = projectTag(makeTag(), options);
      expect(document).toMatchObject({
        entityType: 'tag',
        body: 'Used by: Build adapters; Test parity',
        metadata: {
          slug: 'semantic-search',
          confirmed: true,
          usageCount: 2,
          navigationTarget: '/tags?tag=tag-1',
        },
      });
    });

    it('prefers the minimized triage summary and excludes URLs and raw metadata', () => {
      const document = projectTriageItem(makeTriageItem(), options);
      expect(document).toMatchObject({
        entityType: 'triage-item',
        metadata: {
          sourcePlatform: 'github',
          status: 'pending',
          navigationTarget: '/triage?id=triage-1',
        },
      });
      expect(document.body).toBe(
        'Candidate libraries for semantic retrieval.\nCompare bounded local indexes.',
      );
      expect(JSON.stringify(document)).not.toContain('sourceUrl');
    });

    it('uses the most restrictive sensitivity across contributing task connectors', () => {
      const document = projectProject(makeProject({
        representativeTaskConnectorTypes: ['github-issues', 'monarch-money'],
      }), {
        resolveSensitivity: ({ connectorType }) =>
          connectorType === 'monarch-money' ? 'restricted' : 'standard',
      });

      expect(document.sensitivity).toBe('restricted');
    });

    it('keeps fingerprints deterministic when category order changes', () => {
      const first = projectTriageItem(makeTriageItem({
        aiCategories: ['software-development', 'research'],
      }), options);
      const second = projectTriageItem(makeTriageItem({
        aiCategories: ['research', 'software-development'],
      }), options);
      expect(second.contentFingerprint).toBe(first.contentFingerprint);
    });
  });

  it('stamps documents with the requested projection version', () => {
    const document = projectTask(makeTask(), { ...options, projectionVersion: 7 });
    expect(document.projectionVersion).toBe(7);
  });
});

describe('task projection', () => {
  it('produces a stable, normalized document', () => {
    const document = projectTask(makeTask(), options);
    expect(document).toMatchObject({
      entityType: 'task',
      entityId: 'task-1',
      title: 'Ship the durable semantic index',
      body: 'Persist versioned documents and vectors.',
      sensitivity: 'standard',
      retainUntil: null,
      sourceUpdatedAt: '2026-08-20T00:00:00.000Z',
    });
    expect(document.keywords).toEqual([
      'blocked_on_review', 'github-issues', 'in_progress', 'next', 'platform', 'search',
    ]);
    expect(document.metadata).toMatchObject({
      connectorType: 'github-issues',
      status: 'in_progress',
      priority: 'high',
      effort: 3,
      isChecklistItem: false,
    });
    expect(document.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(document.sourceRevision).toMatch(/^[0-9a-f]{32}$/);
  });

  it('is deterministic across tag ordering and whitespace differences', () => {
    const a = projectTask(makeTask(), options);
    const b = projectTask(makeTask({
      tags: ['search', 'Platform'],
      title: '  Ship the   durable semantic index  ',
      description: 'Persist versioned documents and vectors.   ',
    }), options);
    expect(b.contentFingerprint).toBe(a.contentFingerprint);
    // The raw snapshot differs, so the source revision must differ even though
    // the normalized content does not.
    expect(b.sourceRevision).not.toBe(a.sourceRevision);
  });

  it('changes the fingerprint when projected content changes', () => {
    const base = projectTask(makeTask(), options);
    expect(projectTask(makeTask({ title: 'Something else' }), options).contentFingerprint)
      .not.toBe(base.contentFingerprint);
    expect(projectTask(makeTask({ tags: ['platform'] }), options).contentFingerprint)
      .not.toBe(base.contentFingerprint);
    expect(projectTask(makeTask({ priority: 'low' }), options).contentFingerprint)
      .not.toBe(base.contentFingerprint);
  });

  it('changes the fingerprint when sensitivity changes', () => {
    const standardDocument = projectTask(makeTask(), options);
    const restricted = projectTask(makeTask(), {
      resolveSensitivity: () => 'restricted',
    });
    expect(restricted.sensitivity).toBe('restricted');
    expect(restricted.contentFingerprint).not.toBe(standardDocument.contentFingerprint);
  });

  it('widens sourceUpdatedAt to the completion timestamp', () => {
    const document = projectTask(makeTask({
      completedAt: '2026-08-25T00:00:00.000Z',
    }), options);
    expect(document.sourceUpdatedAt).toBe('2026-08-25T00:00:00.000Z');
  });

  it('truncates oversized titles and bodies', () => {
    const document = projectTask(makeTask({
      title: 'x'.repeat(SEMANTIC_TITLE_MAX_LENGTH + 50),
      description: 'y'.repeat(SEMANTIC_BODY_MAX_LENGTH + 500),
    }), options);
    expect(document.title).toHaveLength(SEMANTIC_TITLE_MAX_LENGTH);
    expect(document.body).toHaveLength(SEMANTIC_BODY_MAX_LENGTH);
    expect(document.title.endsWith('…')).toBe(true);
  });

  it('resolves sensitivity from Mission Control and the connector kind', () => {
    const seen: string[] = [];
    const document = projectTask(makeTask({ connectorType: 'monarch-money' }), {
      resolveSensitivity: ({ connectorType, entityType }) => {
        seen.push(`${entityType}:${connectorType}`);
        return connectorType === 'mission-control' ? 'local-only' : 'restricted';
      },
    });
    expect(seen).toEqual(['task:mission-control', 'task:monarch-money']);
    expect(document.sensitivity).toBe('local-only');
    expect(document.metadata.connectorTypes).toBe('mission-control,monarch-money');
  });
});

describe('alert projection', () => {
  it('maps expiry onto the retention deadline', () => {
    const document = projectAlert(makeAlert({
      expiresAt: '2026-09-30T00:00:00Z',
    }), options);
    expect(document.retainUntil).toBe('2026-09-30T00:00:00.000Z');
    expect(document.entityType).toBe('alert');
  });

  it('minimizes alert bodies before provider egress', () => {
    const document = projectAlert(makeAlert({ body: 's'.repeat(2_000) }), options);
    expect(document.body.length).toBe(600);
    expect(document.metadata.navigationTarget).toBe('/notifications?id=alert-1');
  });

  it('derives a monotonic stamp from the newest activity timestamp', () => {
    const document = projectAlert(makeAlert({
      handledAt: '2026-08-21T09:00:00.000Z',
      lastSourceActivityAt: '2026-08-22T09:00:00.000Z',
    }), options);
    expect(document.sourceUpdatedAt).toBe('2026-08-22T09:00:00.000Z');
  });

  it('changes the fingerprint when retention changes', () => {
    const base = projectAlert(makeAlert(), options);
    const expiring = projectAlert(makeAlert({ expiresAt: '2026-09-30T00:00:00.000Z' }), options);
    expect(expiring.contentFingerprint).not.toBe(base.contentFingerprint);
  });

  it('does not change the fingerprint when only a read timestamp moves', () => {
    const base = projectAlert(makeAlert(), options);
    const read = projectAlert(makeAlert({ readAt: '2026-08-21T00:00:00.000Z' }), options);
    expect(read.contentFingerprint).toBe(base.contentFingerprint);
    expect(read.sourceRevision).not.toBe(base.sourceRevision);
    expect(read.sourceUpdatedAt).toBe('2026-08-21T00:00:00.000Z');
  });
});

describe('projectSource dispatch and embedding text', () => {
  it('dispatches on the source discriminant', () => {
    expect(projectSource(makeTask(), options).entityType).toBe('task');
    expect(projectSource(makeProject(), options).entityType).toBe('project');
    expect(projectSource(makeTag(), options).entityType).toBe('tag');
    expect(projectSource(makeTriageItem(), options).entityType).toBe('triage-item');
    expect(projectSource(makeAlert(), options).entityType).toBe('alert');
  });

  it('builds embedding text from title, keywords and body only', () => {
    const document = projectTask(makeTask(), options);
    const text = buildEmbeddingText(document);
    expect(text.split('\n').filter((line) => line === document.title))
      .toHaveLength(SEMANTIC_EMBEDDING_FIELD_WEIGHTS.title);
    expect(text).toContain(document.keywords.join(', '));
    expect(text).toContain(document.body);
    expect(text).not.toContain(document.sourceRevision);
  });

  it('omits empty parts rather than emitting blank lines', () => {
    const document = projectAlert(makeAlert({ body: null }), options);
    const text = buildEmbeddingText(document);
    expect(text).not.toContain('\n\n');
    expect(text.trim()).toBe(text);
  });
});
