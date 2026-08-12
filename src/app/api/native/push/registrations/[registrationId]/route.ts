import { NextResponse } from 'next/server';
import { processApnsUnregistration } from '@/lib/native/apns-registration-service';
import { readBoundedNativeJson } from '@/lib/native/api-request';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ registrationId: string }> },
) {
  const body = await readBoundedNativeJson(request);
  const { registrationId } = await params;
  const result = await processApnsUnregistration(request, body, registrationId);
  return NextResponse.json(result.body, { status: result.status });
}
