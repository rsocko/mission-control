import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { previewHubProjectRuleMatches } from '@/lib/projects/organization-service';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const matches = await previewHubProjectRuleMatches(id);
    if (!matches) return ApiErrors.notFound('Project');
    return NextResponse.json({ matches, total: matches.length });
  } catch (error) {
    return ApiErrors.internal('Failed to preview auto-include rules', error);
  }
}
