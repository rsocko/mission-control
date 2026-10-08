import { describe, expect, it } from 'vitest';
import { getKpiRotationState, normalizeConfig } from '@/components/kpi/KpiBar';
import { DEFAULT_KPI_SLUGS, KPI_REGISTRY } from '@/lib/kpi/registry';

describe('dashboard KPI configuration', () => {
  it('normalizes persisted configuration without losing a valid rotation pool', () => {
    expect(normalizeConfig({
      cards: ['total-open', 'horizon-next', 'total-open', 'unknown'],
      pinned: ['horizon-next', 'unknown'],
      visibleSlots: 99,
      rotationInterval: 100,
      pauseOnHover: false,
      autoSurface: false,
    })).toEqual({
      cards: ['total-open', 'horizon-next'],
      pinned: ['horizon-next'],
      visibleSlots: 6,
      rotationInterval: 5_000,
      pauseOnHover: false,
      autoSurface: false,
    });
  });

  it('falls back to the four-card default for malformed or empty storage', () => {
    expect(normalizeConfig(null).cards).toEqual(DEFAULT_KPI_SLUGS);
    expect(normalizeConfig({ cards: ['not-a-kpi'], visibleSlots: 1 })).toMatchObject({
      cards: DEFAULT_KPI_SLUGS,
      visibleSlots: 3,
    });
  });

  it('caps persisted pins at the number of visible slots', () => {
    expect(normalizeConfig({
      cards: ['total-open', 'overdue', 'daily-avg', 'my-day'],
      pinned: ['total-open', 'overdue', 'daily-avg', 'my-day'],
      visibleSlots: 3,
    }).pinned).toEqual(['total-open', 'overdue', 'daily-avg']);
  });

  it('exposes schema-backed planning and previously missing task KPIs', () => {
    expect(KPI_REGISTRY).toMatchObject({
      'assigned-to-me': { category: 'task_counts' },
      'horizon-next': { category: 'planning' },
      'horizon-soon': { category: 'planning' },
      'needs-horizon': { category: 'planning' },
    });
  });

  it('pins active filters and prioritizes non-zero attention KPIs', () => {
    expect(getKpiRotationState({
      slugs: ['total-open', 'daily-avg', 'overdue', 'assigned-to-me'],
      pinnedSlugs: ['total-open'],
      quickFilter: 'assigned',
      visibleSlots: 3,
      rotationIndex: 0,
      data: {
        'total-open': { slug: 'total-open', value: 12 },
        'daily-avg': { slug: 'daily-avg', value: 4 },
        overdue: { slug: 'overdue', value: 2 },
        'assigned-to-me': { slug: 'assigned-to-me', value: 3 },
      },
    })).toEqual({
      rotatingPool: ['overdue', 'daily-avg'],
      visibleCards: ['assigned-to-me', 'total-open', 'overdue'],
      rotationActive: true,
    });
  });

  it('stays static and safe when pinned cards fill every visible slot', () => {
    expect(getKpiRotationState({
      slugs: ['total-open', 'overdue', 'daily-avg'],
      pinnedSlugs: ['total-open', 'overdue', 'daily-avg'],
      visibleSlots: 3,
      rotationIndex: 50,
      data: {},
    })).toEqual({
      rotatingPool: [],
      visibleCards: ['total-open', 'overdue', 'daily-avg'],
      rotationActive: false,
    });
  });

  it('gives an active filter precedence over user-pinned cards', () => {
    expect(getKpiRotationState({
      slugs: ['total-open', 'daily-avg', 'overdue', 'assigned-to-me'],
      pinnedSlugs: ['total-open', 'daily-avg', 'overdue'],
      quickFilter: 'assigned',
      visibleSlots: 3,
      rotationIndex: 0,
      data: {},
    }).visibleCards).toEqual(['assigned-to-me', 'total-open', 'daily-avg']);
  });

  it('preserves the configured order when every card fits', () => {
    expect(getKpiRotationState({
      slugs: ['daily-avg', 'overdue', 'total-open'],
      pinnedSlugs: [],
      visibleSlots: 3,
      rotationIndex: 0,
      data: {
        'daily-avg': { slug: 'daily-avg', value: 4 },
        overdue: { slug: 'overdue', value: 2 },
        'total-open': { slug: 'total-open', value: 12 },
      },
    }).visibleCards).toEqual(['daily-avg', 'overdue', 'total-open']);
  });
});
