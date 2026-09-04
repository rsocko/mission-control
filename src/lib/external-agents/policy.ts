import 'server-only';

import { createHash } from 'node:crypto';
import type {
  AgentDataClassification,
  ExternalAgentDataPolicy,
  ExternalAgentLocality,
} from './contracts';
import { DEFAULT_AI_ROUTING_POLICY } from '@/lib/ai/sensitivity-policy';
import { redactPushText } from '@/lib/notifications/push-text';
import { ExternalAgentError } from './errors';

export const DEFAULT_EXTERNAL_AGENT_FIELDS = [
  'instruction',
  'project.id',
  'project.name',
  'repository.fullName',
  'repository.defaultBranch',
  'execution.locality',
  'execution.baseRef',
  'execution.createPullRequest',
  'tasks.id',
  'tasks.title',
  'tasks.priority',
  'tasks.status',
  'tasks.tags',
  'dispatchId',
  'dataClassification',
  'allowedActions',
] as const;

export const EXTERNAL_AGENT_FIELDS = [
  ...DEFAULT_EXTERNAL_AGENT_FIELDS,
  'project.description',
  'tasks.description',
  'phases.name',
  'phases.description',
  'phases.taskIds',
  'phases.sortOrder',
  'callbackUrl',
] as const;

const FIELD_SET = new Set<string>(EXTERNAL_AGENT_FIELDS);
const REQUIRED_CONTROL_FIELDS = [
  'instruction',
  'execution.locality',
  'dispatchId',
  'dataClassification',
  'allowedActions',
] as const;
const CLASSIFICATION_RANK: Record<AgentDataClassification, number> = {
  standard: 0,
  restricted: 1,
  'local-only': 2,
};
const SECRET_KEY = /(authorization|credential|password|private.?key|secret|token|api.?key)/i;

export const DEFAULT_EXTERNAL_AGENT_DATA_POLICY: ExternalAgentDataPolicy = {
  allowedClassifications: ['standard'],
  fieldAllowlist: [...DEFAULT_EXTERNAL_AGENT_FIELDS],
  retentionDays: 30,
  maxRequestsPerMinute: 30,
};

export function validateDataPolicy(value: unknown): ExternalAgentDataPolicy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ExternalAgentError('dataPolicy must be an object', 'VALIDATION_ERROR', 422);
  }
  const policy = value as Partial<ExternalAgentDataPolicy>;
  const classifications = policy.allowedClassifications;
  if (
    !Array.isArray(classifications)
    || classifications.length === 0
    || classifications.some((value) =>
      value !== 'standard' && value !== 'restricted' && value !== 'local-only')
  ) {
    throw new ExternalAgentError(
      'dataPolicy.allowedClassifications must contain valid classifications',
      'VALIDATION_ERROR',
      422,
    );
  }
  const fieldAllowlist = policy.fieldAllowlist;
  if (
    !Array.isArray(fieldAllowlist)
    || fieldAllowlist.length === 0
    || fieldAllowlist.some((field) => typeof field !== 'string' || !FIELD_SET.has(field))
  ) {
    throw new ExternalAgentError(
      'dataPolicy.fieldAllowlist contains an unsupported field',
      'VALIDATION_ERROR',
      422,
    );
  }
  const missingControlField = REQUIRED_CONTROL_FIELDS.find((field) =>
    !fieldAllowlist.includes(field));
  if (missingControlField) {
    throw new ExternalAgentError(
      `dataPolicy.fieldAllowlist must include ${missingControlField}`,
      'VALIDATION_ERROR',
      422,
    );
  }
  const retentionDays = policy.retentionDays;
  const maxRequestsPerMinute = policy.maxRequestsPerMinute;
  if (!Number.isSafeInteger(retentionDays) || retentionDays! < 1 || retentionDays! > 3650) {
    throw new ExternalAgentError(
      'dataPolicy.retentionDays must be an integer between 1 and 3650',
      'VALIDATION_ERROR',
      422,
    );
  }
  if (
    !Number.isSafeInteger(maxRequestsPerMinute)
    || maxRequestsPerMinute! < 1
    || maxRequestsPerMinute! > 10_000
  ) {
    throw new ExternalAgentError(
      'dataPolicy.maxRequestsPerMinute must be an integer between 1 and 10000',
      'VALIDATION_ERROR',
      422,
    );
  }
  return {
    allowedClassifications: [...new Set(classifications)],
    fieldAllowlist: [...new Set(fieldAllowlist)],
    retentionDays: retentionDays!,
    maxRequestsPerMinute: maxRequestsPerMinute!,
  };
}

