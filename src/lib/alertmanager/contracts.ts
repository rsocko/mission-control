import { createHash } from 'crypto';
import { z } from 'zod';
import { normalizeNotificationUrl } from '@/lib/notifications/providers';

export const MAX_ALERTMANAGER_BATCH_ALERTS = 100;
export const MAX_ALERTMANAGER_LABELS = 32;
export const MAX_ALERTMANAGER_ANNOTATIONS = 24;

const notificationTypes = [
  'homelab_service_unavailable',
  'homelab_site_outage',
  'homelab_backup_failed',
  'homelab_backup_missed',
  'homelab_storage_critical',
  'homelab_filesystem_read_only',
  'homelab_automation_failed',
  'homelab_security_incident',
  'homelab_capacity_sustained',
  'homelab_device_intervention',
  'homelab_maintenance_digest',
] as const;

const linkKinds = ['dashboard', 'logs', 'uptime', 'runbook'] as const;
const metricTones = ['neutral', 'info', 'warning', 'danger', 'success'] as const;

const boundedLabelsSchema = z.record(
  z.string().min(1).max(64),
  z.string().max(256),
).superRefine((labels, context) => {
  if (Object.keys(labels).length > MAX_ALERTMANAGER_LABELS) {
    context.addIssue({
      code: 'custom',
      message: `Labels must contain at most ${MAX_ALERTMANAGER_LABELS} entries`,
    });
  }
});

const boundedAnnotationsSchema = z.record(
  z.string().min(1).max(64),
  z.string().max(2048),
).superRefine((annotations, context) => {
  if (Object.keys(annotations).length > MAX_ALERTMANAGER_ANNOTATIONS) {
    context.addIssue({
      code: 'custom',
      message: `Annotations must contain at most ${MAX_ALERTMANAGER_ANNOTATIONS} entries`,
    });
  }
});

const alertmanagerAlertSchema = z.object({
  status: z.enum(['firing', 'resolved']),
  labels: boundedLabelsSchema,
  annotations: boundedAnnotationsSchema,
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  generatorURL: z.string().max(2048),
  fingerprint: z.string().min(1).max(128).regex(/^[a-f0-9]+$/i),
}).strict().superRefine((alert, context) => {
  if (!['critical', 'warning', 'info'].includes(alert.labels.severity)) {
    context.addIssue({
      code: 'custom',
      path: ['labels', 'severity'],
      message: 'labels.severity must be critical, warning, or info',
    });
  }
  if (!notificationTypes.includes(
    alert.labels.notification_type as (typeof notificationTypes)[number],
  )) {
    context.addIssue({
      code: 'custom',
      path: ['labels', 'notification_type'],
      message: 'labels.notification_type must be a supported homelab notification type',
    });
  }
  if (
    alert.labels.action_required !== undefined
    && !['true', 'false'].includes(alert.labels.action_required.toLowerCase())
  ) {
    context.addIssue({
      code: 'custom',
      path: ['labels', 'action_required'],
      message: 'labels.action_required must be true or false',
    });
  }
  for (const name of ['dashboard_url', 'logs_url', 'uptime_url', 'runbook_url'] as const) {
    const rawUrl = alert.annotations[name];
    if (rawUrl && !approvedUrl(rawUrl)) {
      context.addIssue({
        code: 'custom',
        path: ['annotations', name],
        message: `${name} must be an http(s) URL without credentials or a fragment`,
      });
    }
  }
  for (let index = 1; index <= 4; index++) {
    const label = alert.annotations[`metric_${index}_label`];
    const value = alert.annotations[`metric_${index}_value`];
    if (Boolean(label) !== Boolean(value)) {
      context.addIssue({
        code: 'custom',
        path: ['annotations', `metric_${index}`],
        message: `metric_${index}_label and metric_${index}_value must be supplied together`,
      });
    }
    const tone = alert.annotations[`metric_${index}_tone`];
    if (tone && !metricTones.includes(tone as (typeof metricTones)[number])) {
      context.addIssue({
        code: 'custom',
        path: ['annotations', `metric_${index}_tone`],
        message: `metric_${index}_tone is not supported`,
      });
    }
  }
});

