import { render, waitFor } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderedValues = vi.hoisted(() => [] as number[]);

vi.mock('@number-flow/react', () => ({
  default: ({ value }: { value: number }) => {
    renderedValues.push(value);
    return <span>{value}</span>;
  },
}));

describe('AnimatedCounter', () => {
  beforeEach(() => {
    renderedValues.length = 0;
  });

  it('flows from zero to the initial value and continues flowing on updates', async () => {
    const { AnimatedCounter } = await import('@/components/ui/AnimatedCounter');
    const rendered = render(<AnimatedCounter value={42} />);

    expect(renderedValues[0]).toBe(0);
    await waitFor(() => expect(renderedValues.at(-1)).toBe(42));

    rendered.rerender(<AnimatedCounter value={18} />);
    await waitFor(() => expect(renderedValues.at(-1)).toBe(18));
  });
});
