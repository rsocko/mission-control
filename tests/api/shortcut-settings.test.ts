import { beforeEach, describe, expect, it, vi } from 'vitest';

const modeMocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
}));

vi.mock('@/lib/mode', () => ({
  getShortcuts: () => [],
  getLaunchMode: () => 'navigate-existing',
  updateSettings: modeMocks.updateSettings,
  DEFAULT_SHORTCUTS: [],
  MAX_ENABLED_SHORTCUTS: 4,
  SHORTCUT_CONFIG_VERSION: 2,
}));

import { PUT } from '@/app/api/settings/shortcuts/route';

describe('taskbar shortcut settings API', () => {
  beforeEach(() => {
    modeMocks.updateSettings.mockReset();
  });

  it('canonicalizes shortcut labels and icons from the navigation catalog', async () => {
    const response = await PUT(new Request('http://localhost/api/settings/shortcuts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shortcuts: [{
          id: 'changed',
          name: 'Changed',
          url: '/today',
          description: 'Changed',
          icon: '../changed.svg',
          enabled: true,
        }],
        launchMode: 'navigate-existing',
      }),
    }));

    expect(response.status).toBe(200);
    expect(modeMocks.updateSettings).toHaveBeenCalledWith({
      shortcuts: [{
        id: 'today',
        name: 'My Day',
        url: '/today',
        description: 'View today\'s tasks',
        icon: 'shortcut-today.svg',
        enabled: true,
        openInNewWindow: false,
      }],
      shortcutConfigVersion: 2,
      launchMode: 'navigate-existing',
    });
  });

  it('rejects unsupported and duplicate shortcut URLs', async () => {
    const unsupported = await PUT(new Request('http://localhost/api/settings/shortcuts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shortcuts: [{ url: '/unknown', enabled: true }] }),
    }));
    const duplicate = await PUT(new Request('http://localhost/api/settings/shortcuts', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shortcuts: [
          { url: '/today', enabled: true },
          { url: '/today', enabled: false },
        ],
      }),
    }));

    expect(unsupported.status).toBe(400);
    expect(duplicate.status).toBe(400);
    expect(modeMocks.updateSettings).not.toHaveBeenCalled();
  });
});
