import { NextResponse } from 'next/server';
import { listReconciliationSuggestions } from '@/lib/connectors/scout/reconciliation-service';
import { ApiErrors } from '@/lib/api-error';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const requestedLimit = Number(searchParams.get('limit') ?? 100);
    if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
      return ApiErrors.badRequest('limit must be an integer between 1 and 100');
    }
    const suggestions = await listReconciliationSuggestions({ limit: requestedLimit });
    return NextResponse.json({ suggestions, count: suggestions.length });
  } catch (error) {
    return ApiErrors.internal('Failed to load reconciliation suggestions', error);
  }
}
