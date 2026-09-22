import { describe, expect, it } from 'vitest';
import {
  buildTaskFilterSpec,
  filterQueryPinsDisposition,
} from '@/lib/tasks/core/filter-spec';

/**
 * Pure parsing proof for the backend-neutral canonical filter spec.
 *
 * These assertions pin exactly the behaviours the SQLite route helpers used to
 * encode inline, including the quirky ones the migration must preserve rather
 * than "fix": an invalid `status` value still suppresses the implicit open-only
 * exclusion, `localDisposition=all` disables the implicit `active` default, and
 * an unknown quick filter is simply dropped.
 */

const CLOCK = {
  today: '2026-08-10',
  weekFromNow: '2026-08-17',
  recentCutoff: '2026-08-03',
};

const NOW = new Date('2026-08-10T12:00:00.000Z');

function spec(query: string) {
  return buildTaskFilterSpec(new URLSearchParams(query), { clock: CLOCK, now: NOW });
}

describe('buildTaskFilterSpec', () => {
  it('produces a fully empty spec for empty request input', () => {
    expect(spec('')).toEqual({
      connectorTypes: [],
      statuses: [],
      priorities: [],
      planningHorizons: [],
      planningHorizonIsNull: false,
      localDispositions: ['active'],
      excludeClosedStatuses: false,
      openOnly: false,
      parentOnly: false,
      sourceListIds: [],
      sourceListGroupId: null,
      createdAtMax: null,
      createdAtMin: null,
      filterQuery: null,
      tagSlug: null,
      tagSlugs: [],
      projectId: null,
      quickFilter: null,
      myDayDate: CLOCK.today,
      today: CLOCK.today,
      weekFromNow: CLOCK.weekFromNow,
      recentCutoff: CLOCK.recentCutoff,
    });
  });

  it('drops unknown enum values and keeps valid ones', () => {
    const parsed = spec('statuses=todo,bogus,done&priorities=nope&sources=a,b,a');
    expect(parsed.statuses).toEqual(['todo', 'done']);
    expect(parsed.priorities).toEqual([]);
    expect(parsed.connectorTypes).toEqual(['a', 'b']);
  });

  it('falls back to the singular parameter only when the plural is empty', () => {
    expect(spec('status=done').statuses).toEqual(['done']);
    expect(spec('statuses=todo&status=done').statuses).toEqual(['todo']);
    expect(spec('status=bogus').statuses).toEqual([]);
  });

  it('suppresses the implicit open-only exclusion when any status parameter is present', () => {
    expect(spec('openOnly=true').excludeClosedStatuses).toBe(true);
    expect(spec('openOnly=true&status=todo').excludeClosedStatuses).toBe(false);
    // Deliberately preserved quirk: an *invalid* status still suppresses it.
    expect(spec('openOnly=true&status=bogus').excludeClosedStatuses).toBe(false);
    expect(spec('openOnly=true&statuses=todo').excludeClosedStatuses).toBe(false);
  });

  it('never treats the recentlyClosed quick filter as open-only', () => {
    const parsed = spec('openOnly=true&quickFilter=recentlyClosed');
    expect(parsed.openOnly).toBe(false);
    expect(parsed.excludeClosedStatuses).toBe(false);
    expect(parsed.quickFilter).toBe('recentlyClosed');
  });

  it('distinguishes planningHorizon=none from a real horizon', () => {
    expect(spec('planningHorizon=none')).toMatchObject({
      planningHorizons: [],
      planningHorizonIsNull: true,
    });
    expect(spec('planningHorizon=next')).toMatchObject({
      planningHorizons: ['next'],
      planningHorizonIsNull: false,
    });
    expect(spec('planningHorizon=bogus')).toMatchObject({
      planningHorizons: [],
      planningHorizonIsNull: false,
    });
    expect(spec('planningHorizons=next,none')).toMatchObject({
      planningHorizons: ['next'],
      planningHorizonIsNull: false,
    });
  });

  it('applies the implicit active disposition unless explicitly overridden', () => {
    expect(spec('').localDispositions).toEqual(['active']);
    expect(spec('localDisposition=all').localDispositions).toEqual([]);
    expect(spec('localDisposition=handled').localDispositions).toEqual(['handled']);
    expect(spec('localDispositions=handled,dismissed').localDispositions)
      .toEqual(['handled', 'dismissed']);
  });

  it('lets a disposition token in the filter query disable the implicit default', () => {
    expect(spec('filterQuery=disposition%3Ahandled').localDispositions).toEqual([]);
    expect(spec('filterQuery=disposition%3Abogus').localDispositions).toEqual(['active']);
  });

  it('validates the My Day date and falls back to today', () => {
    expect(spec('myDayDate=2026-01-02').myDayDate).toBe('2026-01-02');
    expect(spec('myDayDate=not-a-date').myDayDate).toBe(CLOCK.today);
    expect(spec('myDayDate=').myDayDate).toBe(CLOCK.today);
  });

  it('converts the age window to inclusive created-at bounds', () => {
    const parsed = spec('ageMin=7&ageMax=30');
    expect(parsed.createdAtMax).toBe('2026-08-03T12:00:00.000Z');
    expect(parsed.createdAtMin).toBe('2026-07-11T12:00:00.000Z');
  });

  it('treats zero as a real age bound and rejects negative or fractional values', () => {
    expect(spec('ageMin=0').createdAtMax).toBe('2026-08-10T12:00:00.000Z');
    expect(spec('ageMin=-1').createdAtMax).toBeNull();
    expect(spec('ageMin=1.5').createdAtMax).toBeNull();
    expect(spec('ageMin=').createdAtMax).toBeNull();
    expect(spec('ageMin=abc').createdAtMax).toBeNull();
  });

  it('normalizes blank single-value parameters to null', () => {
    const parsed = spec('tag=&projectId=&listGroupId=&filterQuery=%20%20');
    expect(parsed.tagSlug).toBeNull();
    expect(parsed.projectId).toBeNull();
    expect(parsed.sourceListGroupId).toBeNull();
    expect(parsed.filterQuery).toBeNull();
  });

  it('drops an unknown quick filter instead of passing it through', () => {
    expect(spec('quickFilter=nonsense').quickFilter).toBeNull();
    expect(spec('quickFilter=myDay').quickFilter).toBe('myDay');
  });

  it('collapses listIds/listId into one ordered, de-duplicated list', () => {
    expect(spec('listIds=a,b,a').sourceListIds).toEqual(['a', 'b']);
    expect(spec('listId=solo').sourceListIds).toEqual(['solo']);
    expect(spec('listIds=a&listId=solo').sourceListIds).toEqual(['a']);
  });

  it('honours an injected CSV reader so request limits stay enforced', () => {
    expect(() => buildTaskFilterSpec(new URLSearchParams('statuses=todo'), {
      clock: CLOCK,
      now: NOW,
      readCsv: () => {
        throw new Error('limit exceeded');
      },
    })).toThrow('limit exceeded');
  });
});

describe('filterQueryPinsDisposition', () => {
  it('is false for null, blank, and non-disposition queries', () => {
    expect(filterQueryPinsDisposition(null)).toBe(false);
    expect(filterQueryPinsDisposition('')).toBe(false);
    expect(filterQueryPinsDisposition('priority:high')).toBe(false);
  });

  it('is true only for a recognised disposition value', () => {
    expect(filterQueryPinsDisposition('disposition:handled')).toBe(true);
    expect(filterQueryPinsDisposition('disposition:bogus')).toBe(false);
  });
});
