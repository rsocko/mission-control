import { describe, expect, it, vi } from 'vitest';
import { redirect } from 'next/navigation';
import GraphPage from '@/app/graph/page';

vi.mock('next/navigation', () => ({
  redirect: vi.fn(),
}));

describe('/graph landing route', () => {
  it('lands on the first dedicated graph workspace', () => {
    GraphPage();

    expect(redirect).toHaveBeenCalledWith('/graph/ideation');
  });
});
