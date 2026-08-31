import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresConnectorExecutionRepositories } from '@/db/postgres/repositories';
import type { ConnectorConfig } from '@/types';

function config(overrides: Partial<ConnectorConfig> = {}): ConnectorConfig {
  return {
    id: 'connector-1',
    type: 'custom-rest',
    name: 'Generic',
    enabled: true,
    syncMode: 'poll',
    capabilities: {
      read: true,
      write: true,
      delete: true,
      sync: true,
      subtasks: false,
      lists: true,
      tags: true,
      tagWriteBack: false,
    },
    credentials: {},
    settings: {},
    syncedLists: [],
    ...overrides,
  };
}

describe('PostgreSQL generic connector execution support', () => {
  const support = createPostgresConnectorExecutionRepositories({} as Pool).support;

  it('accepts a generic connector composition', () => {
    expect(() => support.assertConfigSupported(config())).not.toThrow();
    expect(() => support.assertConnectorSupported({ type: 'custom-rest' })).not.toThrow();
  });

  it('accepts GitHub normal queue execution once Layer 3A is composed', () => {
    expect(() => support.assertConfigSupported(config({
      type: 'github-issues',
      capabilities: { ...config().capabilities, dependencyRead: true, dependencyWrite: true },
    }))).not.toThrow();
    expect(() => support.assertConnectorSupported({
      type: 'github-issues',
      dependencySnapshotStrategy: 'task-stream',
      fetchProjectAssociations: () => undefined,
    })).not.toThrow();
  });

  it('enables only the portable dependency and notification workflows', () => {
    expect(support.allowsLegacyWorkflow('dependency-reconciliation')).toBe(true);
    expect(support.allowsLegacyWorkflow('notification-dispatcher')).toBe(true);
    for (const workflow of [
      'event-outbox',
      'notification-enrichment',
      'planning-signals',
      'project-automation',
      'semantic-search',
    ] as const) {
      expect(support.allowsLegacyWorkflow(workflow)).toBe(false);
    }
  });

  it('accepts the Layer 4 non-finance connectors once their state is composed', () => {
    for (const type of [
      'microsoft-todo',
      'microsoft-todo-work',
      'rymessage',
      'document-intelligence',
    ]) {
      expect(() => support.assertConfigSupported(config({ type }))).not.toThrow();
      expect(() => support.assertConnectorSupported({ type })).not.toThrow();
    }
  });

  it.each(['finance', 'finance-manager', 'monarch-money'])(
    'accepts Layer 5C finance domain execution for %s',
    (type) => {
      expect(() => support.assertConfigSupported(config({ type }))).not.toThrow();
      expect(() => support.assertConnectorSupported({
        type,
        syncDomainData: () => undefined,
      })).not.toThrow();
    },
  );

  it.each([
    ['dependency relationships', config({
      capabilities: {
        ...config().capabilities,
        dependencyRead: true,
      },
    })],
  ])('rejects %s before connector execution', (_label, unsupported) => {
    expect(() => support.assertConfigSupported(unsupported))
      .toThrow(/does not support/);
  });

  it.each([
    ['domain state', { type: 'custom-rest', syncDomainData: () => undefined }],
    ['dependency state', { type: 'custom-rest', dependencySnapshotStrategy: 'task-stream' }],
    ['project state', { type: 'custom-rest', fetchProjectAssociations: () => undefined }],
  ])('rejects connector-owned %s before remote dispatch', (_label, connector) => {
    expect(() => support.assertConnectorSupported(connector)).toThrow(/does not support/);
  });
});