export function resolveDispatchClassification(
  connectorTypes: string[],
  requested?: AgentDataClassification,
): AgentDataClassification {
  const detected = connectorTypes.reduce<AgentDataClassification>((current, source) => {
    const candidate = DEFAULT_AI_ROUTING_POLICY.sourceDefaults[source.trim().toLowerCase()]
      ?? 'restricted';
    return CLASSIFICATION_RANK[candidate] > CLASSIFICATION_RANK[current]
      ? candidate
      : current;
  }, 'standard');
  if (!requested) return detected;
  if (CLASSIFICATION_RANK[requested] < CLASSIFICATION_RANK[detected]) {
    throw new ExternalAgentError(
      `Data classification cannot be relaxed from ${detected} to ${requested}`,
      'CLASSIFICATION_DOWNGRADE',
      403,
    );
  }
  return requested;
}

export function assertClassificationAllowed(
  classification: AgentDataClassification,
  policy: ExternalAgentDataPolicy,
  locality: ExternalAgentLocality,
) {
  if (!policy.allowedClassifications.includes(classification)) {
    throw new ExternalAgentError(
      `Agent policy does not allow ${classification} data`,
      'DISCLOSURE_BLOCKED',
      403,
    );
  }
  if (classification === 'local-only' && locality !== 'mission-control-host') {
    throw new ExternalAgentError(
      'Local-only data cannot leave a Mission Control-hosted execution environment',
      'DISCLOSURE_BLOCKED',
      403,
    );
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashCanonical(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function hashSecret(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function redactForPersistence(
  value: unknown,
  limits: { maxText?: number; maxBytes?: number } = {},
): unknown {
  const maxText = limits.maxText ?? 16_384;
  const redact = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redactPushText(entry, maxText);
    if (Array.isArray(entry)) return entry.map(redact);
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([key]) => !SECRET_KEY.test(key))
          .map(([key, nested]) => [key, redact(nested)]),
      );
    }
    return entry;
  };
  const redacted = redact(value);
  const encoded = canonicalJson(redacted);
  if (Buffer.byteLength(encoded, 'utf8') > (limits.maxBytes ?? 512 * 1024)) {
    throw new ExternalAgentError(
      'Payload exceeds the persistence size limit',
      'PAYLOAD_TOO_LARGE',
      413,
    );
  }
  return redacted;
}

export function selectAllowedPayloadFields(
  source: Record<string, unknown>,
  allowlist: string[],
): { payload: Record<string, unknown>; disclosedFields: string[] } {
  const payload: Record<string, unknown> = {};
  const disclosedFields: string[] = [];

  for (const field of allowlist) {
    const [root, leaf] = field.split('.');
    const sourceValue = source[root];
    if (!leaf) {
      if (sourceValue !== undefined) {
        payload[root] = sourceValue;
        disclosedFields.push(field);
      }
      continue;
    }
    if (Array.isArray(sourceValue)) {
      const values = sourceValue.map((item) =>
        item && typeof item === 'object'
          ? (item as Record<string, unknown>)[leaf]
          : undefined);
      if (values.some((value) => value !== undefined)) {
        const existing = Array.isArray(payload[root])
          ? payload[root] as Array<Record<string, unknown>>
          : sourceValue.map((): Record<string, unknown> => ({}));
        values.forEach((value, index) => {
          if (value !== undefined) existing[index][leaf] = value;
        });
        payload[root] = existing;
        disclosedFields.push(field);
      }
      continue;
    }
    if (sourceValue && typeof sourceValue === 'object') {
      const value = (sourceValue as Record<string, unknown>)[leaf];
      if (value !== undefined) {
        const existing = (
          payload[root] && typeof payload[root] === 'object'
            ? payload[root]
            : {}
        ) as Record<string, unknown>;
        existing[leaf] = value;
        payload[root] = existing;
        disclosedFields.push(field);
      }
    }
  }

  return {
    payload: redactForPersistence(payload, { maxBytes: 256 * 1024 }) as Record<string, unknown>,
    disclosedFields,
  };
}
