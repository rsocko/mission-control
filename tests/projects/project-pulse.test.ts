import { describe, expect, it } from 'vitest';
import { deriveProjectPulse } from '@/lib/projects/project-pulse';

const now = new Date('2026-09-12T16:00:00.000Z');

function baseInput() {
  return {
    totalTasks: 10,
    completedTasks: 5,
    percentComplete: 50,
    overdueTasks: 0,
    scheduledTasks: 5,
    targetDate: '2026-10-30',
    lastActivity: '2026-09-12T12:00:00.000Z',
    recentlyCompletedTasks: 1,
  };
}

describe('deriveProjectPulse', () => {
  it('returns an explainable on-track pulse from fresh schedule evidence', () => {
    const pulse = deriveProjectPulse(baseInput(), now);

    expect(pulse).toMatchObject({
      state: 'on_track',
      legacyHealth: 'on_track',
      freshness: { state: 'fresh' },
      trend: { state: 'improving' },
      confidence: { level: 'high' },
      suggestion: null,
    });
  });

  it('puts a stale project on watch without treating staleness as lifecycle status', () => {
    const pulse = deriveProjectPulse({
      ...baseInput(),
      lastActivity: '2026-08-20T12:00:00.000Z',
      recentlyCompletedTasks: 0,
    }, now);

    expect(pulse.state).toBe('watch');
    expect(pulse.freshness.state).toBe('stale');
    expect(pulse.reasons).toContainEqual(expect.objectContaining({ code: 'stale_activity' }));
    expect(pulse.suggestion).toBe('Choose one next task and restart activity.');
  });

  it('marks materially overdue work off track with a deterministic reason', () => {
    const pulse = deriveProjectPulse({
      ...baseInput(),
      completedTasks: 6,
      percentComplete: 60,
      overdueTasks: 2,
    }, now);

    expect(pulse.state).toBe('off_track');
    expect(pulse.legacyHealth).toBe('behind');
    expect(pulse.reasons).toContainEqual(expect.objectContaining({ code: 'overdue_work' }));
    expect(pulse.suggestion).toBe('Review and reschedule the overdue work.');
  });

  it('reports unknown when no work exists instead of claiming the project is healthy', () => {
    const pulse = deriveProjectPulse({
      totalTasks: 0,
      completedTasks: 0,
      percentComplete: 0,
      overdueTasks: 0,
      scheduledTasks: 0,
    }, now);

    expect(pulse).toMatchObject({
      state: 'unknown',
      freshness: { state: 'unknown' },
      confidence: { level: 'low' },
    });
    expect(pulse.reasons[0].code).toBe('no_tasks');
    expect(pulse.suggestion).toBe('Add the first task to make progress measurable.');
  });

  it('pauses evaluation for an intentionally inactive lifecycle state', () => {
    const pulse = deriveProjectPulse({
      ...baseInput(),
      lifecycleStatus: 'on_hold',
      lastActivity: '2026-08-01T12:00:00.000Z',
    }, now);

    expect(pulse).toMatchObject({
      state: 'unknown',
      trend: { state: 'unknown', label: 'Evaluation paused' },
      suggestion: null,
    });
    expect(pulse.reasons[0].code).toBe('lifecycle_inactive');
    expect(pulse.summary).toContain('on hold');
  });
});
