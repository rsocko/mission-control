import { describe, expect, it } from 'vitest';
import {
  capabilitiesForWorkTodo,
  workTodoSettingsSchema,
} from '@/lib/connectors/work-todo/settings';

describe('Work To Do connector settings', () => {
  it('keeps standard-only fields gated', () => {
    const settings = workTodoSettingsSchema.parse({
      transport: 'power-automate-standard',
      capabilityProfile: 'standard-v1',
    });
    expect(capabilitiesForWorkTodo(settings)).toMatchObject({
      write: true,
      delete: false,
      subtasks: false,
      tagWriteBack: false,
      attachments: false,
      taskCreate: false,
    });
  });

  it('rejects mismatched transport and profile tiers', () => {
    expect(workTodoSettingsSchema.safeParse({
      transport: 'power-automate-standard',
      capabilityProfile: 'extended-v1',
    }).success).toBe(false);
  });

  it('keeps advanced writes gated while accepting extended inbound data', () => {
    const settings = workTodoSettingsSchema.parse({
      transport: 'power-automate-graph',
      capabilityProfile: 'extended-v1',
    });
    expect(capabilitiesForWorkTodo(settings)).toMatchObject({
      microStatusSync: true,
      microStatusWriteBack: false,
      subtasks: false,
      tagWriteBack: false,
      managedRecurrence: true,
      attachments: false,
    });
  });
});
