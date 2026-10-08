import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ExecutionDestinationIcon } from '@/components/task-delegation/ExecutionDestinationIcon';

describe('ExecutionDestinationIcon', () => {
  it('reuses the established GitHub and Scout connector marks', () => {
    const { container, rerender } = render(
      <ExecutionDestinationIcon type="copilot-cloud" />,
    );

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/icons/connectors/github.svg',
    );

    rerender(<ExecutionDestinationIcon type="pull-queue" />);

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/icons/connectors/scout.svg',
    );
  });

  it('uses the Paperclip brand mark instead of a generic attachment icon', () => {
    const { container } = render(
      <ExecutionDestinationIcon type="paperclip" />,
    );

    expect(container.querySelector('svg path')).toHaveAttribute(
      'd',
      'm16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551',
    );
  });
});
