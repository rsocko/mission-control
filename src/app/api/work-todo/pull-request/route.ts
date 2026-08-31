import { NextResponse } from 'next/server';
import { z } from 'zod';
import { safeEqual } from '@/lib/api/trusted-request';
import {
  createWorkTodoPullRequest,
  WorkTodoBridgeError,
} from '@/lib/connectors/work-todo/service';

const requestSchema = z.object({
  connectorInstanceId: z.string().min(1).max(100),
}).strict();

function isAuthorized(request: Request): boolean {
  const expected = process.env.MC_API_KEY;
  if (!expected) return true;
  const header = request.headers.get('x-mc-api-key');
  if (header && safeEqual(header, expected)) return true;
  const authorization = request.headers.get('authorization');
  return Boolean(
    authorization?.startsWith('Bearer ')
    && safeEqual(authorization.slice('Bearer '.length).trim(), expected),
  );
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid Work To Do pull request' }, { status: 400 });
  }
  try {
    return NextResponse.json(await createWorkTodoPullRequest(parsed.data.connectorInstanceId));
  } catch (error) {
    if (error instanceof WorkTodoBridgeError) {
      return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
    }
    throw error;
  }
}
