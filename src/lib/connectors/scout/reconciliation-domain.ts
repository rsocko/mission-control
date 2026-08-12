import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  SCOUT_SOURCE_TYPES,
  type ScoutAutonomySettings,
  type ScoutSourceType,
} from './settings';

export const RECONCILIATION_SIGNAL_KINDS = [
  'planner-completed',
  'user-confirmed-complete',
  'requester-confirmed-resolved',
  'meeting-confirmed-complete',
  'teams-confirmed-handled',
  'source-cancelled',
  'superseded',
  'inactivity',
  'urgent',
  'blocked',
  'ambiguous',
  'sensitive',
] as const;

export type ReconciliationSignalKind = typeof RECONCILIATION_SIGNAL_KINDS[number];
export type ReconciliationAction = 'auto-complete' | 'suggest-complete' | 'escalate' | 'no-change';
export type ReconciliationPolicyDecision = 'allow' | 'require-confirmation' | 'deny' | 'not-applicable';

const SIGNAL_WEIGHTS: Record<ReconciliationSignalKind, number> = {
  'planner-completed': 0.98,
  'user-confirmed-complete': 0.96,
  'requester-confirmed-resolved': 0.94,
  'meeting-confirmed-complete': 0.82,
  'teams-confirmed-handled': 0.8,
  'source-cancelled': 0.68,
  superseded: 0.65,
  inactivity: 0.15,
  urgent: 0.85,
  blocked: 0.72,
  ambiguous: 0,
  sensitive: 0,
};

const RESOLUTION_KINDS = new Set<ReconciliationSignalKind>([
  'planner-completed',
  'user-confirmed-complete',
  'requester-confirmed-resolved',
  'meeting-confirmed-complete',
  'teams-confirmed-handled',
  'source-cancelled',
  'superseded',
  'inactivity',
]);

const ESCALATION_KINDS = new Set<ReconciliationSignalKind>(['urgent', 'blocked']);

const SOURCE_KIND_COMPATIBILITY: Partial<Record<ReconciliationSignalKind, readonly ScoutSourceType[]>> = {
  'planner-completed': ['planner'],
  'meeting-confirmed-complete': ['meeting'],
  'teams-confirmed-handled': ['teams'],
  'requester-confirmed-resolved': ['email', 'teams', 'cross-source'],
  'user-confirmed-complete': ['email', 'teams', 'meeting', 'cross-source'],
};

const oneLineSummary = z.string()
  .trim()
  .min(1)
  .max(240)
  .refine((value) => !/[\r\n\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value), {
    message: 'summary must be a single printable line',
  });

