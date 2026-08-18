import { beforeEach, describe, expect, it, vi } from 'vitest';

const fsState = vi.hoisted(() => ({
  settings: '',
  writes: [] as string[],
}));

vi.mock('fs', () => ({
  default: {
    existsSync: () => true,
    readFileSync: () => fsState.settings,
    mkdirSync: vi.fn(),
    writeFileSync: (_path: string, content: string) => {
      fsState.writes.push(content);
    },
  },
}));

import { getShortcuts } from '@/lib/mode';

describe('legacy taskbar shortcut migration', () => {
  beforeEach(() => {
    fsState.writes = [];
    fsState.settings = JSON.stringify({
      mode: 'live',
      shortcuts: [
        { id: 'today', name: 'Today', url: '/today', description: 'Old', icon: 'old.svg', enabled: true },
        { id: 'triage', name: 'Triage', url: '/triage', description: 'Old', icon: 'old.svg', enabled: true },
        { id: 'projects', name: 'Projects', url: '/projects', description: 'Old', icon: 'old.svg', enabled: true },
        { id: 'dashboard', name: 'Dashboard', url: '/', description: 'Old', icon: 'old.svg', enabled: true },
      ],
    });
  });

  it('preserves Icon Finder and the first three prioritized shortcuts within the limit', () => {
    const shortcuts = getShortcuts();

    expect(shortcuts.map(shortcut => [shortcut.url, shortcut.enabled])).toEqual([
      ['/icons', true],
      ['/today', true],
      ['/triage', true],
      ['/projects', true],
      ['/', false],
    ]);
    expect(shortcuts[1]).toMatchObject({
      name: 'My Day',
      icon: 'shortcut-today.svg',
      description: 'View today\'s tasks',
    });

    const persisted = JSON.parse(fsState.writes[0]);
    expect(persisted.shortcutConfigVersion).toBe(2);
    expect(persisted.shortcuts).toEqual(shortcuts);
  });
});
