import type { PersistenceJson } from './contracts';

export const ROUTINE_CADENCE_TYPES = [
  'daily',
  'specific_days',
  'x_per_week',
  'every_n_days',
  'weekly',
  'monthly',
  'quarterly',
] as const;

export type RoutineCadenceType = typeof ROUTINE_CADENCE_TYPES[number];
export type RoutineCompletionOrder = 'ascending' | 'descending' | 'unspecified';

export interface RoutineRecord {
  id: string;
  name: string;
  description: string | null;
  cadenceType: RoutineCadenceType;
  cadenceConfig: PersistenceJson;
  icon: string | null;
  sortOrder: number;
  isActive: boolean;
  isArchived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineCompletionRecord {
  id: string;
  routineId: string;
  date: string;
  notes: string | null;
  completedAt: string;
}

export interface CreateRoutineCommand {
  id: string;
  name: string;
  description: string | null;
  cadenceType: RoutineCadenceType;
  cadenceConfig: PersistenceJson;
  icon: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoutineUpdate {
  name?: string;
  cadenceType?: RoutineCadenceType;
  cadenceConfig?: PersistenceJson;
  description?: string | null;
  icon?: string | null;
  isActive?: boolean;
  isArchived?: boolean;
  sortOrder?: number;
}

export interface UpdateRoutineCommand {
  updates: RoutineUpdate;
  updatedAt: string;
}

export interface RoutineCompletionQuery {
  fromInclusive: string;
  toInclusive?: string;
  routineId?: string;
  order: RoutineCompletionOrder;
}

export interface CreateRoutineCompletionCommand {
  id: string;
  routineId: string;
  date: string;
  notes: string | null;
  completedAt: string;
}

export type CreateRoutineCompletionResult =
  | { outcome: 'created' }
  | { outcome: 'duplicate' }
  | { outcome: 'routine-not-found' };

/**
 * Backend-neutral routines boundary.
 *
 * Routine creation owns sort allocation. Completion creation owns the
 * cadence-sensitive existence check and insert in one serialized transaction,
 * so daily and specific-day completions remain idempotent under concurrency.
 */
export interface RoutinesRepository {
  listRoutines(includeArchived: boolean): Promise<RoutineRecord[]>;
  getRoutine(id: string): Promise<RoutineRecord | null>;
  createRoutine(command: CreateRoutineCommand): Promise<void>;
  updateRoutine(id: string, command: UpdateRoutineCommand): Promise<boolean>;
  archiveRoutine(id: string, updatedAt: string): Promise<boolean>;
  listCompletions(query: RoutineCompletionQuery): Promise<RoutineCompletionRecord[]>;
  createCompletion(
    command: CreateRoutineCompletionCommand,
  ): Promise<CreateRoutineCompletionResult>;
  deleteCompletionById(id: string): Promise<void>;
  deleteCompletionsForDate(routineId: string, date: string): Promise<void>;
}
