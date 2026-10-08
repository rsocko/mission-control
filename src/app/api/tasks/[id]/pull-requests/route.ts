import { NextResponse } from 'next/server';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';
import { getGitHubConnectorToken } from '@/lib/connectors/github-issues/credentials';
import { getLinkedPullRequests } from '@/lib/connectors/github-issues/linked-pull-requests';
import { isNativeGitHubIssueSourceId } from '@/lib/connectors/github-issues/issue-transformer';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import { parseTaskMetadataCompat } from '@/lib/tasks/metadata-compat';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  try {
    const task = await (await getTaskCorePersistence()).ancillary.getTask(id);
    if (!task) return NextResponse.json({ error: 'Task not found' }, { status: 404, headers });
    if (task.connectorType !== 'github-issues' || !task.sourceId || !isNativeGitHubIssueSourceId(task.sourceId)) {
      return NextResponse.json({ pullRequests: [], hasMore: false }, { headers });
    }
    const connector = await (await getConnectorManagementPersistence()).getConnector(task.connectorInstanceId);
    if (!connector || connector.type !== 'github-issues' || !connector.enabled || connector.deletedAt !== null) {
      return NextResponse.json({ error: 'GitHub connector is not active' }, { status: 403, headers });
    }
    const token = getGitHubConnectorToken(connector.credentials, connector.settings);
    if (!token) {
      return NextResponse.json({ error: 'GitHub connector credentials are missing' }, { status: 401, headers });
    }
    const metadata = parseTaskMetadataCompat(task.metadata).metadata;
    const result = await getLinkedPullRequests(
      token,
      typeof connector.settings.apiOrigin === 'string' ? connector.settings.apiOrigin : undefined,
      task.sourceId,
      typeof metadata.nodeId === 'string' && metadata.nodeId ? metadata.nodeId : undefined,
    );
    return NextResponse.json(result, { headers });
  } catch {
    return NextResponse.json({ error: 'GitHub pull requests could not be loaded' }, { status: 502, headers });
  }
}
