import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { MicroStatusIcon } from '@/components/task-list/MicroStatusIcon';
import type { MicroStatus } from '@/types';

describe('MicroStatusIcon', () => {
  it('uses the filled pause icon for work waiting on someone', () => {
    const { container } = render(<MicroStatusIcon status="waiting_on_someone" />);

    expect(container.querySelector('.lucide-pause')).toHaveAttribute('fill', 'currentColor');
  });

  it.each<MicroStatus>([
    'waiting_on_someone',
    'need_to_think',
    'started_but_stuck',
    'ready_but_unmotivated',
    'done_needs_review',
    'blocked_external',
    'in_research',
    'on_hold',
  ])('renders the shared icon for %s', (status) => {
    const { container } = render(<MicroStatusIcon status={status} />);

    expect(container.querySelector(`[data-micro-status-icon="${status}"]`)).toBeInTheDocument();
  });
});
