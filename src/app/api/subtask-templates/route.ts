import { NextResponse } from 'next/server';
import db from '@/db';
import { tasks, subtaskTemplates } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { ApiErrors } from '@/lib/api-error';

/**
 * Subtask Templates API
 * 
 * Templates define reusable sets of subtasks that can be applied to any task.
 * Two tiers:
 *   1. Single — task with pre-filled subtasks (original behavior)
 *   2. Workflow — multi-task "workflow set" that stamps out a group of related tasks
 * 
 * GET — List all templates (optionally filtered by category)
 * POST — Create a template
 * PUT — Apply a template to a task (creates subtasks or workflow tasks)
 * PATCH — Update an existing template
 * DELETE — Remove a custom template
 */

/** Seed built-in templates if they don't exist yet */
async function ensureBuiltInTemplates() {
  const existing = await db.select({ id: subtaskTemplates.id }).from(subtaskTemplates).where(eq(subtaskTemplates.isBuiltIn, true));
  if (existing.length > 0) return;

  const now = '2024-01-01T00:00:00Z';
  const builtIns = [
    // ─── Development ────────────────────────────────────────────
    {
      id: 'code-review',
      name: 'Code Review',
      description: 'Standard code review checklist',
      category: 'development',
      type: 'single',
      icon: '🔍',
      subtasks: [
        { title: 'Read PR description and linked issue' },
        { title: 'Review code changes' },
        { title: 'Check for tests' },
        { title: 'Run locally if complex' },
        { title: 'Leave review comments' },
        { title: 'Approve or request changes' },
      ],
    },
    {
      id: 'bug-fix',
      name: 'Bug Fix',
      description: 'Steps to properly fix a bug',
      category: 'development',
      type: 'single',
      icon: '🐛',
      subtasks: [
        { title: 'Reproduce the bug locally', priority: 'high' },
        { title: 'Identify root cause' },
        { title: 'Write failing test', priority: 'medium' },
        { title: 'Implement fix' },
        { title: 'Verify fix passes test' },
        { title: 'Check for regressions' },
        { title: 'Submit PR' },
      ],
    },
    // ─── Productivity ───────────────────────────────────────────
    {
      id: 'meeting-prep',
      name: 'Meeting Prep',
      description: 'Prepare for an important meeting',
      category: 'productivity',
      type: 'single',
      icon: '📋',
      subtasks: [
        { title: 'Review agenda', estimatedMinutes: 5 },
        { title: 'Prepare talking points', estimatedMinutes: 15 },
        { title: 'Gather relevant docs/data', estimatedMinutes: 10 },
        { title: 'Draft questions to ask', estimatedMinutes: 5 },
      ],
    },
    {
      id: 'project-kickoff',
      name: 'Project Kickoff',
      description: 'New project setup checklist',
      category: 'productivity',
      type: 'single',
      icon: '🚀',
      subtasks: [
        { title: 'Define project scope and goals', priority: 'high' },
        { title: 'Identify stakeholders' },
        { title: 'Create initial timeline' },
        { title: 'Set up repo/workspace' },
        { title: 'Schedule kickoff meeting' },
        { title: 'Write initial README/design doc' },
      ],
    },
    {
      id: 'weekly-review',
      name: 'Weekly Review',
      description: 'GTD-style weekly review',
      category: 'productivity',
      type: 'single',
      icon: '📅',
      subtasks: [
        { title: 'Clear inbox to zero', estimatedMinutes: 15 },
        { title: 'Review calendar for next week', estimatedMinutes: 5 },
        { title: 'Review open tasks and update priorities', estimatedMinutes: 10 },
        { title: 'Review projects for stuck items', estimatedMinutes: 10 },
        { title: 'Plan top 3 priorities for next week', estimatedMinutes: 5 },
      ],
    },
    // ─── Travel ─────────────────────────────────────────────────
    {
      id: 'trip-packing',
      name: 'Trip Packing Checklist',
      description: 'Complete packing checklist for travel',
      category: 'travel',
      type: 'workflow',
      icon: '🧳',
      subtasks: [],
      workflowTasks: [
        {
          title: 'Pack essentials bag',
          priority: 'high',
          subtasks: ['Passport / ID', 'Phone + charger', 'Wallet + cards', 'Medications', 'Travel documents / boarding passes', 'Keys'],
        },
        {
          title: 'Pack clothing',
          subtasks: ['Underwear (days + 1 extra)', 'Socks (days + 1 extra)', 'Shirts / tops', 'Pants / shorts', 'Jacket / layers', 'Sleepwear', 'Shoes (walking + dressy)', 'Belt'],
        },
        {
          title: 'Pack toiletries',
          subtasks: ['Toothbrush + toothpaste', 'Deodorant', 'Shampoo / conditioner (travel size)', 'Razor', 'Sunscreen', 'Contact lenses + solution'],
        },
        {
          title: 'Electronics',
          subtasks: ['Laptop + charger', 'Headphones', 'Portable battery pack', 'Camera', 'Adapter / converter (international)'],
        },
        {
          title: 'Pre-departure tasks',
          priority: 'high',
          subtasks: ['Confirm reservations', 'Set out-of-office', 'Arrange pet / plant care', 'Lock up / set thermostat', 'Download offline maps', 'Notify bank of travel'],
        },
      ],
    },
    // ─── 3D Printing ────────────────────────────────────────────
    {
      id: '3d-print-project',
      name: '3D Print Project',
      description: 'End-to-end 3D printing workflow',
      category: '3d-printing',
      type: 'workflow',
      icon: '🖨️',
      subtasks: [],
      workflowTasks: [
        {
          title: 'Design & preparation',
          priority: 'high',
          subtasks: ['Find / design STL model', 'Check dimensions and scale', 'Choose material (PLA / PETG / ABS / TPU)', 'Slice model — set layer height, infill, supports', 'Estimate print time and filament usage'],
        },
        {
          title: 'Printer setup',
          subtasks: ['Level bed', 'Load filament', 'Clean nozzle', 'Apply bed adhesion (glue / tape / PEI)', 'Set temperatures (bed + nozzle)'],
        },
        {
          title: 'Print & monitor',
          subtasks: ['Start print', 'Monitor first layer adhesion', 'Check periodically for layer shifts or stringing', 'Note any issues for next iteration'],
        },
        {
          title: 'Post-processing',
          subtasks: ['Remove from bed', 'Remove supports', 'Sand rough spots', 'Apply filler / primer (if painting)', 'Paint / finish', 'Test fit / function'],
        },
        {
          title: 'Document & iterate',
          subtasks: ['Photo the result', 'Note print settings that worked', 'Log any design adjustments needed', 'Update model file if iterating'],
        },
      ],
    },
    // ─── Home Improvement ───────────────────────────────────────
    {
      id: 'home-reno-project',
      name: 'Home Improvement Project',
      description: 'Planning and execution checklist for home renovation',
      category: 'home',
      type: 'workflow',
      icon: '🏠',
      subtasks: [],
      workflowTasks: [
        {
          title: 'Planning & research',
          priority: 'high',
          subtasks: ['Define scope and goals', 'Research materials and methods', 'Measure space / take photos', 'Check if permits needed', 'Get 2-3 quotes (if hiring out)', 'Set budget with 15% contingency'],
        },
        {
          title: 'Materials & tools',
          subtasks: ['Create shopping list', 'Price compare (Home Depot / Lowes / online)', 'Order specialty items (allow lead time)', 'Gather tools needed', 'Rent specialty tools if needed'],
        },
        {
          title: 'Prep work',
          subtasks: ['Clear work area', 'Protect floors / furniture', 'Turn off utilities if needed', 'Demo / remove old materials', 'Clean and prep surfaces'],
        },
        {
          title: 'Execute',
          priority: 'medium',
          subtasks: ['Follow install instructions / watch tutorial', 'Work in stages — don\'t rush', 'Take progress photos', 'Test as you go'],
        },
        {
          title: 'Cleanup & finish',
          subtasks: ['Clean up debris and dust', 'Touch up paint / caulk', 'Return rental tools', 'Final inspection', 'Document for insurance / records', 'Enjoy the result 🎉'],
        },
      ],
    },
  ];

  for (const t of builtIns) {
    await db.insert(subtaskTemplates).values({
      id: t.id,
      name: t.name,
      description: t.description,
      category: t.category || null,
      type: t.type || 'single',
      icon: t.icon || null,
      subtasks: t.subtasks,
      workflowTasks: ('workflowTasks' in t) ? t.workflowTasks : null,
      isBuiltIn: true,
      createdAt: now,
      updatedAt: now,
    });
  }
}

