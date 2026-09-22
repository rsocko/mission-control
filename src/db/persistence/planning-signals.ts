export const PLANNING_FRICTION_EVENT_TYPES = [
  'due_date_pushed',
  'my_day_missed',
  'focus_missed',
  'snooze_extended',
  'scheduled_block_elapsed',
  'became_overdue',
] as const;

export type PlanningFrictionEventType = typeof PLANNING_FRICTION_EVENT_TYPES[number];

export type PlanningSignalType =
  | Exclude<PlanningFrictionEventType, 'due_date_pushed' | 'snooze_extended'>
  | 'my_day_committed'
  | 'my_day_withdrawn'
  | 'focus_committed'
  | 'focus_withdrawn';

export interface PlanningSignalInput {
  taskId: string;
  eventType: PlanningSignalType;
  date: string;
  occurredAt: string;
  provenance: string;
  metadata?: Record<string, unknown>;
}

export interface PlanningSignalFinalizationResult {
  commitmentsBackfilled: number;
  myDayMisses: number;
  focusMisses: number;
  elapsedBlocks: number;
  overdueTransitions: number;
}

export interface PlanningSignalRepository {
  append(input: PlanningSignalInput): Promise<boolean>;
  finalize(today: string): Promise<PlanningSignalFinalizationResult>;
  finalizeIfDue(input: {
    today: string;
    now: Date;
  }): Promise<PlanningSignalFinalizationResult | null>;
}
