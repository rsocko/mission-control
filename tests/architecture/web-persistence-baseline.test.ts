import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { computeWebPersistenceGraph } from './web-persistence-graph';

/**
 * Machine-derived recomputation ratchet for the web/API PostgreSQL
 * application-parity migration (see plan.md at planning session-state
 * 430296c8-f794-4625-b32f-abb04894e6d4, and
 * tests/architecture/web-persistence-baseline.json for the full committed
 * baseline plus the archived-generator reconciliation notes).
 *
 * This is deliberately a *separate* file from persistence-boundaries.test.ts:
 * that ratchet detects raw SQLite handle/driver imports at the file level
 * (a narrower, adapter-boundary check carried over from prior worker/workflow
 * layers). This ratchet instead pins the full backward static-import taint
 * census across every web/API route, so later layers can only shrink the
 * SQLite-taint footprint, never grow it. Neither file duplicates the other's
 * allowlists, and this ratchet does not grandfather any
 * LEGACY_RAW_SQLITE_IMPORTS entry as "clean" -- if a legacy raw-import module
 * is reachable from a route, it correctly shows up as Tier A/B taint here.
 */

const baseline = JSON.parse(
  readFileSync(join(process.cwd(), 'tests/architecture/web-persistence-baseline.json'), 'utf8'),
) as {
  counts: Record<string, number>;
  staticSources: string[];
  dynamicSources: string[];
  apiRoutes: string[];
  tierARoutes: string[];
  tierBRoutes: string[];
  cleanRoutes: string[];
  directTaintSourceRoutes: string[];
  transitiveOnlyTaintSourceRoutes: string[];
  directDbNamespaceRoutes: string[];
  taintedLibA: string[];
  taintedApiHelpers: string[];
};

const current = computeWebPersistenceGraph(process.cwd());

/**
 * Pure diff for a taint-side set (`tierARoutes`, `tierBRoutes`, `taintedLibA`,
 * etc.), where the baseline is a ceiling: a later layer may only remove
 * entries, never add one that was not already present.
 *
 * This is deliberately entry-set based, not just a count comparison. A
 * decrement-budget mechanism that checked only `current.length <=
 * baseline.length` could be gamed two ways: (a) swap - remove one baseline
 * entry while introducing a different, unlisted one, netting an unchanged or
 * smaller count with zero real remediation; or (b) reclassify - move a route
 * out of Tier A by turning its static import into a dynamic one, so it
 * reappears in Tier B instead of disappearing. `additions` catches (a)
 * directly (the new entry is not in the baseline set, regardless of what was
 * removed). (b) is caught because Tier A and Tier B are each pinned by their
 * *own* independent call to this function: a route that newly appears in
 * `tierBRoutes` and was not already there is an "addition" to `tierBRoutes`
 * and fails that ceiling, even though it simultaneously shrinks `tierARoutes`.
 */
function ceilingViolations(currentSet: string[], baselineSet: string[]) {
  const additions = currentSet.filter((entry) => !baselineSet.includes(entry));
  return { additions, exceedsCount: currentSet.length > baselineSet.length };
}

function assertCeiling(label: string, currentSet: string[], baselineSet: string[]) {
  const { additions, exceedsCount } = ceilingViolations(currentSet, baselineSet);
  expect(additions, `${label}: new taint not present in the committed baseline`).toEqual([]);
  expect(exceedsCount, `${label}: count must not exceed the committed baseline ceiling`).toBe(false);
}

/** Pure diff for a clean-side set (`cleanRoutes`), where the baseline is a floor. */
function floorViolations(currentSet: string[], baselineSet: string[]) {
  const regressions = baselineSet.filter((entry) => !currentSet.includes(entry));
  return { regressions, fallsBelowCount: currentSet.length < baselineSet.length };
}

function assertFloor(label: string, currentSet: string[], baselineSet: string[]) {
  const { regressions, fallsBelowCount } = floorViolations(currentSet, baselineSet);
  expect(regressions, `${label}: previously-clean route became tainted`).toEqual([]);
  expect(fallsBelowCount, `${label}: clean-route count must not fall below the committed baseline floor`).toBe(
    false,
  );
}

