import { NextResponse } from 'next/server';
import {
  getPreferenceSettingsRepositoryForBackend,
  type CaptureDestinationSetting,
} from '@/lib/settings/preference-settings';

/**
 * GET /api/settings/capture-destination — Get user's default capture destination
 */
export async function GET() {
  const repository = await getPreferenceSettingsRepositoryForBackend();
  const destination = await repository.getCaptureDestination();
  return NextResponse.json({ destination });
}

/**
 * PUT /api/settings/capture-destination — Set user's default capture destination
 * Body: { connectorType, connectorInstanceId?, sourceListId?, sourceListName? }
 */
export async function PUT(request: Request) {
  const body = await request.json();

  const { connectorType, connectorInstanceId, sourceListId, sourceListName } = body;

  if (!connectorType || typeof connectorType !== 'string') {
    return NextResponse.json({ error: 'connectorType is required' }, { status: 400 });
  }

  const destination: CaptureDestinationSetting = {
    connectorType,
    ...(connectorInstanceId && { connectorInstanceId }),
    ...(sourceListId && { sourceListId }),
    ...(sourceListName && { sourceListName }),
  };

  const repository = await getPreferenceSettingsRepositoryForBackend();
  await repository.setCaptureDestination(destination);

  return NextResponse.json({ destination });
}
