import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCOUT_SETTINGS,
  LEGACY_SCOUT_SETTINGS,
  parseScoutSettings,
  validateScoutSettings,
} from '@/lib/connectors/scout/settings';

describe('Scout connector settings', () => {
  it('uses hybrid routing defaults for new connectors', () => {
    expect(parseScoutSettings(undefined)).toEqual(DEFAULT_SCOUT_SETTINGS);
  });

  it('supports direct fallback for legacy connectors without settings', () => {
    expect(parseScoutSettings({}, LEGACY_SCOUT_SETTINGS).landingMode).toBe('direct');
  });

  it('normalizes valid settings', () => {
    expect(parseScoutSettings({
      landingMode: 'triage',
      allowedSourceTypes: ['email', 'planner'],
      hybridConfidenceThreshold: 0.65,
      autoProjectId: ' proj-work ',
    })).toEqual({
      landingMode: 'triage',
      allowedSourceTypes: ['email', 'planner'],
      hybridConfidenceThreshold: 0.65,
      autoProjectId: 'proj-work',
      autonomy: DEFAULT_SCOUT_SETTINGS.autonomy,
    });
  });

  it('accepts only explicit source-scoped autonomous completion policy', () => {
    const result = validateScoutSettings({
      ...DEFAULT_SCOUT_SETTINGS,
      autonomy: {
        ...DEFAULT_SCOUT_SETTINGS.autonomy,
        autoExecuteActions: [{
          action: 'complete-task',
          sourceTypes: ['planner'],
          target: 'scout-originated',
          minimumConfidence: 0.95,
        }],
      },
    });
    expect(result.success).toBe(true);

    expect(validateScoutSettings({
      ...DEFAULT_SCOUT_SETTINGS,
      autonomy: {
        ...DEFAULT_SCOUT_SETTINGS.autonomy,
        autoExecuteActions: [{
          action: 'complete-task',
          sourceTypes: ['planner'],
          target: 'scout-originated',
          minimumConfidence: 0.5,
        }],
      },
    }).success).toBe(false);
  });

  it('rejects invalid landing modes and confidence thresholds', () => {
    expect(validateScoutSettings({
      ...DEFAULT_SCOUT_SETTINGS,
      landingMode: 'sometimes',
    }).success).toBe(false);
    expect(validateScoutSettings({
      ...DEFAULT_SCOUT_SETTINGS,
      hybridConfidenceThreshold: 1.1,
    }).success).toBe(false);
  });

  it('allows an empty source allowlist to disable all ingestion', () => {
    const result = validateScoutSettings({
      ...DEFAULT_SCOUT_SETTINGS,
      allowedSourceTypes: [],
    });

    expect(result).toEqual({
      success: true,
      data: {
        ...DEFAULT_SCOUT_SETTINGS,
        allowedSourceTypes: [],
      },
    });
  });
});