describe('web persistence baseline ratchet', () => {
  it('pins the exact static import-graph structure (sources)', () => {
    assertCeiling('staticSources', current.staticSources, baseline.staticSources);
    assertCeiling('dynamicSources', current.dynamicSources, baseline.dynamicSources);
  });

  it('agrees with the committed baseline on the full API route inventory', () => {
    // apiRoutes is neither a pure ceiling nor a pure floor - it is the
    // denominator every other set is measured against, so it is pinned
    // exactly. Adding or removing a route file is a real, visible repo
    // change and should update the baseline deliberately (regenerate via
    // computeWebPersistenceGraph), not silently drift.
    expect(current.apiRoutes).toEqual(baseline.apiRoutes);
  });

  it('never grows Tier A (import-time taint)', () => {
    assertCeiling('tierARoutes', current.tierARoutes, baseline.tierARoutes);
  });

  it('never grows Tier B (deferred/dynamic-only taint)', () => {
    assertCeiling('tierBRoutes', current.tierBRoutes, baseline.tierBRoutes);
  });

  it('never shrinks the clean route floor', () => {
    assertFloor('cleanRoutes', current.cleanRoutes, baseline.cleanRoutes);
  });

  it('never grows tainted src/lib modules (Tier A)', () => {
    assertCeiling('taintedLibA', current.taintedLibA, baseline.taintedLibA);
  });

  it('never grows tainted shared API helpers (Tier A)', () => {
    assertCeiling('taintedApiHelpers', current.taintedApiHelpers, baseline.taintedApiHelpers);
  });

  it('never grows the direct-taint-source / transitive-only Tier A partition', () => {
    assertCeiling('directTaintSourceRoutes', current.directTaintSourceRoutes, baseline.directTaintSourceRoutes);
    assertCeiling(
      'transitiveOnlyTaintSourceRoutes',
      current.transitiveOnlyTaintSourceRoutes,
      baseline.transitiveOnlyTaintSourceRoutes,
    );
  });

  it('never grows the @/db namespace direct-import route count', () => {
    assertCeiling('directDbNamespaceRoutes', current.directDbNamespaceRoutes, baseline.directDbNamespaceRoutes);
  });

  it('holds the declared decrement-budget invariants exactly', () => {
    expect(current.directTaintSourceRoutes.length + current.transitiveOnlyTaintSourceRoutes.length).toBe(
      current.tierARoutes.length,
    );
    expect(current.tierARoutes.length + current.taintedLibA.length + current.taintedApiHelpers.length).toBe(
      current.totalMigrationUnits,
    );
    expect(current.totalMigrationUnits).toBeLessThanOrEqual(baseline.counts.totalMigrationUnits);
  });

  it('recomputes every committed count deterministically from source', () => {
    expect({
      apiRoutes: current.apiRoutes.length,
      tierARoutes: current.tierARoutes.length,
      tierBRoutes: current.tierBRoutes.length,
      cleanRoutes: current.cleanRoutes.length,
      directTaintSourceRoutes: current.directTaintSourceRoutes.length,
      transitiveOnlyTaintSourceRoutes: current.transitiveOnlyTaintSourceRoutes.length,
      directDbNamespaceRoutes: current.directDbNamespaceRoutes.length,
      taintedLibA: current.taintedLibA.length,
      taintedApiHelpers: current.taintedApiHelpers.length,
      totalMigrationUnits: current.totalMigrationUnits,
    }).toEqual(baseline.counts);
  });
});

/**
 * Proves the decrement-budget mechanism's own diff logic (not the real repo
 * data) actually rejects the two gaming strategies the ratchet must resist:
 * swapping an allowed file for an unlisted one at an unchanged/smaller
 * count, and reclassifying a Tier A route as Tier B to shrink Tier A while
 * growing Tier B. Uses synthetic sets so this holds regardless of what the
 * real repository's current taint footprint happens to be.
 */
describe('web persistence baseline ratchet mechanism (synthetic)', () => {
  it('flags a same-or-smaller-count swap (remove one allowed entry, add one unlisted entry)', () => {
    const baselineSet = ['src/app/api/a/route.ts', 'src/app/api/b/route.ts', 'src/app/api/c/route.ts'];
    // Same length as baseline: 'a' removed, an unlisted 'd' introduced.
    const swapped = ['src/app/api/b/route.ts', 'src/app/api/c/route.ts', 'src/app/api/d/route.ts'];

    const { additions, exceedsCount } = ceilingViolations(swapped, baselineSet);
    expect(additions).toEqual(['src/app/api/d/route.ts']);
    expect(exceedsCount).toBe(false); // count alone would wrongly look fine
  });

  it('flags Tier A shrinking by reclassifying a route into Tier B (count-only would look like progress)', () => {
    const baselineTierA = ['src/app/api/a/route.ts', 'src/app/api/b/route.ts'];
    const baselineTierB = ['src/app/api/z/route.ts'];
    // 'a' moved from static to dynamic import: Tier A shrinks (looks good),
    // but it now newly appears in Tier B.
    const shrunkTierA = ['src/app/api/b/route.ts'];
    const grownTierB = ['src/app/api/z/route.ts', 'src/app/api/a/route.ts'];

    const tierAResult = ceilingViolations(shrunkTierA, baselineTierA);
    expect(tierAResult.additions).toEqual([]);
    expect(tierAResult.exceedsCount).toBe(false);

    const tierBResult = ceilingViolations(grownTierB, baselineTierB);
    expect(tierBResult.additions, 'reclassified route must be caught by the Tier B ceiling').toEqual([
      'src/app/api/a/route.ts',
    ]);
    expect(tierBResult.exceedsCount).toBe(true);
  });

  it('flags a clean-route regression even when the floor count is coincidentally satisfied', () => {
    const baselineClean = ['src/app/api/a/route.ts', 'src/app/api/b/route.ts'];
    // 'a' became tainted, but an unrelated 'c' became newly clean, so the
    // count alone is unchanged.
    const currentClean = ['src/app/api/b/route.ts', 'src/app/api/c/route.ts'];

    const { regressions, fallsBelowCount } = floorViolations(currentClean, baselineClean);
    expect(regressions).toEqual(['src/app/api/a/route.ts']);
    expect(fallsBelowCount).toBe(false); // count alone would wrongly look fine
  });
});
