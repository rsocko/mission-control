import type { PersistenceJson } from '@/db/persistence/contracts';
import type { SettingsRepository } from '@/db/persistence/core-repositories';
import { getCorePersistenceRepositoriesForBackend } from '@/lib/persistence/runtime';

export interface CaptureDestinationSetting {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
}

export interface InboxListEntry {
  connectorType: string;
  sourceListId?: string;
  sourceListName?: string;
  label?: string;
}

export interface DopamineReward {
  id: string;
  emoji: string;
  label: string;
}

export interface DopamineMenuSettings {
  enabled: boolean;
  threshold: number;
  rewards: DopamineReward[];
}

export type DopamineMenuSettingsPatch = Partial<DopamineMenuSettings>;

export const DEFAULT_CAPTURE_DESTINATION: CaptureDestinationSetting = {
  connectorType: 'local',
};

export const DEFAULT_DOPAMINE_MENU_SETTINGS: DopamineMenuSettings = {
  enabled: true,
  threshold: 5,
  rewards: [
    { id: '1', emoji: '☕', label: 'Coffee break' },
    { id: '2', emoji: '🎵', label: 'Fresh playlist' },
    { id: '3', emoji: '🚶', label: '10-min walk' },
    { id: '4', emoji: '📱', label: 'Phone break' },
    { id: '5', emoji: '🎮', label: 'Quick game' },
    { id: '6', emoji: '✨', label: 'Your choice' },
  ],
};

const CAPTURE_DESTINATION_KEY = 'capture.defaultDestination';
const DOPAMINE_MENU_KEY = 'dopamine-menu';
const INBOX_LISTS_KEY = 'inbox.lists';

export interface PreferenceSettingsRepository {
  getCaptureDestination(): Promise<CaptureDestinationSetting>;
  setCaptureDestination(destination: CaptureDestinationSetting): Promise<void>;
  getDopamineMenu(): Promise<DopamineMenuSettings>;
  patchDopamineMenu(patch: DopamineMenuSettingsPatch): Promise<DopamineMenuSettings>;
  getInboxLists(): Promise<InboxListEntry[]>;
  setInboxLists(lists: InboxListEntry[]): Promise<void>;
}

function asPersistenceJson(value: object): PersistenceJson {
  return value as PersistenceJson;
}

export class CorePreferenceSettingsRepository implements PreferenceSettingsRepository {
  constructor(private readonly settings: SettingsRepository) {}

  async getCaptureDestination(): Promise<CaptureDestinationSetting> {
    const value = await this.settings.get(CAPTURE_DESTINATION_KEY);
    return value === null
      ? DEFAULT_CAPTURE_DESTINATION
      : value as unknown as CaptureDestinationSetting;
  }

  async setCaptureDestination(destination: CaptureDestinationSetting): Promise<void> {
    await this.settings.set(CAPTURE_DESTINATION_KEY, asPersistenceJson(destination));
  }

  async getDopamineMenu(): Promise<DopamineMenuSettings> {
    const stored = await this.settings.get(DOPAMINE_MENU_KEY) as
      | Partial<DopamineMenuSettings>
      | null;
    return {
      enabled: stored?.enabled ?? DEFAULT_DOPAMINE_MENU_SETTINGS.enabled,
      threshold: stored?.threshold ?? DEFAULT_DOPAMINE_MENU_SETTINGS.threshold,
      rewards: stored?.rewards ?? DEFAULT_DOPAMINE_MENU_SETTINGS.rewards,
    };
  }

  async patchDopamineMenu(
    patch: DopamineMenuSettingsPatch,
  ): Promise<DopamineMenuSettings> {
    const current = await this.getDopamineMenu();
    const updated: DopamineMenuSettings = {
      enabled: patch.enabled ?? current.enabled,
      threshold: patch.threshold ?? current.threshold,
      rewards: patch.rewards ?? current.rewards,
    };
    await this.settings.set(DOPAMINE_MENU_KEY, asPersistenceJson(updated));
    return updated;
  }

  async getInboxLists(): Promise<InboxListEntry[]> {
    const value = await this.settings.get(INBOX_LISTS_KEY);
    return value === null ? [] : value as unknown as InboxListEntry[];
  }

  async setInboxLists(lists: InboxListEntry[]): Promise<void> {
    await this.settings.set(INBOX_LISTS_KEY, asPersistenceJson(lists));
  }
}

export async function getPreferenceSettingsRepositoryForBackend(): Promise<
  PreferenceSettingsRepository
> {
  const repositories = await getCorePersistenceRepositoriesForBackend();
  return new CorePreferenceSettingsRepository(repositories.settings);
}
