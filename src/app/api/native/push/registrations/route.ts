import { NextResponse } from 'next/server';
import { processApnsRegistration } from '@/lib/native/apns-registration-service';
import { readBoundedNativeJson } from '@/lib/native/api-request';

export async function POST(request: Request) {
  const body = await readBoundedNativeJson(request);
  const result = await processApnsRegistration(request, body);
  return NextResponse.json(result.body, { status: result.status });
}
