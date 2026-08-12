import { beforeEach, describe, expect, it, vi } from 'vitest';

const runTransaction = vi.fn();
vi.mock('@/db', () => ({ runTransaction }));
vi.mock('@/lib/api-error', () => ({
  ApiErrors: {
    validation: (message: string) => Response.json({ error: message }, { status: 422 }),
    internal: (_message: string, cause: unknown) => Response.json({
      error: cause instanceof Error ? cause.message : String(cause),
    }, { status: 500 }),
  },
}));

const root = {
  id: 'root',
  label: 'Graph project',
  kind: 'idea',
  parentId: null,
  sortOrder: 0,
  properties: {},
};

describe('POST /api/ideation/convert', () => {
  beforeEach(() => runTransaction.mockReset());

  it('validates a complete draft before starting one transaction', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Graph project',
        color: '#6366f1',
        nodes: [
          root,
          {
            id: 'phase',
            label: 'Build',
            kind: 'phase',
            parentId: 'root',
            sortOrder: 0,
            properties: {},
          },
          {
            id: 'task',
            label: 'Implement graph',
            kind: 'task',
            parentId: 'phase',
            sortOrder: 0,
            properties: {
              priority: { key: 'priority', rawValue: 'high', value: 'high' },
            },
          },
        ],
      }),
    }));

    const body = await response.clone().json();
    expect(response.status, JSON.stringify(body)).toBe(201);
    expect(runTransaction).toHaveBeenCalledOnce();
  });

  it('rejects missing parents and cycles without opening a transaction', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Broken project',
        color: '#6366f1',
        nodes: [
          root,
          { ...root, id: 'child', parentId: 'missing' },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects wiki-link dependencies that match duplicate task titles', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Ambiguous project',
        color: '#6366f1',
        nodes: [
          root,
          { ...root, id: 'duplicate-1', label: 'Shared title', kind: 'task', parentId: 'root' },
          { ...root, id: 'duplicate-2', label: 'Shared title', kind: 'task', parentId: 'root' },
          {
            ...root,
            id: 'dependent',
            label: 'Dependent',
            kind: 'task',
            parentId: 'root',
            properties: {
              'depends-on': {
                key: 'depends-on',
                rawValue: '[[Shared title]]',
                value: ['Shared title'],
              },
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: expect.stringContaining('ambiguous'),
    });

    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects unresolved cross-references before opening a transaction', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Missing link',
        color: '#6366f1',
        nodes: [
          root,
          {
            ...root,
            id: 'task',
            label: 'Task',
            kind: 'task',
            parentId: 'root',
            properties: {
              related: {
                key: 'related',
                rawValue: '[[Missing task]]',
                value: ['Missing task'],
              },
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining('does not exist') });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects blocking cycles before opening a transaction', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Cyclic dependencies',
        color: '#6366f1',
        nodes: [
          root,
          {
            ...root,
            id: 'first',
            label: 'First',
            kind: 'task',
            parentId: 'root',
            properties: {
              'depends-on': {
                key: 'depends-on',
                rawValue: '[[Second]]',
                value: ['Second'],
              },
            },
          },
          {
            ...root,
            id: 'second',
            label: 'Second',
            kind: 'task',
            parentId: 'root',
            properties: {
              'depends-on': {
                key: 'depends-on',
                rawValue: '[[First]]',
                value: ['First'],
              },
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining('cycle') });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it('rejects reverse duplicates of symmetric related relationships', async () => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Duplicate relationships',
        color: '#6366f1',
        nodes: [
          root,
          {
            ...root,
            id: 'first',
            label: 'First',
            kind: 'task',
            parentId: 'root',
            properties: {
              related: { key: 'related', rawValue: '[[Second]]', value: ['Second'] },
            },
          },
          {
            ...root,
            id: 'second',
            label: 'Second',
            kind: 'task',
            parentId: 'root',
            properties: {
              related: { key: 'related', rawValue: '[[First]]', value: ['First'] },
            },
          },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: expect.stringContaining('duplicated') });
    expect(runTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['status', { key: 'status', rawValue: 'unexpected', value: 'unexpected' }],
    ['priority', { key: 'priority', rawValue: 'urgent', value: 'urgent' }],
    ['effort', { key: 'effort', rawValue: '9', value: 9 }],
  ])('rejects an invalid %s property value', async (propertyKey, property) => {
    const { POST } = await import('@/app/api/ideation/convert/route');
    const response = await POST(new Request('http://localhost/api/ideation/convert', {
      method: 'POST',
      body: JSON.stringify({
        name: 'Invalid properties',
        color: '#6366f1',
        nodes: [
          root,
          {
            ...root,
            id: 'task',
            label: 'Task',
            kind: 'task',
            parentId: 'root',
            properties: { [propertyKey]: property },
          },
        ],
      }),
    }));

    expect(response.status).toBe(422);
    expect(runTransaction).not.toHaveBeenCalled();
  });
});
