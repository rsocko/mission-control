import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getConnectorManagementPersistence } from '@/lib/connectors/management-service';

export async function GET() {
  try {
    const rankings = await (await getConnectorManagementPersistence()).listSourceRankings();

    return NextResponse.json({ rankings });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch source rankings', error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { rankings } = body;

    if (!Array.isArray(rankings)) {
      return ApiErrors.badRequest('rankings array is required');
    }

    const updated = await (await getConnectorManagementPersistence())
      .putSourceRankings(rankings, new Date().toISOString());
    return NextResponse.json({ rankings: updated });
  } catch (error) {
    return ApiErrors.internal('Failed to update source rankings', error);
  }
}
