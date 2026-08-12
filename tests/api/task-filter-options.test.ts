import { vi } from 'vitest';

const orderBy = vi.fn().mockResolvedValue([
  { assignee: 'alice' },
  { assignee: ' bob ' },
  { assignee: null },
]);
const where = vi.fn(() => ({ orderBy }));
const from = vi.fn(() => ({ where }));
const selectDistinct = vi.fn(() => ({ from }));

vi.mock('@/db', () => ({
  default: { selectDistinct },
}));

vi.mock('@/db/schema', () => ({
  tasks: { assignee: 'assignee' },
}));

describe('GET /api/tasks/filter-options', () => {
  it('returns distinct normalized assignee options', async () => {
    const { GET } = await import('@/app/api/tasks/filter-options/route');
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      assignees: ['alice', 'bob'],
    });
    expect(selectDistinct).toHaveBeenCalledWith({ assignee: 'assignee' });
  });
});
