export const SCOUT_SOURCE_TYPES = ['email', 'teams', 'meeting', 'planner', 'cross-source'] as const;
export type ScoutSourceType = typeof SCOUT_SOURCE_TYPES[number];

export const SCOUT_LANDING_MODES = ['direct', 'triage', 'hybrid'] as const;
export type ScoutLandingMode = typeof SCOUT_LANDING_MODES[number];

export interface ScoutAutoExecuteAction {
  action: 'complete-task';
  sourceTypes: ScoutSourceType[];
  target: 'scout-originated';
  minimumConfidence: number;
}

export interface ScoutAutonomySettings {
  triageDefault: 'recommend' | 'confirm';
  strongSuggestionThreshold: number;
  autoExecuteActions: ScoutAutoExecuteAction[];
}

export interface ScoutConnectorSettings {
  landingMode: ScoutLandingMode;
  allowedSourceTypes: ScoutSourceType[];
  hybridConfidenceThreshold: number;
  autoProjectId: string | null;
  autonomy: ScoutAutonomySettings;
}

export const DEFAULT_SCOUT_SETTINGS: ScoutConnectorSettings = {
  landingMode: 'hybrid',
  allowedSourceTypes: [...SCOUT_SOURCE_TYPES],
  hybridConfidenceThreshold: 0.8,
  autoProjectId: null,
  autonomy: {
    triageDefault: 'recommend',
    strongSuggestionThreshold: 0.85,
    autoExecuteActions: [],
  },
};

export const LEGACY_SCOUT_SETTINGS: ScoutConnectorSettings = {
  ...DEFAULT_SCOUT_SETTINGS,
  landingMode: 'direct',
};

function asSettingsRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }
  return {};
}

function parseAutonomy(
  value: unknown,
  fallback: ScoutAutonomySettings,
): ScoutAutonomySettings {
  const autonomy = asSettingsRecord(value);
  const triageDefault = autonomy.triageDefault === 'confirm' || autonomy.triageDefault === 'recommend'
    ? autonomy.triageDefault
    : fallback.triageDefault;
  const strongSuggestionThreshold =
    typeof autonomy.strongSuggestionThreshold === 'number'
    && Number.isFinite(autonomy.strongSuggestionThreshold)
    && autonomy.strongSuggestionThreshold >= 0
    && autonomy.strongSuggestionThreshold <= 1
      ? autonomy.strongSuggestionThreshold
      : fallback.strongSuggestionThreshold;
  const autoExecuteActions = Array.isArray(autonomy.autoExecuteActions)
    ? autonomy.autoExecuteActions.flatMap((entry): ScoutAutoExecuteAction[] => {
        const candidate = asSettingsRecord(entry);
        if (
          candidate.action !== 'complete-task'
          || candidate.target !== 'scout-originated'
          || typeof candidate.minimumConfidence !== 'number'
          || !Number.isFinite(candidate.minimumConfidence)
          || candidate.minimumConfidence < 0.9
          || candidate.minimumConfidence > 1
          || !Array.isArray(candidate.sourceTypes)
        ) {
          return [];
        }
        const sourceTypes = candidate.sourceTypes.filter(
          (sourceType): sourceType is ScoutSourceType =>
            typeof sourceType === 'string' && SCOUT_SOURCE_TYPES.includes(sourceType as ScoutSourceType),
        );
        if (sourceTypes.length === 0) return [];
        return [{
          action: 'complete-task',
          target: 'scout-originated',
          minimumConfidence: candidate.minimumConfidence,
          sourceTypes,
        }];
      })
    : fallback.autoExecuteActions;

  return { triageDefault, strongSuggestionThreshold, autoExecuteActions };
}

