import { NextResponse } from 'next/server';
import db from '@/db';
import { sourceRankings } from '@/db/schema';
import { eq, asc } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

export async function GET() {
  try {
    const rankings = db
      .select()
      .from(sourceRankings)
      .orderBy(asc(sourceRankings.rank))
      .all();

    return NextResponse.json({ rankings });
  } catch (error) {
    return ApiErrors.internal('Failed to fetch source rankings', error);
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { rankings } = body;

    if (!Array.isArray(rankings)) {
      return ApiErrors.badRequest('rankings array is required');
    }

    const now = new Date().toISOString();

    for (const ranking of rankings) {
      const existing = db.select().from(sourceRankings).where(eq(sourceRankings.id, ranking.id)).get();

      if (existing) {
        db.update(sourceRankings)
          .set({ rank: ranking.rank, name: ranking.name || existing.name, updatedAt: now })
          .where(eq(sourceRankings.id, ranking.id))
          .run();
      } else {
        db.insert(sourceRankings).values({
          id: ranking.id,
          connectorType: ranking.connectorType,
          name: ranking.name,
          rank: ranking.rank,
          updatedAt: now,
        }).run();
      }
    }

    const updated = db.select().from(sourceRankings).orderBy(asc(sourceRankings.rank)).all();
    return NextResponse.json({ rankings: updated });
  } catch (error) {
    return ApiErrors.internal('Failed to update source rankings', error);
  }
}
