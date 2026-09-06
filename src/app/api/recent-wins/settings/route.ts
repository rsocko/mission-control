import { NextResponse } from 'next/server';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import logger from '@/lib/logger';

const SETTINGS_KEY = 'recent-wins-deprioritized-lists';

export async function GET() {
  try {
    const value = await getCorePersistenceRepositories().settings.get(SETTINGS_KEY);

    return NextResponse.json({
      deprioritizedLists: Array.isArray(value) ? value as string[] : [],
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to fetch recent wins settings');
    return NextResponse.json({ deprioritizedLists: [] });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { deprioritizedLists } = body as { deprioritizedLists: string[] };

    if (!Array.isArray(deprioritizedLists)) {
      return NextResponse.json({ error: 'deprioritizedLists must be an array' }, { status: 400 });
    }

    // Prevent abuse: limit count and string lengths
    if (deprioritizedLists.length > 100) {
      return NextResponse.json({ error: 'Too many entries (max 100)' }, { status: 400 });
    }
    if (deprioritizedLists.some((s) => typeof s !== 'string' || s.length > 200)) {
      return NextResponse.json({ error: 'Invalid entry: must be strings under 200 chars' }, { status: 400 });
    }

    // A single atomic key upsert replaces the previous read-then-write pair.
    await getCorePersistenceRepositories().settings.set(SETTINGS_KEY, deprioritizedLists);

    return NextResponse.json({ ok: true, deprioritizedLists });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update recent wins settings');
    return NextResponse.json({ error: 'Internal error' }, { status: 500 });
  }
}
