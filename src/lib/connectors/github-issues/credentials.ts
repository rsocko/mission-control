export function getGitHubConnectorToken(
  credentials: Record<string, unknown>,
  settings: Record<string, unknown>,
): string | null {
  for (const candidate of [credentials.token, credentials.pat, settings.token]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return null;
}
