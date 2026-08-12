import { NextResponse } from 'next/server';
import db from '@/db';
import { appSettings } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

const KANBAN_KEY = 'kanban_global_columns';

export interface KanbanColumn {
  id: string;
  name: string;
  color: string;
  order: number;
  statusMapping?: string[];
}

const DEFAULT_COLUMNS: KanbanColumn[] = [
  { id: 'backlog', name: 'Backlog', color: '#6b7280', order: 0, statusMapping: ['todo'] },
  { id: 'in-progress', name: 'In Progress', color: '#3b82f6', order: 1, statusMapping: ['in_progress'] },
  { id: 'review', name: 'Review', color: '#8b5cf6', order: 2, statusMapping: [] },
  { id: 'done', name: 'Done', color: '#22c55e', order: 3, statusMapping: ['done'] },
];

/**
 * GET /api/kanban-settings - Get global kanban columns
 */
export async function GET() {
  try {
    const [row] = await db.select().from(appSettings).where(eq(appSettings.key, KANBAN_KEY));
    const columns = row ? (row.value as KanbanColumn[]) : DEFAULT_COLUMNS;
    return NextResponse.json({ columns, isDefault: !row });
  } catch {
    return NextResponse.json({ columns: DEFAULT_COLUMNS, isDefault: true });
  }
}

/**
 * PUT /api/kanban-settings - Save global kanban columns
 */
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { columns } = body as { columns: KanbanColumn[] };

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return ApiErrors.badRequest('At least one column is required');
    }

    const now = new Date().toISOString();
    const [existing] = await db.select().from(appSettings).where(eq(appSettings.key, KANBAN_KEY));

    if (existing) {
      await db.update(appSettings).set({ value: columns, updatedAt: now }).where(eq(appSettings.key, KANBAN_KEY));
    } else {
      await db.insert(appSettings).values({ key: KANBAN_KEY, value: columns, updatedAt: now });
    }

    return NextResponse.json({ success: true, columns });
  } catch (error) {
    return ApiErrors.internal('Failed to save', error);
  }
}

/**
 * DELETE /api/kanban-settings - Reset to default columns
 */
export async function DELETE() {
  try {
    await db.delete(appSettings).where(eq(appSettings.key, KANBAN_KEY));
    return NextResponse.json({ success: true, columns: DEFAULT_COLUMNS });
  } catch (error) {
    return ApiErrors.internal('Failed to reset', error);
  }
}