export const alertmanagerWebhookSchema = z.object({
  version: z.literal('4'),
  groupKey: z.string().max(1024),
  truncatedAlerts: z.number().int().nonnegative().optional(),
  status: z.enum(['firing', 'resolved']),
  receiver: z.string().min(1).max(256),
  groupLabels: boundedLabelsSchema,
  commonLabels: boundedLabelsSchema,
  commonAnnotations: boundedAnnotationsSchema,
  externalURL: z.string().max(2048),
  alerts: z.array(alertmanagerAlertSchema).min(1).max(MAX_ALERTMANAGER_BATCH_ALERTS),
}).strict();

export const homelabAlertLifecycleEventV1Schema = z.object({
  schemaVersion: z.literal(1),
  eventId: z.string().min(1).max(256),
  occurredAt: z.iso.datetime({ offset: true }),
  source: z.enum(['alertmanager', 'grafana']),
  fingerprint: z.string().min(1).max(128),
  status: z.enum(['firing', 'resolved']),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }).optional(),
  severity: z.enum(['critical', 'warning', 'info']),
  type: z.enum(notificationTypes),
  category: z.enum([
    'infrastructure',
    'backup',
    'automation',
    'security',
    'home',
    'system',
  ]).optional(),
  summary: z.string().min(1).max(512),
  description: z.string().max(2048).optional(),
  service: z.string().max(128).optional(),
  node: z.string().max(128).optional(),
  site: z.string().max(128).optional(),
  environment: z.string().max(128).optional(),
  owner: z.string().max(128).optional(),
  actionRequired: z.boolean().optional(),
  metrics: z.array(z.object({
    label: z.string().min(1).max(64),
    value: z.string().min(1).max(128),
    tone: z.enum(metricTones).optional(),
  }).strict()).max(4).optional(),
  links: z.array(z.object({
    kind: z.enum(linkKinds),
    url: z.string().url().max(2048),
  }).strict()).max(4).optional(),
  runbookKey: z.string().min(1).max(128).optional(),
}).strict().superRefine((event, context) => {
  if (event.status === 'resolved' && !event.endsAt) {
    context.addIssue({
      code: 'custom',
      path: ['endsAt'],
      message: 'Resolved events require endsAt',
    });
  }
});

export type HomelabAlertLifecycleEventV1 = z.infer<
  typeof homelabAlertLifecycleEventV1Schema
>;

export type AlertmanagerWebhook = z.infer<typeof alertmanagerWebhookSchema>;

const labelAllowlist = [
  'alertname',
  'severity',
  'notification_type',
  'category',
  'service',
  'job',
  'instance',
  'node',
  'site',
  'environment',
  'owner',
  'action_required',
  'runbook_key',
] as const;

const annotationAllowlist = [
  'summary',
  'description',
  'dashboard_url',
  'logs_url',
  'uptime_url',
  'runbook_url',
  'metric_1_label',
  'metric_1_value',
  'metric_1_tone',
  'metric_2_label',
  'metric_2_value',
  'metric_2_tone',
  'metric_3_label',
  'metric_3_value',
  'metric_3_tone',
  'metric_4_label',
  'metric_4_value',
  'metric_4_tone',
] as const;

export const ALERTMANAGER_ACCEPTED_LABEL_ALLOWLIST = Object.freeze(labelAllowlist);
export const ALERTMANAGER_ACCEPTED_ANNOTATION_ALLOWLIST = Object.freeze(annotationAllowlist);

function approvedUrl(value: string | undefined): string | null {
  const normalized = normalizeNotificationUrl(value);
  if (!normalized) return null;
  const url = new URL(normalized);
  if (url.username || url.password || url.hash) return null;
  return normalized;
}

function normalizeSeverity(value: string | undefined): 'critical' | 'warning' | 'info' {
  if (value === 'critical' || value === 'warning') return value;
  return 'info';
}

function normalizeType(value: string | undefined): (typeof notificationTypes)[number] {
  return notificationTypes.includes(value as (typeof notificationTypes)[number])
    ? value as (typeof notificationTypes)[number]
    : 'homelab_service_unavailable';
}

function normalizeActionRequired(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  return value.toLowerCase() === 'true';
}

function normalizeCategory(value: string | undefined) {
  const categories = [
    'infrastructure',
    'backup',
    'automation',
    'security',
    'home',
    'system',
  ] as const;
  return categories.includes(value as (typeof categories)[number])
    ? value as (typeof categories)[number]
    : undefined;
}

