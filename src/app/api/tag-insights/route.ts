import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { normalizeTagInsightOptions } from '@/lib/tag-insights/aggregate';
import { getTagInsights } from '@/lib/tag-insights/service';

export async function GET(request: Request) {
  try {
    const searchParams = new URL(request.url).searchParams;
    const options = normalizeTagInsightOptions({
      topN: searchParams.get('topN'),
      minCooccurrence: searchParams.get('minCooccurrence'),
      taskLimit: searchParams.get('taskLimit'),
    });
    const insights = await getTagInsights(options);
    return NextResponse.json(insights, {
      headers: { 'Cache-Control': 'private, no-store' },
    });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch tag insights', error);
  }
}
