import { NextResponse } from 'next/server';
import { ApiErrors } from '@/lib/api-error';
import { getTaskCorePersistence } from '@/lib/tasks/core/runtime';
import type {
  SubtaskTemplatePatch,
  SubtaskTemplateSeed,
  TemplateSubtaskInsert,
  TemplateWorkflowTaskInsert,
} from '@/lib/tasks/core/contracts';

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

/** Reads one field off a decoded JSON body without widening it to `any`. */
function readField(body: unknown, key: string): unknown {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return Object.getOwnPropertyDescriptor(body, key)?.value;
}

const BUILT_IN_SEED_TIMESTAMP = '2024-01-01T00:00:00Z';

const BUILT_IN_TEMPLATES: readonly SubtaskTemplateSeed[] = [
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
    workflowTasks: null,
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
    workflowTasks: null,
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
    workflowTasks: null,
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
    workflowTasks: null,
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
    workflowTasks: null,
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

/** Seed built-in templates if they don't exist yet */
async function ensureBuiltInTemplates(): Promise<void> {
  const persistence = await getTaskCorePersistence();
  await persistence.organization.ensureBuiltInSubtaskTemplates(
    BUILT_IN_TEMPLATES,
    BUILT_IN_SEED_TIMESTAMP,
  );
}

export async function GET(request: Request) {
  await ensureBuiltInTemplates();

  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const type = searchParams.get('type');

  const persistence = await getTaskCorePersistence();
  const templates = await persistence.organization.listSubtaskTemplates({
    category: category || null,
    type: type || null,
  });
  return NextResponse.json({ templates });
}

export async function POST(request: Request) {
  const body: unknown = await request.json();
  const name = readField(body, 'name');
  const description = readField(body, 'description');
  const subtasks = readField(body, 'subtasks');
  const category = readField(body, 'category');
  const type = readField(body, 'type');
  const icon = readField(body, 'icon');
  const workflowTasks = readField(body, 'workflowTasks');

  if (typeof name !== 'string' || !name || !subtasks || !Array.isArray(subtasks)) {
    return ApiErrors.badRequest('name and subtasks[] are required');
  }

  const now = new Date().toISOString();
  const id = `custom-${crypto.randomUUID()}`;

  const persistence = await getTaskCorePersistence();
  const template = await persistence.organization.createSubtaskTemplate({
    id,
    now,
    template: {
      name,
      description: typeof description === 'string' ? description : '',
      category: typeof category === 'string' && category ? category : null,
      type: typeof type === 'string' && type ? type : 'single',
      icon: typeof icon === 'string' && icon ? icon : null,
      subtasks,
      workflowTasks: workflowTasks ? workflowTasks : null,
    },
  });
  return NextResponse.json(template, { status: 201 });
}

/**
 * PUT — Apply a template to a parent task (creates subtasks or workflow tasks)
 */
export async function PUT(request: Request) {
  const body: unknown = await request.json();
  const rawTemplateId = readField(body, 'templateId');
  const rawParentTaskId = readField(body, 'parentTaskId');
  const reqConnectorType = readField(body, 'connectorType');
  const rawSourceListId = readField(body, 'sourceListId');
  const rawSourceListName = readField(body, 'sourceListName');
  const rawSelectedIndices = readField(body, 'selectedIndices');

  if (typeof rawTemplateId !== 'string' || !rawTemplateId) {
    return ApiErrors.badRequest('templateId is required');
  }
  const templateId = rawTemplateId;
  const parentTaskId = typeof rawParentTaskId === 'string' && rawParentTaskId
    ? rawParentTaskId
    : null;

  await ensureBuiltInTemplates();
  const persistence = await getTaskCorePersistence();
  const template = await persistence.organization.getSubtaskTemplateApplicationPlan(templateId);
  if (!template) {
    return ApiErrors.notFound('Template');
  }

  const now = new Date().toISOString();
  const templateType = template.type || 'single';

  // Use requested connector or default to local
  const connectorType = typeof reqConnectorType === 'string' && reqConnectorType
    ? reqConnectorType
    : 'local';
  const connectorInstanceId = connectorType === 'local' ? 'local' : connectorType;
  const isLocalOnly = connectorType === 'local';

  // ─── Workflow template: stamp out multiple top-level tasks ────────────
  if (templateType === 'workflow') {
    const workflowTasks = template.workflowTasks;

    if (workflowTasks.length === 0) {
      return ApiErrors.badRequest('Workflow template has no tasks defined');
    }

    // Filter to selected indices if provided
    const selection: readonly unknown[] | null = Array.isArray(rawSelectedIndices)
      ? rawSelectedIndices
      : null;
    const tasksToCreate = selection
      ? workflowTasks.filter((_, i) => selection.includes(i))
      : workflowTasks;

    const created: TemplateWorkflowTaskInsert[] = tasksToCreate.map((wt) => ({
      id: crypto.randomUUID(),
      title: wt.title,
      description: wt.description,
      priority: wt.priority || 'none',
      subtasks: wt.subtasks.map((subtaskTitle) => ({
        id: crypto.randomUUID(),
        title: subtaskTitle,
      })),
    }));

    await persistence.organization.applyWorkflowTemplate({
      templateId,
      parentTaskId,
      connectorType,
      connectorInstanceId,
      isLocalOnly,
      sourceListId: typeof rawSourceListId === 'string' && rawSourceListId ? rawSourceListId : null,
      sourceListName: typeof rawSourceListName === 'string' && rawSourceListName
        ? rawSourceListName
        : null,
      now,
      tasks: created,
    });

    return NextResponse.json({
      success: true,
      templateId,
      templateType: 'workflow',
      parentTaskId,
      tasksCreated: created.length,
      tasks: created.map((task) => ({
        id: task.id,
        title: task.title,
        subtasks: task.subtasks,
      })),
    });
  }

  // ─── Single template: create subtasks under parent ────────────────────
  if (!parentTaskId) {
    return ApiErrors.badRequest('parentTaskId is required for single templates');
  }

  const created: TemplateSubtaskInsert[] = template.subtasks.map((subtask) => ({
    id: crypto.randomUUID(),
    title: subtask.title,
    priority: subtask.priority || 'none',
    estimatedMinutes: subtask.estimatedMinutes,
  }));

  const outcome = await persistence.organization.applySingleTemplate({
    templateId,
    parentTaskId,
    now,
    subtasks: created,
  });
  if (outcome.kind === 'missing-parent') {
    return ApiErrors.notFound('Parent task');
  }

  return NextResponse.json({
    success: true,
    templateId,
    templateType: 'single',
    parentTaskId,
    subtasksCreated: created.length,
    subtasks: created.map((subtask) => ({ id: subtask.id, title: subtask.title })),
  });
}

/**
 * PATCH — Update an existing template
 */
export async function PATCH(request: Request) {
  const body: unknown = await request.json();
  const rawId = readField(body, 'id');

  if (typeof rawId !== 'string' || !rawId) {
    return ApiErrors.badRequest('id is required');
  }
  const id = rawId;

  const persistence = await getTaskCorePersistence();
  const existing = await persistence.organization.getSubtaskTemplate(id);
  if (!existing) {
    return ApiErrors.notFound('Template');
  }

  const patch: {
    name?: string;
    description?: string;
    category?: string | null;
    type?: string;
    icon?: string | null;
    subtasks?: unknown;
    workflowTasks?: unknown;
  } = {};

  const name = readField(body, 'name');
  if (name !== undefined) {
    if (typeof name !== 'string') return ApiErrors.badRequest('name must be a string');
    patch.name = name;
  }
  const description = readField(body, 'description');
  if (description !== undefined) {
    if (typeof description !== 'string') {
      return ApiErrors.badRequest('description must be a string');
    }
    patch.description = description;
  }
  const subtasks = readField(body, 'subtasks');
  if (subtasks !== undefined) {
    if (!Array.isArray(subtasks)) return ApiErrors.badRequest('subtasks must be an array');
    patch.subtasks = subtasks;
  }
  const category = readField(body, 'category');
  if (category !== undefined) {
    if (category !== null && typeof category !== 'string') {
      return ApiErrors.badRequest('category must be a string or null');
    }
    patch.category = category;
  }
  const type = readField(body, 'type');
  if (type !== undefined) {
    if (typeof type !== 'string') return ApiErrors.badRequest('type must be a string');
    patch.type = type;
  }
  const icon = readField(body, 'icon');
  if (icon !== undefined) {
    if (icon !== null && typeof icon !== 'string') {
      return ApiErrors.badRequest('icon must be a string or null');
    }
    patch.icon = icon;
  }
  const workflowTasks = readField(body, 'workflowTasks');
  if (workflowTasks !== undefined) {
    if (workflowTasks !== null && !Array.isArray(workflowTasks)) {
      return ApiErrors.badRequest('workflowTasks must be an array or null');
    }
    patch.workflowTasks = workflowTasks;
  }

  const patchInput: SubtaskTemplatePatch = patch;
  const updated = await persistence.organization.updateSubtaskTemplate({
    id,
    patch: patchInput,
    now: new Date().toISOString(),
  });
  if (!updated) {
    return ApiErrors.notFound('Template');
  }
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

  const persistence = await getTaskCorePersistence();
  const outcome = await persistence.organization.deleteSubtaskTemplate(id);
  if (outcome.kind === 'missing') {
    return ApiErrors.notFound('Template');
  }
  if (outcome.kind === 'built-in') {
    return ApiErrors.badRequest('Cannot delete built-in templates');
  }

  return NextResponse.json({ success: true });
}
