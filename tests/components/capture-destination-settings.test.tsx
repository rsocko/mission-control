import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CaptureDestinationSection } from '@/app/settings/components/CaptureSettingsSection';

describe('capture destination settings', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return {
        ok: true,
        json: async () => {
          if (url.includes('/capture-destination')) {
            return { destination: { connectorType: 'local' } };
          }
          if (url.includes('/features')) {
            return { taskDestinations: [] };
          }
          return { sourceLists: [] };
        },
      };
    }));
  });

  it('renders one icon for the selected destination', async () => {
    render(<CaptureDestinationSection />);

    const destination = await screen.findByRole('combobox', { name: 'Destination' });

    expect(destination.querySelectorAll('img[alt="local"]')).toHaveLength(1);
  });
});
