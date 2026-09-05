import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SettingsRepository } from '@/db/persistence/core-repositories';
import {
  DEFAULT_CAPTURE_DESTINATION,
  DEFAULT_DOPAMINE_MENU_SETTINGS,
  type PreferenceSettingsRepository,
} from '@/lib/settings/preference-settings';

export const PREFERENCE_SETTING_KEYS = [
  'capture.defaultDestination',
  'dopamine-menu',
  'inbox.lists',
] as const;

export interface PreferenceSettingsRepositoryHarness {
  repository: PreferenceSettingsRepository;
  settings: SettingsRepository;
  close(): Promise<void>;
}

export function describePreferenceSettingsRepositoryContract(
  name: string,
  createHarness: () => Promise<PreferenceSettingsRepositoryHarness>,
): void {
  describe(`${name} preference settings repository contract`, () => {
    let harness: PreferenceSettingsRepositoryHarness;

    beforeEach(async () => {
      harness = await createHarness();
      await Promise.all(PREFERENCE_SETTING_KEYS.map((key) => harness.settings.delete(key)));
    });

    afterEach(async () => {
      await Promise.all(PREFERENCE_SETTING_KEYS.map((key) => harness.settings.delete(key)));
      await harness.close();
    });

    it('returns stable defaults when no preferences have been saved', async () => {
      await expect(harness.repository.getCaptureDestination())
        .resolves.toEqual(DEFAULT_CAPTURE_DESTINATION);
      await expect(harness.repository.getInboxLists()).resolves.toEqual([]);
      await expect(harness.repository.getDopamineMenu())
        .resolves.toEqual(DEFAULT_DOPAMINE_MENU_SETTINGS);
    });

    it('round trips capture destination preferences without adding optional fields', async () => {
      const destination = {
        connectorType: 'microsoft-todo',
        connectorInstanceId: 'work',
        sourceListId: 'inbox',
        sourceListName: 'Inbox',
      };

      await harness.repository.setCaptureDestination(destination);

      await expect(harness.repository.getCaptureDestination()).resolves.toEqual(destination);
      await expect(harness.settings.get('capture.defaultDestination'))
        .resolves.toEqual(destination);
    });

    it('preserves inbox-list order and duplicates exactly', async () => {
      const lists = [
        { connectorType: 'microsoft-todo', sourceListId: 'alpha', label: 'First' },
        { connectorType: 'microsoft-todo', sourceListId: 'alpha', label: 'Duplicate' },
        { connectorType: 'local', label: 'Local' },
      ];

      await harness.repository.setInboxLists(lists);

      await expect(harness.repository.getInboxLists()).resolves.toEqual(lists);
    });

    it('merges dopamine patches with stored preferences and deterministic defaults', async () => {
      await harness.settings.set('dopamine-menu', {
        enabled: false,
        rewards: [{ id: 'custom', emoji: '🎯', label: 'Target hit' }],
      });

      await expect(harness.repository.patchDopamineMenu({ threshold: 12 })).resolves.toEqual({
        enabled: false,
        threshold: 12,
        rewards: [{ id: 'custom', emoji: '🎯', label: 'Target hit' }],
      });
      await expect(harness.repository.getDopamineMenu()).resolves.toEqual({
        enabled: false,
        threshold: 12,
        rewards: [{ id: 'custom', emoji: '🎯', label: 'Target hit' }],
      });
    });
  });
}
