import { NextResponse } from 'next/server';
import { getCorePersistenceRepositories } from '@/lib/persistence/runtime';
import type { PersistenceJson } from '@/db/persistence/contracts';
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
 * Narrows a decoded request body to the JSON shape the settings repository
 * accepts. Columns are stored verbatim — the board owns their schema — so this
 * checks JSON-ness rather than reshaping the payload.
 */
function toPersistenceJson(value: unknown): PersistenceJson | undefined {
  if (
    value === null
    || typeof value === 'boolean'
    || typeof value === 'number'
    || typeof value === 'string'
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    const items: PersistenceJson[] = [];
    for (const entry of value) {
      const converted = toPersistenceJson(entry);
      if (converted === undefined) return undefined;
      items.push(converted);
    }
    return items;
  }
  if (typeof value === 'object') {
    const record: { [key: string]: PersistenceJson } = {};
    for (const [key, entry] of Object.entries(value)) {
      const converted = toPersistenceJson(entry);
      if (converted === undefined) return undefined;
      record[key] = converted;
    }
    return record;
  }
  return undefined;
}

function readColumns(body: unknown): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, 'columns')?.value;
}

/**
 * GET /api/kanban-settings - Get global kanban columns
 */
export async function GET() {
  try {
    const stored = await getCorePersistenceRepositories().settings.get(KANBAN_KEY);
    const columns: PersistenceJson | KanbanColumn[] = stored ?? DEFAULT_COLUMNS;
    return NextResponse.json({ columns, isDefault: stored === null });
  } catch {
    return NextResponse.json({ columns: DEFAULT_COLUMNS, isDefault: true });
  }
}

/**
 * PUT /api/kanban-settings - Save global kanban columns
 */
export async function PUT(request: Request) {
  try {
    const body: unknown = await request.json();
    const columns = toPersistenceJson(readColumns(body));

    if (!columns || !Array.isArray(columns) || columns.length === 0) {
      return ApiErrors.badRequest('At least one column is required');
    }

    // A single atomic key upsert replaces the previous read-then-write pair.
    await getCorePersistenceRepositories().settings.set(KANBAN_KEY, columns);

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
    await getCorePersistenceRepositories().settings.delete(KANBAN_KEY);
    return NextResponse.json({ success: true, columns: DEFAULT_COLUMNS });
  } catch (error) {
    return ApiErrors.internal('Failed to reset', error);
  }
}