export const reconciliationSignalSchema = z.object({
  signalId: z.string().trim().min(1).max(160),
  taskId: z.string().trim().min(1).max(200),
  sourceType: z.enum(SCOUT_SOURCE_TYPES),
  kind: z.enum(RECONCILIATION_SIGNAL_KINDS),
  occurredAt: z.iso.datetime({ offset: true }),
  summary: oneLineSummary,
  sourceRefHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict().superRefine((signal, context) => {
  const compatibleSources = SOURCE_KIND_COMPATIBILITY[signal.kind];
  if (compatibleSources && !compatibleSources.includes(signal.sourceType)) {
    context.addIssue({
      code: 'custom',
      path: ['kind'],
      message: `${signal.kind} is not valid for ${signal.sourceType} evidence`,
    });
  }
});

export type ReconciliationSignal = z.infer<typeof reconciliationSignalSchema>;

export const reconcileRequestSchema = z.object({
  scope: z.string().trim().max(240).default('all'),
  lookbackHours: z.number().int().min(1).max(168).default(48),
  dryRun: z.boolean().default(false),
  source: z.enum(['api', 'automation']).default('api'),
  sourceIdentity: z.string().trim().min(1).max(160).default('manual'),
  idempotencyKey: z.string().trim().min(8).max(200).optional(),
  signals: z.array(reconciliationSignalSchema).max(500).default([]),
}).strict();

export type ReconcileRequest = z.infer<typeof reconcileRequestSchema>;

export interface ReconciliationScope {
  type: 'all' | 'project' | 'task';
  id: string | null;
  key: string;
}

export interface ScoredEvidence {
  candidateAction: ReconciliationAction;
  confidence: number;
  sensitive: boolean;
  ambiguous: boolean;
  sourceTypes: ScoutSourceType[];
  suggestedPriority: 'high' | 'critical' | null;
}

export interface ReconciliationPolicyInput {
  task: {
    connectorType: string;
    priority: string;
    dueDate: string | null;
  };
  score: ScoredEvidence;
  neverAutoComplete: boolean;
  connectorEnabled: boolean;
  autonomy: ScoutAutonomySettings;
  evidenceVerified: boolean;
  now: Date;
}

export interface ReconciliationPolicyResult {
  action: ReconciliationAction;
  decision: ReconciliationPolicyDecision;
  reason: string;
}

export function parseReconciliationScope(value: string): ReconciliationScope {
  if (value === 'all') return { type: 'all', id: null, key: 'all' };
  const separator = value.indexOf(':');
  if (separator < 1) throw new Error('scope must be "all", "project:<id>", or "task:<id>"');
  const type = value.slice(0, separator);
  const id = value.slice(separator + 1).trim();
  if ((type !== 'project' && type !== 'task') || !id || id.length > 200) {
    throw new Error('scope must be "all", "project:<id>", or "task:<id>"');
  }
  return { type, id, key: `${type}:${id}` };
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function combinedConfidence(signals: ReconciliationSignal[], allowedKinds: Set<ReconciliationSignalKind>): number {
  const strongestWeightByArtifact = new Map<string, number>();
  for (const signal of signals.filter((entry) => allowedKinds.has(entry.kind))) {
    strongestWeightByArtifact.set(
      signal.sourceRefHash,
      Math.max(strongestWeightByArtifact.get(signal.sourceRefHash) ?? 0, SIGNAL_WEIGHTS[signal.kind]),
    );
  }
  return rounded(1 - [...strongestWeightByArtifact.values()]
    .reduce((remaining, weight) => remaining * (1 - weight), 1));
}

export function resolutionEvidenceSourceRefHashes(signals: ReconciliationSignal[]): string[] {
  return [...new Set(signals
    .filter((signal) => RESOLUTION_KINDS.has(signal.kind))
    .map((signal) => signal.sourceRefHash))];
}

export function scoreReconciliationEvidence(signals: ReconciliationSignal[]): ScoredEvidence {
  const resolutionConfidence = combinedConfidence(signals, RESOLUTION_KINDS);
  const escalationConfidence = combinedConfidence(signals, ESCALATION_KINDS);
  const candidateAction: ReconciliationAction = resolutionConfidence >= 0.9
    ? 'auto-complete'
    : resolutionConfidence >= 0.6
      ? 'suggest-complete'
      : escalationConfidence >= 0.6
        ? 'escalate'
        : 'no-change';
  const confidence = candidateAction === 'escalate' ? escalationConfidence : resolutionConfidence;

  return {
    candidateAction,
    confidence,
    sensitive: signals.some((signal) => signal.kind === 'sensitive'),
    ambiguous: signals.some((signal) => signal.kind === 'ambiguous'),
    sourceTypes: [...new Set(signals.map((signal) => signal.sourceType))].sort(),
    suggestedPriority: candidateAction === 'escalate'
      ? escalationConfidence >= 0.9 ? 'critical' : 'high'
      : null,
  };
}

export function evaluateReconciliationPolicy(input: ReconciliationPolicyInput): ReconciliationPolicyResult {
  const { task, score, now } = input;
  if (score.candidateAction === 'no-change') {
    return { action: 'no-change', decision: 'not-applicable', reason: 'No qualifying resolution or escalation evidence' };
  }
  if (score.candidateAction === 'escalate') {
    return {
      action: 'escalate',
      decision: 'require-confirmation',
      reason: 'Priority changes require user confirmation',
    };
  }
  if (score.candidateAction === 'suggest-complete') {
    return {
      action: 'suggest-complete',
      decision: 'require-confirmation',
      reason: 'Resolution confidence is below the autonomous completion threshold',
    };
  }
  if (task.connectorType !== 'scout') {
    return { action: 'suggest-complete', decision: 'deny', reason: 'Only Scout-originated tasks are eligible' };
  }
  if (!input.connectorEnabled) {
    return { action: 'suggest-complete', decision: 'deny', reason: 'The Scout connector is disabled' };
  }
  if (task.priority === 'high' || task.priority === 'critical') {
    return { action: 'suggest-complete', decision: 'deny', reason: 'High-priority tasks cannot be auto-completed' };
  }
  if (task.dueDate && new Date(task.dueDate).getTime() > now.getTime()) {
    return { action: 'suggest-complete', decision: 'deny', reason: 'Tasks with future due dates cannot be auto-completed' };
  }
  if (input.neverAutoComplete) {
    return { action: 'suggest-complete', decision: 'deny', reason: 'The task is permanently excluded from auto-completion' };
  }
  if (score.sensitive) {
    return { action: 'suggest-complete', decision: 'deny', reason: 'Sensitive evidence requires user confirmation' };
  }
  if (score.ambiguous) {
    return { action: 'suggest-complete', decision: 'deny', reason: 'Ambiguous evidence requires user confirmation' };
  }
  if (!input.evidenceVerified) {
    return {
      action: 'suggest-complete',
      decision: 'deny',
      reason: 'Autonomous completion requires provider-verified evidence provenance',
    };
  }

  const matchingPolicy = input.autonomy.autoExecuteActions.find((entry) =>
    entry.action === 'complete-task'
    && entry.target === 'scout-originated'
    && score.confidence >= entry.minimumConfidence
    && score.sourceTypes.length > 0
    && score.sourceTypes.every((sourceType) => entry.sourceTypes.includes(sourceType)));

  if (!matchingPolicy) {
    return {
      action: 'suggest-complete',
      decision: 'require-confirmation',
      reason: 'Autonomous completion is disabled unless an explicit source-scoped policy allows it',
    };
  }

  return {
    action: 'auto-complete',
    decision: 'allow',
    reason: `Explicit completion policy allows ${score.sourceTypes.join(', ')} evidence at ${matchingPolicy.minimumConfidence}`,
  };
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function reconciliationHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(canonicalize(value))).digest('hex');
}

export function summarizeEvidence(signals: ReconciliationSignal[]) {
  return [...signals]
    .sort((left, right) => left.signalId.localeCompare(right.signalId))
    .map(({ signalId, sourceType, kind, occurredAt, summary, sourceRefHash }) => ({
      signalId,
      sourceType,
      kind,
      occurredAt,
      summary,
      sourceRefHash,
    }));
}