export async function GET(request: Request) {
  await ensureBuiltInTemplates();

  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const type = searchParams.get('type');

  let query = db.select().from(subtaskTemplates);
  if (category) {
    query = query.where(eq(subtaskTemplates.category, category)) as typeof query;
  }
  if (type) {
    query = query.where(eq(subtaskTemplates.type, type)) as typeof query;
  }

  const templates = await query;
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const body = await request.json();
  const { name, description, subtasks, category, type, icon, workflowTasks } = body;

  if (!name || !subtasks || !Array.isArray(subtasks)) {
    return ApiErrors.badRequest('name and subtasks[] are required');
  }

  const now = new Date().toISOString();
  const id = `custom-${crypto.randomUUID()}`;

  await db.insert(subtaskTemplates).values({
    id,
    name,
    description: description || '',
    category: category || null,
    type: type || 'single',
    icon: icon || null,
    subtasks,
    workflowTasks: workflowTasks || null,
    isBuiltIn: false,
    createdAt: now,
    updatedAt: now,
  });

  const [template] = await db.select().from(subtaskTemplates).where(eq(subtaskTemplates.id, id));
  return NextResponse.json(template, { status: 201 });
}

/**
 * PUT — Apply a template to a parent task (creates subtasks or workflow tasks)
 */
