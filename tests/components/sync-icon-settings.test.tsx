import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { SyncIconSettingsCard } from '@/app/settings/components/SyncIconSettingsCard';
import { SYNC_ICON_PREFERENCE_KEY } from '@/lib/hooks/useSyncIconPreference';

describe('SyncIconSettingsCard', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to both treatments and persists a specific selection', async () => {
    render(<SyncIconSettingsCard />);

    const both = screen.getByRole('radio', { name: /Both \(random per sync\)/ });
    const particles = screen.getByRole('radio', { name: /Particle streams/ });

    await waitFor(() => expect(both).toBeChecked());
    fireEvent.click(particles);

    expect(particles).toBeChecked();
    expect(localStorage.getItem(SYNC_ICON_PREFERENCE_KEY)).toBe('particles');
  });
});
