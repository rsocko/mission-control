function firstNonEmpty(...values: Array<string | undefined>): string | null {
  for (const value of values) {
    const normalized = value?.trim();
    if (normalized) return normalized;
  }
  return null;
}

export function resolveRuntimeRelease(): string | null {
  return firstNonEmpty(
    process.env.MC_DEPLOYMENT_REVISION,
    process.env.MC_BUILD_SHA,
    process.env.GIT_SHA,
    process.env.VERCEL_GIT_COMMIT_SHA,
    process.env.MC_IMAGE_TAG,
  );
}

export const runtimeRelease = resolveRuntimeRelease();

export function publicRuntimeRelease(value = runtimeRelease): string {
  if (!value) return 'unreported';
  const normalized = value.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(normalized)
    ? normalized
    : 'invalid';
}
