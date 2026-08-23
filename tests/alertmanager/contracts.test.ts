import { describe, expect, it } from 'vitest';
import {
  ALERTMANAGER_ACCEPTED_ANNOTATION_ALLOWLIST,
  ALERTMANAGER_ACCEPTED_LABEL_ALLOWLIST,
  normalizeAlertmanagerWebhook,
} from '@/lib/alertmanager/contracts';

function payload() {
  return {
    version: '4',
    groupKey: '{}:{alertname="NodeDown"}',
    truncatedAlerts: 0,
    status: 'firing',
    receiver: 'mission-control',
    groupLabels: { alertname: 'NodeDown' },
    commonLabels: { severity: 'critical' },
    commonAnnotations: {},
    externalURL: 'https://alertmanager.example',
    alerts: [{
      status: 'firing',
      labels: {
        alertname: 'NodeDown',
        severity: 'critical',
        notification_type: 'homelab_service_unavailable',
        category: 'infrastructure',
        service: 'node-exporter',
        instance: 'node-1',
        environment: 'production',
        owner: 'platform',
        action_required: 'true',
        arbitrary_routing_label: 'discard me',
      },
      annotations: {
        summary: 'Node exporter is unavailable',
        description: 'Metrics collection has failed.',
        dashboard_url: 'https://grafana.example/d/node',
        logs_url: 'https://grafana.example/explore',
        metric_1_label: 'Unavailable',
        metric_1_value: '5m',
        metric_1_tone: 'danger',
        arbitrary_annotation: 'discard me too',
      },
      startsAt: '2026-08-22T20:00:00.000Z',
      endsAt: '2026-08-22T20:05:00.000Z',
      generatorURL: 'https://prometheus.example/graph',
      fingerprint: 'abcdef0123456789',
    }],
  };
}

describe('Alertmanager webhook contract', () => {
  it('normalizes a standard grouped batch into bounded lifecycle events', () => {
    const [event] = normalizeAlertmanagerWebhook(payload(), 'homelab');

    expect(event).toMatchObject({
      schemaVersion: 1,
      source: 'alertmanager',
      fingerprint: 'abcdef0123456789',
      status: 'firing',
      occurredAt: '2026-08-22T20:00:00.000Z',
      severity: 'critical',
      type: 'homelab_service_unavailable',
      category: 'infrastructure',
      summary: 'Node exporter is unavailable',
      service: 'node-exporter',
      node: 'node-1',
      environment: 'production',
      owner: 'platform',
      actionRequired: true,
      metrics: [{ label: 'Unavailable', value: '5m', tone: 'danger' }],
      links: [
        { kind: 'dashboard', url: 'https://grafana.example/d/node' },
        { kind: 'logs', url: 'https://grafana.example/explore' },
      ],
    });
    expect(JSON.stringify(event)).not.toContain('arbitrary_');
    expect(event.eventId).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects the complete batch when one member is malformed', () => {
    const invalid = payload();
    invalid.alerts.push({
      ...invalid.alerts[0],
      fingerprint: '1234567890abcdef',
      labels: { ...invalid.alerts[0].labels, severity: 'page' },
    });

    expect(() => normalizeAlertmanagerWebhook(invalid, 'homelab'))
      .toThrow(/labels\.severity must be critical, warning, or info/);
  });

  it('rejects unsafe approved links and incomplete metrics', () => {
    const invalid = payload();
    invalid.alerts[0].annotations.dashboard_url = 'https://user:secret@grafana.example/d/1';
    delete (invalid.alerts[0].annotations as Record<string, string>).metric_1_value;

    expect(() => normalizeAlertmanagerWebhook(invalid, 'homelab'))
      .toThrow(/dashboard_url must be an http\(s\) URL without credentials/);
  });

  it('exports the producer-facing persistence allowlists', () => {
    expect(ALERTMANAGER_ACCEPTED_LABEL_ALLOWLIST).toEqual([
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
    ]);
    expect(ALERTMANAGER_ACCEPTED_ANNOTATION_ALLOWLIST).toContain('runbook_url');
    expect(ALERTMANAGER_ACCEPTED_ANNOTATION_ALLOWLIST).toContain('metric_4_tone');
  });
});