export async function PUT(request: Request) {
  const body = await request.json();
  const { templateId, parentTaskId, connectorType: reqConnectorType, sourceListId, sourceListName, selectedIndices } = body;

  if (!templateId) {
    return ApiErrors.badRequest('templateId is required');
  }

  await ensureBuiltInTemplates();
  const [template] = await db.select().from(subtaskTemplates).where(eq(subtaskTemplates.id, templateId));
  if (!template) {
    return ApiErrors.notFound('Template');
  }

  const now = new Date().toISOString();
  const templateType = template.type || 'single';

  // Use requested connector or default to local
  const connectorType = reqConnectorType || 'local';
  const connectorInstanceId = connectorType === 'local' ? 'local' : (connectorType || 'local');
  const isLocalOnly = connectorType === 'local';

  // ─── Workflow template: stamp out multiple top-level tasks ────────────
  if (templateType === 'workflow') {
    const workflowTasks = template.workflowTasks as Array<{
      title: string;
      description?: string;
      priority?: string;
      subtasks?: string[];
      tags?: string[];
    }> | null;

    if (!workflowTasks || workflowTasks.length === 0) {
      return ApiErrors.badRequest('Workflow template has no tasks defined');
    }

    // Filter to selected indices if provided
    const tasksToCreate = Array.isArray(selectedIndices)
      ? workflowTasks.filter((_, i) => selectedIndices.includes(i))
      : workflowTasks;

    const created = [];
    for (const wt of tasksToCreate) {
      const taskId = crypto.randomUUID();
      await db.insert(tasks).values({
        id: taskId,
        sourceId: `template:${taskId}`,
        connectorType,
        connectorInstanceId,
        title: wt.title,
        description: wt.description || null,
        status: 'todo',
        priority: wt.priority || 'none',
        parentId: parentTaskId || null,
        depth: parentTaskId ? 1 : 0,
        isChecklistItem: false,
        syncStatus: isLocalOnly ? 'synced' : 'pending_push',
        createdAt: now,
        updatedAt: now,
        metadata: JSON.stringify({ fromTemplate: templateId, sourceListId: sourceListId || null, sourceListName: sourceListName || null }),
        lastSyncedAt: now,
      });

      // Create subtasks for this workflow task
      const subtaskIds = [];
      if (wt.subtasks && wt.subtasks.length > 0) {
        for (const subtaskTitle of wt.subtasks) {
          const subId = crypto.randomUUID();
          await db.insert(tasks).values({
            id: subId,
            sourceId: `template:${subId}`,
            connectorType,
            connectorInstanceId,
            title: subtaskTitle,
            status: 'todo',
            priority: 'none',
            parentId: taskId,
            depth: parentTaskId ? 2 : 1,
            isChecklistItem: true,
            syncStatus: isLocalOnly ? 'synced' : 'pending_push',
            createdAt: now,
            updatedAt: now,
            metadata: JSON.stringify({ fromTemplate: templateId }),
            lastSyncedAt: now,
          });
          subtaskIds.push({ id: subId, title: subtaskTitle });
        }
      }

      created.push({ id: taskId, title: wt.title, subtasks: subtaskIds });
    }

    return NextResponse.json({
      success: true,
      templateId,
      templateType: 'workflow',
      parentTaskId: parentTaskId || null,
      tasksCreated: created.length,
      tasks: created,
    });
  }

  // ─── Single template: create subtasks under parent ────────────────────
  if (!parentTaskId) {
    return ApiErrors.badRequest('parentTaskId is required for single templates');
  }

  const [parentTask] = await db.select().from(tasks).where(eq(tasks.id, parentTaskId));
  if (!parentTask) {
    return ApiErrors.notFound('Parent task');
  }

  const parentIsLocalOnly = parentTask.connectorType === 'local' || parentTask.sourceId.startsWith('local:');
  const created = [];
  const templateSubtasks = template.subtasks as Array<{ title: string; priority?: string; estimatedMinutes?: number }>;

  for (const subtask of templateSubtasks) {
    const id = crypto.randomUUID();
    await db.insert(tasks).values({
      id,
      sourceId: `template:${id}`,
      connectorType: parentTask.connectorType,
      connectorInstanceId: parentTask.connectorInstanceId,
      title: subtask.title,
      status: 'todo',
      priority: subtask.priority || 'none',
      parentId: parentTaskId,
      depth: (parentTask.depth || 0) + 1,
      isChecklistItem: true,
      syncStatus: parentIsLocalOnly ? 'synced' : 'pending_push',
      createdAt: now,
      updatedAt: now,
      metadata: JSON.stringify({ fromTemplate: templateId, estimatedMinutes: subtask.estimatedMinutes }),
      lastSyncedAt: now,
    });
    created.push({ id, title: subtask.title });
  }

  return NextResponse.json({
    success: true,
    templateId,
    templateType: 'single',
    parentTaskId,
    subtasksCreated: created.length,
    subtasks: created,
  });
}

