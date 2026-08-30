import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { captureHoustonMemory } from '@/lib/houston-memory/capture';
import { isTrustedHoustonMemoryRequest } from '@/lib/houston-memory/request-auth';
import { getHoustonMemorySettings } from '@/lib/houston-memory/settings';
import { listHoustonMemories } from '@/lib/houston-memory/service';
import { aiLogger } from '@/lib/logger';

export async function GET(request: Request) {
  if (!isTrustedHoustonMemoryRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const settings = await getHoustonMemorySettings();
  const memories = settings.enabled
    ? await listHoustonMemories({ limit: 20 })
    : [];
  return NextResponse.json({ settings, memories });
}

export async function POST(request: Request) {
  if (!isTrustedHoustonMemoryRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const result = await captureHoustonMemory(await request.json());
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return NextResponse.json({ error: 'Invalid memory capture request' }, { status: 400 });
    }
    aiLogger.warn({
      event: 'houston_memory_capture_failed',
    }, 'Houston memory capture failed');
    return NextResponse.json(
      { status: 'unavailable', reason: 'capture-failed' },
      { status: 503 },
    );
  }
}
