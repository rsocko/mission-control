import { act, renderHook } from '@testing-library/react';
import {
  SETTINGS_SEARCH_ITEMS,
  findSettingsTarget,
  searchSettings,
  useSettingsUrlTarget,
} from '@/app/settings/settings-search';

describe('searchSettings', () => {
  it('returns nothing for a blank query', () => {
    expect(searchSettings('   ')).toEqual([]);
  });

  it('prioritizes title matches', () => {
    expect(searchSettings('cache').map(item => item.title).slice(0, 2)).toEqual([
      'Storage & Cache',
      'Thumbnail Cache',
    ]);
  });

  it('finds settings by aliases and keywords', () => {
    expect(searchSettings('llm')[0]?.title).toBe('AI Model');
    expect(searchSettings('mute')[0]?.title).toBe('Do Not Disturb');
    expect(searchSettings('paperless')[0]?.title).toBe('OWL');
    expect(searchSettings('document intelligence')[0]?.title).toBe('OWL');
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
      <h2>AI Provider</h2>
      <label>Base URL (default: local)</label>
      <button aria-label="Test connection">Test</button>
    `;

    expect(findSettingsTarget(root, 'Base URL', 'AI Provider').target?.tagName).toBe('LABEL');
    expect(findSettingsTarget(root, 'Test connection', 'AI Provider').target?.tagName).toBe('BUTTON');
    expect(findSettingsTarget(root, 'API Key', 'AI Provider').sectionHeading?.textContent).toBe('AI Provider');
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
