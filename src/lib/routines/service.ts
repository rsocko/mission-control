import type {
  CreateRoutineCommand,
  CreateRoutineCompletionCommand,
  RoutineCompletionQuery,
  UpdateRoutineCommand,
} from '@/db/persistence/routines';
import { getWorkerPersistenceRepositories } from '@/lib/persistence/worker-runtime';

export { ROUTINE_CADENCE_TYPES } from '@/db/persistence/routines';
export type { RoutineCadenceType, RoutineUpdate } from '@/db/persistence/routines';

async function repository() {
  return (await getWorkerPersistenceRepositories()).routines;
}

export async function listRoutines(includeArchived: boolean) {
  return (await repository()).listRoutines(includeArchived);
}

export async function getRoutine(id: string) {
  return (await repository()).getRoutine(id);
}

export async function createRoutine(command: CreateRoutineCommand) {
  return (await repository()).createRoutine(command);
}

export async function updateRoutine(id: string, command: UpdateRoutineCommand) {
  return (await repository()).updateRoutine(id, command);
}

export async function archiveRoutine(id: string, updatedAt: string) {
  return (await repository()).archiveRoutine(id, updatedAt);
}

export async function listRoutineCompletions(query: RoutineCompletionQuery) {
  return (await repository()).listCompletions(query);
}

export async function createRoutineCompletion(command: CreateRoutineCompletionCommand) {
  return (await repository()).createCompletion(command);
}

export async function deleteRoutineCompletionById(id: string) {
  return (await repository()).deleteCompletionById(id);
}

export async function deleteRoutineCompletionsForDate(routineId: string, date: string) {
  return (await repository()).deleteCompletionsForDate(routineId, date);
}