export function parseScoutSettings(
  value: unknown,
  fallback: ScoutConnectorSettings = DEFAULT_SCOUT_SETTINGS,
): ScoutConnectorSettings {
  const settings = asSettingsRecord(value);
  const landingMode = SCOUT_LANDING_MODES.includes(settings.landingMode as ScoutLandingMode)
    ? settings.landingMode as ScoutLandingMode
    : fallback.landingMode;
  const allowedSourceTypes = Array.isArray(settings.allowedSourceTypes)
    ? settings.allowedSourceTypes.filter(
        (sourceType): sourceType is ScoutSourceType =>
          typeof sourceType === 'string' && SCOUT_SOURCE_TYPES.includes(sourceType as ScoutSourceType),
      )
    : [...fallback.allowedSourceTypes];
  const hybridConfidenceThreshold =
    typeof settings.hybridConfidenceThreshold === 'number'
    && Number.isFinite(settings.hybridConfidenceThreshold)
    && settings.hybridConfidenceThreshold >= 0
    && settings.hybridConfidenceThreshold <= 1
      ? settings.hybridConfidenceThreshold
      : fallback.hybridConfidenceThreshold;
  const autoProjectId = typeof settings.autoProjectId === 'string' && settings.autoProjectId.trim()
    ? settings.autoProjectId.trim()
    : null;
  const autonomy = parseAutonomy(settings.autonomy, fallback.autonomy);

  return {
    landingMode,
    allowedSourceTypes,
    hybridConfidenceThreshold,
    autoProjectId,
    autonomy,
  };
}

export function validateScoutSettings(value: unknown):
  | { success: true; data: ScoutConnectorSettings }
  | { success: false; error: string } {
  const settings = asSettingsRecord(value);

  if (!SCOUT_LANDING_MODES.includes(settings.landingMode as ScoutLandingMode)) {
    return { success: false, error: `landingMode must be one of: ${SCOUT_LANDING_MODES.join(', ')}` };
  }
  if (
    !Array.isArray(settings.allowedSourceTypes)
    || settings.allowedSourceTypes.some(
      sourceType => typeof sourceType !== 'string'
        || !SCOUT_SOURCE_TYPES.includes(sourceType as ScoutSourceType),
    )
  ) {
    return { success: false, error: `allowedSourceTypes must contain only: ${SCOUT_SOURCE_TYPES.join(', ')}` };
  }
  if (
    typeof settings.hybridConfidenceThreshold !== 'number'
    || !Number.isFinite(settings.hybridConfidenceThreshold)
    || settings.hybridConfidenceThreshold < 0
    || settings.hybridConfidenceThreshold > 1
  ) {
    return { success: false, error: 'hybridConfidenceThreshold must be a number between 0 and 1' };
  }
  if (
    settings.autoProjectId !== null
    && settings.autoProjectId !== undefined
    && (typeof settings.autoProjectId !== 'string' || !settings.autoProjectId.trim())
  ) {
    return { success: false, error: 'autoProjectId must be a non-empty project ID or null' };
  }
  if (settings.autonomy !== undefined) {
    const autonomy = asSettingsRecord(settings.autonomy);
    const actions = autonomy.autoExecuteActions;
    if (
      !['recommend', 'confirm'].includes(String(autonomy.triageDefault))
      || typeof autonomy.strongSuggestionThreshold !== 'number'
      || autonomy.strongSuggestionThreshold < 0
      || autonomy.strongSuggestionThreshold > 1
      || !Array.isArray(actions)
      || actions.some((entry) => {
        const action = asSettingsRecord(entry);
        return action.action !== 'complete-task'
          || action.target !== 'scout-originated'
          || typeof action.minimumConfidence !== 'number'
          || action.minimumConfidence < 0.9
          || action.minimumConfidence > 1
          || !Array.isArray(action.sourceTypes)
          || action.sourceTypes.length === 0
          || action.sourceTypes.some(
            sourceType => typeof sourceType !== 'string'
              || !SCOUT_SOURCE_TYPES.includes(sourceType as ScoutSourceType),
          );
      })
    ) {
      return {
        success: false,
        error: 'autonomy must define a valid default, threshold, and scoped complete-task policies with minimumConfidence >= 0.9',
      };
    }
  }

  return { success: true, data: parseScoutSettings(settings) };
}
