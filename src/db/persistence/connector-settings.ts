export function mergeConnectorSettings(
  currentSettings: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...currentSettings, ...patch };
}

export function patchConnectorSettingsState<T extends object>(
  settings: Record<string, unknown>,
  key: string,
  patch: Partial<T>,
): { settings: Record<string, unknown>; state: T } {
  const existing = settings[key];
  const currentState = (
    existing && typeof existing === 'object' && !Array.isArray(existing)
      ? existing
      : {}
  ) as T;
  const state = { ...currentState, ...patch };

  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete state[field as keyof T];
  }

  return {
    settings: { ...settings, [key]: state },
    state,
  };
}
