import type { ExternalIdentityEvidence } from '@/lib/external-identities';

/**
 * GitHub identity is permanently NodeID-first, so sync fixtures must bind every
 * task to an `external_entities.stable_id`. `source_id` stays a mutable locator
 * and is never sufficient on its own.
 */
export function githubIssueEvidence(options: {
  issueStableId: string;
  repositoryStableId: string;
  owner: string;
  repository: string;
  issueNumber: number;
  observedAt?: string;
  hostKey?: string;
}): ExternalIdentityEvidence {
  const observedAt = options.observedAt ?? '2026-08-03T00:00:00.000Z';
  const hostKey = options.hostKey ?? 'github.com';
  return {
    repository: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'repository',
        stableId: options.repositoryStableId,
      },
      locator: { owner: options.owner, repository: options.repository },
      observationSource: 'graphql',
      observedAt,
    },
    entity: {
      identity: {
        provider: 'github',
        hostKey,
        entityType: 'issue',
        stableId: options.issueStableId,
      },
      locator: {
        owner: options.owner,
        repository: options.repository,
        issueNumber: options.issueNumber,
      },
      observationSource: 'graphql',
      observedAt,
    },
  };
}

/**
 * Mirrors the frozen write-lease targets back as a preflight observation. Test
 * connectors have no real remote, so echoing the fence's own frozen NodeIDs is
 * the honest stand-in for an authoritative remote route confirmation.
 */
export function mirrorFenceTargets(
  sqlite: {
    prepare: (sql: string) => {
      all: (...values: Array<string | number | null>) => unknown[];
    };
  },
  leaseId: string,
): Record<string, { repositoryStableId: string; issueStableId?: string }> {
  const rows = sqlite.prepare(`
    SELECT target.role AS role, entity.entity_type AS entityType, entity.stable_id AS stableId,
      repository.stable_id AS repositoryStableId
    FROM task_source_write_lease_targets AS target
    JOIN external_entities AS entity ON entity.id = target.external_entity_id
    LEFT JOIN external_entities AS repository ON repository.id = target.repository_entity_id
    WHERE target.lease_id = ?
  `).all(leaseId) as Array<{
    role: string;
    entityType: 'issue' | 'repository';
    stableId: string;
    repositoryStableId: string | null;
  }>;
  const targets: Record<string, { repositoryStableId: string; issueStableId?: string }> = {};
  for (const row of rows) {
    targets[row.role] = row.entityType === 'issue'
      ? {
          repositoryStableId: row.repositoryStableId ?? row.stableId,
          issueStableId: row.stableId,
        }
      : { repositoryStableId: row.stableId };
  }
  return targets;
}

/**
 * Persists active NodeID bindings for GitHub tasks so the stable-only runtime
 * resolves them. Mirrors what sync-time identity observation would have done.
 */
export function bindGitHubTaskIdentities(
  sqlite: {
    prepare: (sql: string) => {
      run: (...values: Array<string | number | null>) => unknown;
    };
  },
  connectorInstanceId: string,
  tasks: ReadonlyArray<{
    taskId: string;
    owner: string;
    repository: string;
    issueNumber: number;
    issueStableId: string;
    repositoryStableId: string;
  }>,
  now = '2026-08-03T00:00:00.000Z',
): void {
  const entity = sqlite.prepare(`
    INSERT INTO external_entities (
      id, provider, host_key, entity_type, stable_id, identity_version,
      next_locator_revision, first_seen_at, last_seen_at
    ) VALUES (?, 'github', 'github.com', ?, ?, 1, 2, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  const locator = sqlite.prepare(`
    INSERT INTO external_entity_locators (
      id, external_entity_id, repository_entity_id, provider, host_key, owner, repository,
      owner_key, repository_key, issue_number, valid_from, valid_to, last_seen_at,
      observation_source, locator_revision
    ) VALUES (?, ?, ?, 'github', 'github.com', ?, ?, ?, ?, ?, ?, NULL, ?, 'graphql', 1)
    ON CONFLICT DO NOTHING
  `);
  const binding = sqlite.prepare(`
    INSERT INTO external_entity_bindings (
      id, external_entity_id, connector_instance_id, binding_type, local_id, state,
      verified_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT DO NOTHING
  `);
  for (const task of tasks) {
    const repositoryEntityId = `entity-${task.repositoryStableId}`;
    const issueEntityId = `entity-${task.issueStableId}`;
    entity.run(repositoryEntityId, 'repository', task.repositoryStableId, now, now);
    entity.run(issueEntityId, 'issue', task.issueStableId, now, now);
    locator.run(
      `locator-${task.repositoryStableId}`,
      repositoryEntityId,
      null,
      task.owner,
      task.repository,
      task.owner.toLowerCase(),
      task.repository.toLowerCase(),
      null,
      now,
      now,
    );
    locator.run(
      `locator-${task.issueStableId}`,
      issueEntityId,
      repositoryEntityId,
      task.owner,
      task.repository,
      task.owner.toLowerCase(),
      task.repository.toLowerCase(),
      task.issueNumber,
      now,
      now,
    );
    binding.run(
      `binding-${task.issueStableId}`,
      issueEntityId,
      connectorInstanceId,
      'task',
      task.taskId,
      now,
      now,
      now,
    );
    // Write-fence route verification re-reads a binding for every frozen target,
    // including the repository, so bind it as the source list too.
    binding.run(
      `binding-${task.repositoryStableId}`,
      repositoryEntityId,
      connectorInstanceId,
      'source_list',
      `${task.owner}/${task.repository}`,
      now,
      now,
      now,
    );
  }
}
