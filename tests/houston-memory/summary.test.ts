import { beforeEach, describe, expect, it, vi } from 'vitest';

const generateObject = vi.fn();
const get = vi.fn();

vi.mock('ai', () => ({ generateObject }));
vi.mock('@/lib/ai/provider-runtime', () => ({
  getAsyncAIModel: async () => ({ model: {}, context: {} }),
}));
vi.mock('@/lib/semantic-index/source/facade', () => ({
  getSemanticSourcePort: async () => ({ get }),
}));

describe('Houston summary minimization', () => {
  beforeEach(() => {
    generateObject.mockReset();
    get.mockReset();
  });

  it('redacts credentials, bounds fields, and drops unvalidated links', async () => {
    generateObject.mockResolvedValue({
      object: {
        version: 1,
        title: ' Release   planning ',
        summary: 'Use api_key=super-secret-value, contact person@example.com, and complete the rollout.',
        decisions: ['Ship Friday', 'Ship Friday'],
        commitments: [
          'Review token: ghp_abcdefghijklmnopqrstuvwxyz',
          'Repeat "the full original private message verbatim" later',
        ],
        topics: Array.from({ length: 20 }, (_, index) => `topic-${index}`),
        linkedEntities: [
          { type: 'task', id: 'task-1' },
          { type: 'project', id: 'missing' },
        ],
      },
    });
    get.mockImplementation(async (type: string, id: string) => (
      type === 'task' && id === 'task-1'
        ? { entityType: 'task', id, title: 'Launch checklist' }
        : null
    ));
    const { generateMinimizedHoustonSummary } = await import('@/lib/houston-memory/summary');
    const result = await generateMinimizedHoustonSummary({
      conversationId: '11111111-1111-4111-8111-111111111111',
      messages: [
        { role: 'user', text: 'Plan the release.' },
        { role: 'assistant', text: 'We will ship Friday.' },
      ],
    });

    expect(JSON.stringify(result)).not.toContain('super-secret-value');
    expect(JSON.stringify(result)).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(result)).not.toContain('person@example.com');
    expect(JSON.stringify(result)).not.toContain('the full original private message verbatim');
    expect(result.decisions).toEqual(['Ship Friday']);
    expect(result.topics).toHaveLength(12);
    expect(result.linkedEntities).toEqual([
      { type: 'task', id: 'task-1', label: 'Launch checklist' },
    ]);
  });

  it('fails closed when model output copies substantial source text', async () => {
    generateObject.mockResolvedValue({
      object: {
        version: 1,
        title: 'Planning',
        summary: 'My private account recovery phrase should remain only inside this conversation.',
        decisions: [],
        commitments: [],
        topics: [],
        linkedEntities: [],
      },
    });
    const { generateMinimizedHoustonSummary } = await import('@/lib/houston-memory/summary');

    await expect(generateMinimizedHoustonSummary({
      conversationId: '11111111-1111-4111-8111-111111111111',
      messages: [
        { role: 'user', text: 'My private account recovery phrase should remain only inside this conversation.' },
        { role: 'assistant', text: 'Understood.' },
      ],
    })).rejects.toThrow('houston-summary-copied-source-text');
  });

  it('applies copied-source detection to generated topics', async () => {
    generateObject.mockResolvedValue({
      object: {
        version: 1,
        title: 'Planning',
        summary: 'A durable planning topic was discussed.',
        decisions: [],
        commitments: [],
        topics: ['private account recovery phrase should remain hidden'],
        linkedEntities: [],
      },
    });
    const { generateMinimizedHoustonSummary } = await import('@/lib/houston-memory/summary');

    await expect(generateMinimizedHoustonSummary({
      conversationId: '11111111-1111-4111-8111-111111111111',
      messages: [
        { role: 'user', text: 'The private account recovery phrase should remain hidden from every durable record.' },
        { role: 'assistant', text: 'Understood.' },
      ],
    })).rejects.toThrow('houston-summary-copied-source-text');
  });
});
