import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LocalSourceIcon } from '@/components/ui/LocalSourceIcon';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';

describe('LocalSourceIcon', () => {
  it('renders the canonical Local asset at the requested size', () => {
    const { container } = render(<LocalSourceIcon size={16} />);

    const icon = container.querySelector('img');
    expect(icon).toHaveAttribute('src', LOCAL_CONNECTOR_ICON_PATH);
    expect(icon).toHaveAttribute('width', '16');
    expect(icon).toHaveAttribute('height', '16');
    expect(icon).toHaveAttribute('alt', '');
  });
});