function eventId(
  integration: string,
  fingerprint: string,
  status: 'firing' | 'resolved',
  occurredAt: string,
): string {
  return createHash('sha256')
    .update(`${integration}\0alertmanager\0${fingerprint}\0${status}\0${occurredAt}`)
    .digest('hex');
}

function normalizeLinks(
  annotations: Record<string, string>,
): NonNullable<HomelabAlertLifecycleEventV1['links']> {
  const candidates = [
    ['dashboard', annotations.dashboard_url],
    ['logs', annotations.logs_url],
    ['uptime', annotations.uptime_url],
    ['runbook', annotations.runbook_url],
  ] as const;
  return candidates.flatMap(([kind, rawUrl]) => {
    const url = approvedUrl(rawUrl);
    return url ? [{ kind, url }] : [];
  });
}

function normalizeMetrics(
  annotations: Record<string, string>,
): NonNullable<HomelabAlertLifecycleEventV1['metrics']> {
  const metrics: NonNullable<HomelabAlertLifecycleEventV1['metrics']> = [];
  for (let index = 1; index <= 4; index++) {
    const label = annotations[`metric_${index}_label`];
    const value = annotations[`metric_${index}_value`];
    if (!label || !value) continue;
    const rawTone = annotations[`metric_${index}_tone`];
    const tone = metricTones.includes(rawTone as (typeof metricTones)[number])
      ? rawTone as (typeof metricTones)[number]
      : undefined;
    metrics.push({ label, value, ...(tone ? { tone } : {}) });
  }
  return metrics;
}

export function normalizeAlertmanagerWebhook(
  input: unknown,
  integration: string,
): HomelabAlertLifecycleEventV1[] {
  const payload = alertmanagerWebhookSchema.parse(input);
  return payload.alerts.map((alert) => {
    const occurredAt = alert.status === 'resolved' ? alert.endsAt : alert.startsAt;
    const summary = alert.annotations.summary?.trim() || alert.labels.alertname?.trim();
    if (!summary) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['alerts', payload.alerts.indexOf(alert), 'annotations', 'summary'],
        message: 'Each alert requires annotations.summary or labels.alertname',
      }]);
    }
    if (
      alert.status === 'resolved'
      && Date.parse(alert.endsAt) < Date.parse(alert.startsAt)
    ) {
      throw new z.ZodError([{
        code: 'custom',
        path: ['alerts', payload.alerts.indexOf(alert), 'endsAt'],
        message: 'Resolved alert endsAt cannot precede startsAt',
      }]);
    }
    const links = normalizeLinks(alert.annotations);
    const metrics = normalizeMetrics(alert.annotations);
    const event = {
      schemaVersion: 1 as const,
      eventId: eventId(integration, alert.fingerprint, alert.status, occurredAt),
      occurredAt,
      source: 'alertmanager' as const,
      fingerprint: alert.fingerprint,
      status: alert.status,
      startsAt: alert.startsAt,
      ...(alert.status === 'resolved' ? { endsAt: alert.endsAt } : {}),
      severity: normalizeSeverity(alert.labels.severity),
      type: normalizeType(alert.labels.notification_type),
      ...(normalizeCategory(alert.labels.category)
        ? { category: normalizeCategory(alert.labels.category) }
        : {}),
      summary,
      ...(alert.annotations.description?.trim()
        ? { description: alert.annotations.description.trim() }
        : {}),
      ...(alert.labels.service?.trim() || alert.labels.job?.trim()
        ? { service: (alert.labels.service || alert.labels.job).trim() }
        : {}),
      ...(alert.labels.node?.trim() || alert.labels.instance?.trim()
        ? { node: (alert.labels.node || alert.labels.instance).trim() }
        : {}),
      ...(alert.labels.site?.trim() ? { site: alert.labels.site.trim() } : {}),
      ...(alert.labels.environment?.trim()
        ? { environment: alert.labels.environment.trim() }
        : {}),
      ...(alert.labels.owner?.trim() ? { owner: alert.labels.owner.trim() } : {}),
      ...(normalizeActionRequired(alert.labels.action_required) === undefined
        ? {}
        : { actionRequired: normalizeActionRequired(alert.labels.action_required) }),
      ...(metrics.length > 0 ? { metrics } : {}),
      ...(links.length > 0 ? { links } : {}),
      ...(alert.labels.runbook_key?.trim()
        ? { runbookKey: alert.labels.runbook_key.trim() }
        : {}),
    };
    return homelabAlertLifecycleEventV1Schema.parse(event);
  });
}
