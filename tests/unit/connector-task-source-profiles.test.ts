import { describe, expect, it } from 'vitest';
import { TASK_FIELDS } from '@/lib/tasks/field-policy';
import {
  CONNECTOR_SOURCE_PROFILES,
  DOCUMENT_INTELLIGENCE_FIELD_PROFILE,
  NOTIFICATION_ONLY_CONNECTOR_TYPES,
  TASK_PRODUCING_CONNECTOR_TYPES,
  getTaskSourceProfile,
  resolveConnectorCapabilities,
} from '@/lib/connectors/task-source-profiles';
import type { ConnectorCapabilities } from '@/types';

const BASE_CAPABILITIES: ConnectorCapabilities = {
  read: true,
  write: false,
  delete: false,
  sync: true,
  subtasks: false,
  lists: true,
  tags: false,
  tagWriteBack: false,
};

describe('connector task source profiles', () => {
  it('classifies every registered connector exactly once', () => {
    const classified = [
      ...TASK_PRODUCING_CONNECTOR_TYPES,
      ...NOTIFICATION_ONLY_CONNECTOR_TYPES,
    ];

    expect(new Set(classified).size).toBe(classified.length);
    expect([...classified].sort()).toEqual(
      Object.keys(CONNECTOR_SOURCE_PROFILES).sort(),
    );
  });

  it.each(TASK_PRODUCING_CONNECTOR_TYPES)(
    '%s has an explicit source model and complete field profile',
    (type) => {
      const profile = CONNECTOR_SOURCE_PROFILES[type];
      expect(profile.production).toBe('tasks');
      expect(profile.sourceModel).toMatch(/^(remote-managed|remote-mirror|ingested)$/);
      expect(Object.keys(profile.fieldProfile).sort()).toEqual([...TASK_FIELDS].sort());
    },
  );

  it.each(NOTIFICATION_ONLY_CONNECTOR_TYPES)(
    '%s is excluded from task source profiles',
    (type) => {
      expect(CONNECTOR_SOURCE_PROFILES[type].production).toBe('notifications-only');
      expect(getTaskSourceProfile(type)).toBeNull();
    },
  );

  it('models Document Intelligence as status-only write-through', () => {
    expect(DOCUMENT_INTELLIGENCE_FIELD_PROFILE.status).toEqual({
      authority: 'source',
      writeBack: 'direct',
    });
    expect(DOCUMENT_INTELLIGENCE_FIELD_PROFILE.title).toEqual({
      authority: 'source',
      writeBack: 'none',
    });
    expect(DOCUMENT_INTELLIGENCE_FIELD_PROFILE.effort).toEqual({
      authority: 'local',
      writeBack: 'none',
    });
  });

  it.each([
    [{}, 'remote-mirror', false, false],
    [{ createEndpoint: '/tasks' }, 'remote-mirror', false, true],
    [{ updateEndpoint: 'PATCH /tasks/:id' }, 'remote-managed', true, false],
    [{
      createEndpoint: '/tasks',
      updateEndpoint: 'PATCH /tasks/:id',
      deleteEndpoint: '/tasks/:id',
    }, 'remote-managed', true, true],
  ] as const)(
    'resolves Custom REST settings %o independently for create, update, and delete',
    (settings, model, writable, creatable) => {
      const capabilities = resolveConnectorCapabilities(
        'custom-rest',
        BASE_CAPABILITIES,
        settings,
      );

      expect(capabilities.taskSourceModel).toBe(model);
      expect(capabilities.write).toBe(writable);
      expect(capabilities.taskCreate).toBe(creatable);
      expect(capabilities.delete).toBe('deleteEndpoint' in settings);
    },
  );

  it.each([
    ['local', 'mc-owned'],
    ['mission-control', 'mc-owned'],
    ['inbound-webhook', 'ingested'],
  ] as const)('defines the built-in %s source explicitly', (type, sourceModel) => {
    const profile = getTaskSourceProfile(type);
    expect(profile?.sourceModel).toBe(sourceModel);
    expect(Object.keys(profile?.fieldProfile ?? {}).sort()).toEqual([...TASK_FIELDS].sort());
  });
});
