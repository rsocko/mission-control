import { NextResponse } from 'next/server';
import { probePermissions } from '@/lib/auth';
import { ApiErrors } from '@/lib/api-error';
import { probeGitHubScopes } from '@/lib/connectors/github-issues/scope-probe';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

/**
 * GET /api/connectors/[id]/permissions — Probe what permissions are available.
 * Routes to the correct prober based on connector type:
 *  - Microsoft connectors → Graph API permission probe
 *  - GitHub → PAT scope detection via X-OAuth-Scopes header
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  try {
    // Look up connector to determine type
    const connector = await (
      await getConnectorManagementPersistence()
    ).getConnector(id);

    if (!connector) {
      return NextResponse.json({ error: 'Connector not found' }, { status: 404 });
    }

    if (connector.type === 'github-issues') {
      const credentials = connector.credentials as Record<string, string> | null;
      const token = credentials?.token;
      if (!token) {
        return NextResponse.json({ error: 'No token configured' }, { status: 400 });
      }
      const result = await probeGitHubScopes(token);
      return NextResponse.json(result);
    }

    // Default: Microsoft Graph permission probe
    const result = await probePermissions(id);
    return NextResponse.json(result);
  } catch (error) {
    return ApiErrors.internal('Permission probe failed', error);
  }
}
