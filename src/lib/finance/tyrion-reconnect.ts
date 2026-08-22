function allowedTyrionHosts(): Set<string> {
  return new Set([
    'tyrion.example',
    ...(process.env.FINANCE_EXTERNAL_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((host) => host.trim().toLowerCase())
      .filter(Boolean),
  ]);
}

export function resolveTyrionReconnectUrl(): string {
  const configuredRoot = process.env.TYRION_OPERATIONS_URL?.trim();
  if (!configuredRoot) {
    throw new Error('Tyrion operations URL is not configured');
  }
  const url = new URL(configuredRoot);
  if (
    url.protocol !== 'https:'
    || url.username
    || url.password
    || url.pathname !== '/'
    || url.search
    || url.hash
    || !allowedTyrionHosts().has(url.hostname.toLowerCase())
  ) {
    throw new Error('Tyrion operations URL is not approved');
  }
  url.searchParams.set('source', 'mission-control');
  return url.toString();
}
