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

    expect(container.querySelector('img')).toHaveAttribute(
      'src',
      '/icons/connectors/paperclip.svg',
    );
  });
});
