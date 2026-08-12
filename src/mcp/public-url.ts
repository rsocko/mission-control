/**
 * Resolves the public-facing URL for Mission Control links shown to users.
 *
 * Checks (in order): MC_PUBLIC_URL, NEXTAUTH_URL, NEXT_PUBLIC_BASE_URL,
 * then constructs from MC_HOSTNAME if available, derives from MS_REDIRECT_URI
 * if present, and finally falls back to MC_BASE_URL.
 * Falls back to http://localhost:3099 only if none are set.
 */
export function resolvePublicUrl(): string {
  const explicit =
    process.env.MC_PUBLIC_URL ||
    process.env.NEXTAUTH_URL ||
    process.env.NEXT_PUBLIC_BASE_URL;

  if (explicit) return explicit.replace(/\/+$/, '');

  if (process.env.MC_HOSTNAME) {
    return `https://${process.env.MC_HOSTNAME}`;
  }

  // Derive from MS_REDIRECT_URI (e.g. https://mission-control.example/api/auth/microsoft/callback)
  if (process.env.MS_REDIRECT_URI) {
    try {
      const parsed = new URL(process.env.MS_REDIRECT_URI);
      return parsed.origin;
    } catch {
      // Malformed URI — fall through
    }
  }

  return (process.env.MC_BASE_URL || 'http://localhost:3099').replace(/\/+$/, '');
}

export const MC_PUBLIC_URL: string = resolvePublicUrl();
