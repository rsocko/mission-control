import { NextResponse } from 'next/server';
import { isAuthorizedMcpRequest } from '@/mcp/auth';
import {
  reconcileScoutTasks,
  ScoutReconciliationError,
} from '@/lib/connectors/scout/reconciliation-service';
import { ApiErrors } from '@/lib/api-error';

export async function POST(request: Request) {
  if (!isAuthorizedMcpRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const body = await request.json();
    const result = await reconcileScoutTasks(body);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ScoutReconciliationError) {
      return NextResponse.json(
        { error: error.message },
        {
          status: error.status,
          headers: error.retryAfterSeconds
            ? { 'Retry-After': String(error.retryAfterSeconds) }
            : undefined,
        },
      );
    }
    if (error instanceof SyntaxError) {
      return ApiErrors.badRequest('Request body must be valid JSON');
    }
    return ApiErrors.internal('Scout reconciliation failed', error);
  }
}
