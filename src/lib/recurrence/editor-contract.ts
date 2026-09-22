import type { CanonicalRecurrenceRuleV1 } from '@/lib/recurrence/canonical';

export type RecurrenceCatchUpPolicy = 'latest' | 'none';

export interface RecurrenceEditorOptions {
  skipDates: string[];
  catchUp: RecurrenceCatchUpPolicy;
}

export interface RecurrenceControlState {
  rule: CanonicalRecurrenceRuleV1 | null;
  owner: 'mission-control' | 'provider';
  support: 'supported' | 'lossy' | 'unsupported';
  reasons: string[];
  timezone: string;
  localTime: string | null;
}

export interface RecurrencePreviewRequest {
  recurrence: string;
  mode: 'schedule' | 'completion';
  startDate: string;
  localTime?: string | null;
  timezone: string;
  options: RecurrenceEditorOptions;
  rule?: CanonicalRecurrenceRuleV1 | null;
}

export interface RecurrencePreviewOccurrence {
  localDate: string;
  localTime: string | null;
  instant: string | null;
}

export type RecurrencePreviewResponse =
  | {
      status: 'success';
      occurrences: RecurrencePreviewOccurrence[];
      conditional: boolean;
    }
  | {
      status: 'unsupported';
      reasons: string[];
    }
  | {
      status: 'invalid';
      issues: string[];
    };

