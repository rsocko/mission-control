import { NextResponse } from 'next/server';
import { createTriageCapture, isValidTriageSource, isValidTriageStatus, listTriageItems } from '@/lib/triage';
import { ApiErrors } from '@/lib/api-error';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const status = searchParams.get('status');
  const source = searchParams.get('source');
  const limit = searchParams.get('limit');
  const offset = searchParams.get('offset');
  const sortBy = searchParams.get('sortBy');

  const validSorts = ['relevance', 'newest', 'oldest', 'score'] as const;
  type SortValue = typeof validSorts[number];

  try {
    const result = await listTriageItems({
      status: isValidTriageStatus(status) ? status : 'all',
      source: isValidTriageSource(source) ? source : 'all',
      q: searchParams.get('q') || undefined,
      categories: searchParams.getAll('category'),
      sortBy: sortBy && validSorts.includes(sortBy as SortValue) ? (sortBy as SortValue) : undefined,
      limit: limit ? Math.min(Math.max(parseInt(limit, 10) || 200, 1), 500) : undefined,
      offset: offset ? Math.max(parseInt(offset, 10) || 0, 0) : undefined,
    });

    return NextResponse.json(result);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch triage items', error);
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (typeof body.url !== 'string' || !body.url) {
      return ApiErrors.badRequest('url is required');
    }

    const item = await createTriageCapture({
      url: body.url,
      title: typeof body.title === 'string' ? body.title : undefined,
      description: typeof body.description === 'string' ? body.description : undefined,
      sharedText: typeof body.sharedText === 'string' ? body.sharedText : undefined,
      sourcePlatform: typeof body.sourcePlatform === 'string' && isValidTriageSource(body.sourcePlatform) && body.sourcePlatform !== 'all'
        ? body.sourcePlatform
        : undefined,
      sourceId: typeof body.sourceId === 'string' ? body.sourceId : undefined,
    });

    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return ApiErrors.internal('Failed to capture triage item', error);
  }
}
