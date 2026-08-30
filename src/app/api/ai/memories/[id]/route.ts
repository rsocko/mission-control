import { NextResponse } from 'next/server';
import { isTrustedHoustonMemoryRequest } from '@/lib/houston-memory/request-auth';
import {
  deleteHoustonMemory,
  excludeHoustonMemory,
  getHoustonMemory,
} from '@/lib/houston-memory/service';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, context: RouteContext) {
  if (!isTrustedHoustonMemoryRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const memory = await getHoustonMemory(id);
  if (!memory) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ memory });
}

export async function PATCH(request: Request, context: RouteContext) {
  if (!isTrustedHoustonMemoryRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const body = await request.json().catch(() => null) as { excluded?: unknown } | null;
  if (body?.excluded !== true) {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }
  const { id } = await context.params;
  const excluded = await excludeHoustonMemory(id);
  if (!excluded) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ excluded: true });
}

export async function DELETE(request: Request, context: RouteContext) {
  if (!isTrustedHoustonMemoryRequest(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const { id } = await context.params;
  const deleted = await deleteHoustonMemory(id);
  if (!deleted) return NextResponse.json({ error: 'Not found' }, { status: 404 });
  return NextResponse.json({ deleted: true });
}
