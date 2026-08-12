import { NextResponse } from 'next/server';
import { getProjectsOverview } from '@/lib/projects-overview';
import { ApiErrors } from '@/lib/api-error';

/**
 * GET /api/projects-overview — Aggregate view with all projects grouped by category
 */
export async function GET() {
  try {
    const overview = await getProjectsOverview();
    return NextResponse.json(overview);
  } catch (error) {
    return ApiErrors.internal('Failed to fetch projects overview', error);
  }
}
