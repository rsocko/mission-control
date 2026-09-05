import type {
  CrossAccountTaskMoveInput,
  TaskMoveServiceResult,
} from './task-move-service';
import { getProcessRuntimeSlot } from '@/lib/runtime/process-runtime-slot';

export interface CrossAccountTaskMoveService {
  execute(
    sourceConnectorInstanceId: string,
    input: CrossAccountTaskMoveInput,
    traceId?: string,
  ): Promise<TaskMoveServiceResult>;
}

interface CrossAccountTaskMoveServiceRegistry {
  service: CrossAccountTaskMoveService | null;
}

const REGISTRY_KEY = 'mission-control.cross-account-task-move-service';
const REGISTRY_SCHEMA_VERSION = 1;

function registry(): CrossAccountTaskMoveServiceRegistry {
  return getProcessRuntimeSlot(REGISTRY_KEY, REGISTRY_SCHEMA_VERSION, () => ({
    service: null,
  }));
}

export function registerCrossAccountTaskMoveService(
  service: CrossAccountTaskMoveService,
): void {
  registry().service = service;
}

export function getCrossAccountTaskMoveService(): CrossAccountTaskMoveService {
  const { service } = registry();
  if (!service) {
    throw new Error('Cross-account task move service has not been registered');
  }
  return service;
}

export function _resetCrossAccountTaskMoveServiceForTests(): void {
  registry().service = null;
}
