import { NextResponse } from 'next/server';
import { getAuthUrl, resolveClientCredentials } from '@/lib/auth';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { eq } from 'drizzle-orm';

const CONNECTOR_DEFAULTS: Record<string, { name: string; capabilities: object; scopes: string[] }> = {
  'microsoft-todo': {
    name: 'Microsoft Todo',
    capabilities: { read: true, write: true, delete: true, sync: true, lists: true, subtasks: true, tags: false, tagWriteBack: false },
    scopes: ['Tasks.ReadWrite', 'Tasks.ReadWrite.Shared', 'offline_access', 'User.Read'],
  },
  'outlook-email': {
    name: 'Outlook Email',
    capabilities: { read: true, write: false, delete: false, sync: true, lists: false, subtasks: false, tags: false, tagWriteBack: false },
    scopes: ['Mail.Read', 'offline_access', 'User.Read'],
  },
  'outlook-calendar': {
    name: 'Outlook Calendar',
    capabilities: { read: true, write: false, delete: false, sync: true, lists: false, subtasks: false, tags: false, tagWriteBack: false },
    scopes: ['Calendars.Read', 'offline_access', 'User.Read'],
  },
};

/**
 * GET /api/auth/microsoft/connect — Start OAuth2 flow for a Microsoft account
 * Query params: instanceId (required), accountType (personal|work), connectorType (optional), tenantId (optional)
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const instanceId = searchParams.get('instanceId');
  const accountType = (searchParams.get('accountType') || 'personal') as 'personal' | 'work';
  const connectorType = searchParams.get('connectorType') || 'microsoft-todo';
  const tenantId = searchParams.get('tenantId') || undefined;
  const customName = searchParams.get('name') || undefined;

  if (!instanceId) {
    return NextResponse.json({ error: 'instanceId is required' }, { status: 400 });
  }

  // Resolve the correct app registration for this account type.
  // Supports MS_CLIENT_ID_PERSONAL / MS_CLIENT_ID_WORK overrides; falls back to MS_CLIENT_ID.
  const { clientId } = resolveClientCredentials(accountType);

  if (!clientId) {
    return NextResponse.json({ error: 'MS_CLIENT_ID not configured' }, { status: 503 });
  }

  const defaults = CONNECTOR_DEFAULTS[connectorType] || CONNECTOR_DEFAULTS['microsoft-todo'];

  // Ensure connector instance exists (create if needed)
  const existing = await db.select().from(connectorConfigs).where(
    eq(connectorConfigs.id, instanceId)
  );

  if (existing.length === 0) {
    const now = new Date().toISOString();
    await db.insert(connectorConfigs).values({
      id: instanceId,
      type: connectorType,
      name: customName || `${defaults.name} (${accountType})`,
      enabled: true,
      syncMode: 'poll',
      pollIntervalMinutes: connectorType === 'microsoft-todo' ? 5 : 10,
      capabilities: defaults.capabilities as Record<string, unknown>,
      credentials: {},
      settings: {
        accountType,
        tenantId,
        ...(connectorType === 'microsoft-todo' ? { syncMicroStatus: false } : {}),
      } as Record<string, unknown>,
      syncedLists: [] as unknown[],
      createdAt: now,
      updatedAt: now,
    });
  }

  const authUrl = getAuthUrl({
    connectorInstanceId: instanceId,
    accountType,
    tenantId,
    scopes: defaults.scopes,
    clientId,
  });

  // Redirect to Microsoft login
  return NextResponse.redirect(authUrl);
}
