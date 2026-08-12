import { NextResponse } from 'next/server';
import db from '@/db';
import { hubProjects } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';
import { previewProjectRules } from '@/lib/rules';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const [project] = await db.select({ id: hubProjects.id })
      .from(hubProjects)
      .where(eq(hubProjects.id, id))
      .limit(1);
    if (!project) return ApiErrors.notFound('Project');

    const matches = await previewProjectRules(id);
    return NextResponse.json({ matches, total: matches.length });
  } catch (error) {
    return ApiErrors.internal('Failed to preview auto-include rules', error);
  }
}
