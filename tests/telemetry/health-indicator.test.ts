import { describe, expect, it } from 'vitest';
import { getHealthIndicatorTone } from '@/lib/telemetry/health-indicator';

describe('health indicator tone', () => {
  it('uses warning for non-critical database and runtime degradation', () => {
    expect(getHealthIndicatorTone({
      overall: 'attention',
      database: { status: 'degraded' },
      runtime: { degradations: ['worker SQLite WAL has pending checkpoint work'] },
    })).toBe('warning');
  });

  it('uses critical only for database failures, connector errors, or critical runtime alerts', () => {
    expect(getHealthIndicatorTone({
      overall: 'attention',
      database: { status: 'critical' },
    })).toBe('critical');
    expect(getHealthIndicatorTone({
      overall: 'attention',
      connectors: [{ status: 'error' }],
    })).toBe('critical');
    expect(getHealthIndicatorTone({
      overall: 'attention',
      runtime: { degradations: ['critical: worker container memory pressure is critical'] },
    })).toBe('critical');
  });

  it('uses healthy and neutral tones for non-alert states', () => {
    expect(getHealthIndicatorTone({ overall: 'healthy' })).toBe('healthy');
    expect(getHealthIndicatorTone({ overall: 'informational' })).toBe('neutral');
    expect(getHealthIndicatorTone(null)).toBe('neutral');
  });
});
