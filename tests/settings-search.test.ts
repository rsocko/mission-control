import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { createElement } from 'react';
import {
  SETTINGS_SEARCH_ITEMS,
  findSettingsTarget,
  focusSettingsTarget,
  searchSettings,
  useSettingsUrlTarget,
} from '@/app/settings/settings-search';
import {
  DesktopSettingsSubsections,
  SETTINGS_SUBSECTIONS,
  focusSettingsSubsection,
} from '@/app/settings/components/SettingsSubsectionNavigation';

describe('searchSettings', () => {
  it('returns nothing for a blank query', () => {
    expect(searchSettings('   ')).toEqual([]);
  });

  describe('settings subsection navigation', () => {
    it('keeps subsection lists curated and free of duplicate anchors', () => {
      for (const subsections of Object.values(SETTINGS_SUBSECTIONS)) {
        expect(subsections.length).toBeGreaterThanOrEqual(3);
        expect(subsections.length).toBeLessThanOrEqual(6);
        expect(new Set(subsections.map(subsection => subsection.id)).size).toBe(subsections.length);
      }
    });

    it('scrolls and focuses a subsection landmark', () => {
      const root = document.createElement('main');
      root.innerHTML = '<h3 data-settings-subsection="completion-route">Completion route</h3>';
      const target = root.querySelector('h3') as HTMLElement;
      target.scrollIntoView = vi.fn();
      window.matchMedia = vi.fn().mockReturnValue({ matches: true });
      document.body.append(root);

      expect(focusSettingsSubsection(root, 'completion-route')).toBe(true);
      expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'start' });
      expect(document.activeElement).toBe(target);
      expect(focusSettingsSubsection(root, 'missing')).toBe(false);
      root.remove();
    });

    it('updates the stable hash when a subsection is selected', () => {
      const root = document.createElement('main');
      root.innerHTML = '<h3 data-settings-subsection="embedding-route">Embedding route</h3>';
      const target = root.querySelector('h3') as HTMLElement;
      target.scrollIntoView = vi.fn();
      document.body.append(root);
      window.matchMedia = vi.fn().mockReturnValue({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      });

      const { unmount } = render(createElement(DesktopSettingsSubsections, {
        section: 'ai',
        rootRef: { current: root },
      }));
      fireEvent.click(screen.getByRole('button', { name: 'Embedding route' }));

      expect(window.location.hash).toBe('#embedding-route');
      expect(target.scrollIntoView).toHaveBeenCalled();
      unmount();
      root.remove();
      window.history.replaceState(null, '', '/');
    });
  });

  it('prioritizes title matches', () => {
    expect(searchSettings('cache').map(item => item.title).slice(0, 2)).toEqual([
      'Storage & Cache',
      'Thumbnail Cache',
    ]);
  });

  it('finds settings by aliases and keywords', () => {
    expect(searchSettings('llm')[0]?.title).toBe('AI Model');
    expect(searchSettings('delegate')[0]?.title).toBe('Execution Destinations');
    expect(searchSettings('paperclip')[0]?.title).toBe('Paperclip routes');
    expect(searchSettings('mute')[0]?.title).toBe('Do Not Disturb');
    expect(searchSettings('paperless')[0]?.title).toBe('OWL');
    expect(searchSettings('document intelligence')[0]?.title).toBe('OWL');
    expect(searchSettings('sync icon')[0]?.title).toBe('Sync icon animation');
    expect(searchSettings('app version')[0]?.title).toBe('About Mission Control');
    expect(searchSettings('license')[0]?.title).toBe('Licensing status');
    expect(searchSettings('commit sha')[0]?.title).toBe('Build');
  });

  it('requires every query term to match', () => {
    expect(searchSettings('storage maintenance')[0]?.title).toBe('Maintenance Actions');
    expect(searchSettings('storage notification')).toEqual([]);
  });

  it('limits the number of results', () => {
    expect(searchSettings('notification', 2)).toHaveLength(2);
  });

  it('uses the rendered navigation badge heading as its target', () => {
    const item = SETTINGS_SEARCH_ITEMS.find(entry => entry.title === 'Navigation badges');
    expect(item?.target).toBe('Navigation tab badges');
  });

  it('resolves exact, partial, and section fallback targets', () => {
    const root = document.createElement('main');
    root.innerHTML = `
      <h2>AI &amp; Agents</h2>
      <label>Base URL (default: local)</label>
      <button aria-label="Test connection">Test</button>
    `;

    expect(findSettingsTarget(root, 'Base URL', 'AI & Agents').target?.tagName).toBe('LABEL');
    expect(findSettingsTarget(root, 'Test connection', 'AI & Agents').target?.tagName).toBe('BUTTON');
    expect(findSettingsTarget(root, 'API Key', 'AI & Agents').sectionHeading?.textContent).toBe('AI & Agents');
  });

  it('focuses and makes a non-interactive search result keyboard addressable', () => {
    const root = document.createElement('main');
    root.innerHTML = '<h2>AI &amp; Agents</h2><label>Base URL</label>';
    const target = root.querySelector('label') as HTMLElement;
    target.scrollIntoView = vi.fn();
    window.matchMedia = vi.fn().mockReturnValue({ matches: true });
    document.body.append(root);

    expect(focusSettingsTarget(root, 'Base URL', 'AI & Agents')).toBe(true);
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    expect(target.scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    root.remove();
  });

  it('updates the target for same-section browser history navigation', () => {
    window.history.replaceState(null, '', '/settings/general?setting=Timezone');
    const { result, unmount } = renderHook(() => useSettingsUrlTarget());
    expect(result.current[0]).toBe('Timezone');

    act(() => {
      window.history.pushState(null, '', '/settings/general?setting=Completion%20animation');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(result.current[0]).toBe('Completion animation');
    unmount();
    window.history.replaceState(null, '', '/');
  });
});