/**
 * PATCH — Update an existing template
 */
export async function PATCH(request: Request) {
  const body = await request.json();
  const { id, name, description, subtasks, category, type, icon, workflowTasks } = body;

  if (!id) {
    return ApiErrors.badRequest('id is required');
  }

  const [existing] = await db.select().from(subtaskTemplates).where(eq(subtaskTemplates.id, id));
  if (!existing) {
    return ApiErrors.notFound('Template');
  }

  const updates: Record<string, unknown> = { updatedAt: new Date().toISOString() };
  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (subtasks !== undefined) updates.subtasks = subtasks;
  if (category !== undefined) updates.category = category;
  if (type !== undefined) updates.type = type;
  if (icon !== undefined) updates.icon = icon;
  if (workflowTasks !== undefined) updates.workflowTasks = workflowTasks;

  await db.update(subtaskTemplates).set(updates).where(eq(subtaskTemplates.id, id));

  const [updated] = await db.select().from(subtaskTemplates).where(eq(subtaskTemplates.id, id));
  return NextResponse.json(updated);
}

/**
 * DELETE — Remove a custom template (built-in templates cannot be deleted)
 */
export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');

  if (!id) {
    return ApiErrors.badRequest('id query parameter is required');
  }

  const [existing] = await db.select().from(subtaskTemplates).where(eq(subtaskTemplates.id, id));
  if (!existing) {
    return ApiErrors.notFound('Template');
  }

  if (existing.isBuiltIn) {
    return ApiErrors.badRequest('Cannot delete built-in templates');
  }

  await db.delete(subtaskTemplates).where(eq(subtaskTemplates.id, id));
  return NextResponse.json({ success: true });
}
