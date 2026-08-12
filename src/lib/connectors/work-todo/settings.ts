import { z } from 'zod';
import type { ConnectorCapabilities } from '@/types';

export const workTodoSettingsSchema = z.object({
  transport: z.enum(['power-automate-standard', 'power-automate-graph']),
  capabilityProfile: z.enum(['standard-v1', 'extended-v1']),
}).strict().refine(
  (value) => (
    value.transport === 'power-automate-standard'
      ? value.capabilityProfile === 'standard-v1'
      : value.capabilityProfile === 'extended-v1'
  ),
  { message: 'Transport and capability profile must describe the same bridge tier' },
);

export type WorkTodoSettings = z.infer<typeof workTodoSettingsSchema>;

export function capabilitiesForWorkTodo(
  settings: WorkTodoSettings,
): ConnectorCapabilities {
  const extended = settings.capabilityProfile === 'extended-v1';
  return {
    read: true,
    write: true,
    delete: false,
    sync: true,
    subtasks: false,
    lists: true,
    tags: true,
    tagWriteBack: false,
    priority: true,
    priorityWriteBack: true,
    dueDate: true,
    microStatusSync: extended,
    microStatusWriteBack: false,
    listSelectionMode: 'optional',
    tagScope: 'global',
    tagCreationMode: 'predefined',
    managedRecurrence: extended,
    attachments: false,
    taskCreate: false,
    taskMove: false,
  };
}
