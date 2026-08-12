import { describe, expect, it, vi } from 'vitest';
import { initializePublicDemoData } from '@/lib/public-demo-runtime';

describe('public demo runtime', () => {
  it('resets demo data before marking the runtime as seeded', async () => {
    const calls: string[] = [];
    const markSeeded = vi.fn(() => calls.push('mark'));

    await initializePublicDemoData({
      initializeDatabase: () => calls.push('initialize'),
      resetDemoDatabase: async () => { calls.push('reset'); },
      markSeeded,
    });

    expect(calls).toEqual(['initialize', 'reset', 'mark']);
    expect(markSeeded).toHaveBeenCalledWith(expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/));
  });
});
