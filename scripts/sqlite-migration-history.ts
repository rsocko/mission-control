import { createHash } from 'node:crypto';
import { PERSISTED_STATE_FIXTURES } from './persisted-state-fixture-manifest';
import { SQLITE_SUPERSEDED_MIGRATION_HASHES } from './sqlite-superseded-migration-hashes';

export function syntheticRetainedMigrationHash(
  fixtureId: string,
  index: number,
): string {
  return createHash('sha256')
    .update(`synthetic-retained-migration:${fixtureId}:${index}`)
    .digest('hex');
}

export function trustedRetainedMigrationHashes(): ReadonlySet<string> {
  const hashes = new Set<string>(SQLITE_SUPERSEDED_MIGRATION_HASHES);
  for (const fixture of PERSISTED_STATE_FIXTURES) {
    const count = fixture.retainedHistoricalMigrationRows ?? 0;
    for (let index = 0; index < count; index += 1) {
      hashes.add(syntheticRetainedMigrationHash(fixture.id, index));
    }
  }
  return hashes;
}
