import { describe, expect, it } from 'vitest';
import { suggestPhase } from '@/components/add-task/QuickAddSuggestionReview';

describe('Quick Add phase suggestions', () => {
  const phases = [
    { id: 'phase-discovery', name: 'Discovery' },
    { id: 'phase-launch', name: 'Launch readiness' },
  ];

  it('prefers a phase whose full name appears in the task title', () => {
    expect(suggestPhase('Finish launch readiness checklist', phases)).toEqual({
      id: 'phase-launch',
      name: 'Launch readiness',
      confidence: 0.9,
      reason: 'Phase name appears in the task',
    });
  });

  it('returns no phase when the task title has no meaningful overlap', () => {
    expect(suggestPhase('Reconcile vendor invoice', phases)).toBeNull();
  });
});
