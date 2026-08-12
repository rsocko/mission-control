export function isPublicDemoValue(value: string | undefined): boolean {
  return value === 'true';
}

export function isPublicDemoMode(): boolean {
  return isPublicDemoValue(process.env.MC_PUBLIC_DEMO);
}

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

const blockedPrefixes = [
  '/api/ai',
  '/api/auth',
  '/api/bug-report',
  '/api/goals/develop',
  '/api/inbound-webhooks',
  '/api/integrations',
  '/api/ideation/expand',
  '/api/mcp',
  '/api/notifications/triage',
  '/api/project-phases/ai-refine',
  '/api/project-phases/ai-suggest',
  '/api/push',
  '/api/resets/ai-summary',
  '/api/scout',
  '/api/shortcut',
  '/api/webhooks',
];

const blockedTriagePrefixes = [
  '/api/triage/auto-sync',
  '/api/triage/backfill-embeds',
  '/api/triage/backfill-thumbnails',
  '/api/triage/capture',
  '/api/triage/cron',
  '/api/triage/digest/send',
  '/api/triage/extension-config',
  '/api/triage/import',
  '/api/triage/maintenance',
  '/api/triage/reclassify',
  '/api/triage/sources',
  '/api/triage/storage',
];

const blockedTaskFragments = [
  '/breakdown',
  '/move-to-list',
  '/move/execute',
  '/quick-sort/suggestions',
];

export function getPublicDemoRestriction(pathname: string, method: string): string | null {
  const normalizedMethod = method.toUpperCase();

  if (normalizedMethod === 'GET'
    && matchesPrefix(pathname, '/api/scout/reconciliation/suggestions')) {
    return null;
  }

  if (blockedPrefixes.some((prefix) => matchesPrefix(pathname, prefix))) {
    return 'This integration is unavailable in the public demo.';
  }

  if (matchesPrefix(pathname, '/api/connectors')) {
    const safeConnectorRead = normalizedMethod === 'GET'
      && (pathname === '/api/connectors' || /^\/api\/connectors\/[^/]+\/health$/.test(pathname));
    return safeConnectorRead ? null : 'Connector administration is unavailable in the public demo.';
  }

  if (matchesPrefix(pathname, '/api/settings') && normalizedMethod !== 'GET') {
    return 'Demo environment settings are managed by the deployment.';
  }

  if (matchesPrefix(pathname, '/api/sync') && !(normalizedMethod === 'GET' && pathname === '/api/sync/health')) {
    return 'External synchronization is unavailable in the public demo.';
  }

  if (blockedTriagePrefixes.some((prefix) => matchesPrefix(pathname, prefix))
    || /^\/api\/triage\/[^/]+\/extract-actions$/.test(pathname)) {
    return 'This triage integration is unavailable in the public demo.';
  }

  if (pathname === '/api/triage/digest' && normalizedMethod !== 'GET') {
    return 'Digest generation is unavailable in the public demo.';
  }

  if (matchesPrefix(pathname, '/api/tasks')
    && blockedTaskFragments.some((fragment) => pathname.includes(fragment))) {
    return 'This task integration is unavailable in the public demo.';
  }

  if (matchesPrefix(pathname, '/api/tasks')
    && pathname.includes('/attachments')
    && normalizedMethod !== 'GET') {
    return 'Attachment changes are unavailable in the public demo.';
  }

  if (matchesPrefix(pathname, '/api/source-lists') && normalizedMethod !== 'GET') {
    return 'Source administration is unavailable in the public demo.';
  }

  if (pathname === '/api/tags/push' || pathname === '/api/tags/remove-from-source') {
    return 'Tag write-back is unavailable in the public demo.';
  }

  if (pathname === '/api/calendar-events'
    || pathname === '/api/my-day/sync'
    || pathname === '/api/notifications/re-enrich'
    || /^\/api\/notifications\/[^/]+\/actions\/[^/]+$/.test(pathname)
    || pathname === '/api/finance/sync') {
    return 'This external operation is unavailable in the public demo.';
  }

  return null;
}
