import { whatsNext } from '@/lib/ai/features/whats-next';
import { aiLogger } from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

function parseContext(request: Request) {
  const { searchParams } = new URL(request.url);
  const timeAvailable = searchParams.get('timeAvailable');
  const energy = searchParams.get('energy');
  const focus = searchParams.get('focus');

  return {
    timeAvailable: timeAvailable ? Number(timeAvailable) : undefined,
    energy: energy === 'med' ? 'medium' : (energy as 'high' | 'medium' | 'low' | null) || undefined,
    focus: focus?.trim() || undefined,
  };
}

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => ({}));
    const result = await whatsNext(body);
    return Response.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    aiLogger.error({ err: error }, 'Whats-next request failed');
    return ApiErrors.internal('Failed', error);
  }
}

export async function GET(request: Request) {
  try {
    const context = parseContext(request);
    const result = await whatsNext(context);
    return Response.json({ ...result, generatedAt: new Date().toISOString() });
  } catch (error) {
    aiLogger.error({ err: error }, 'Whats-next request failed');
    return ApiErrors.internal('Failed', error);
  }
}
