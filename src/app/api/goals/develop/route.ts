import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import { getAIModel, getAIRouteOutcome } from '@/lib/ai/provider-factory';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import db from '@/db';
import { tasks, tags, taskTags, hubProjects, taskProjects } from '@/db/schema';
import { eq, inArray } from 'drizzle-orm';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';

/**
 * POST /api/goals/develop — AI-powered idea expansion
 * Takes a goal/idea task and generates a project proposal with phases and tasks.
 * 
 * Body: { taskId: string }
 * Returns: { proposal: { summary, suggestedTasks, suggestedProject } }
 */
export async function POST(request: Request) {
  try {
    if (!getResolvedAIConfig().configured) {
      return NextResponse.json(
        { error: 'AI provider not configured. Add settings in /settings or set AI_PROVIDER + API key in .env.local' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { taskId } = body;

    if (!taskId) {
      return NextResponse.json({ error: 'taskId is required' }, { status: 400 });
    }

    // Fetch the task
    const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId)).limit(1);
    if (!task) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }

    // Fetch task's tags
    const taskTagList = await db.select({
      name: tags.name,
      slug: tags.slug,
    })
      .from(taskTags)
      .innerJoin(tags, eq(taskTags.tagId, tags.id))
      .where(eq(taskTags.taskId, taskId));

    // Fetch linked projects for context
    const linkedProjects = await db.select({
      name: hubProjects.name,
      description: hubProjects.description,
      category: hubProjects.category,
    })
      .from(taskProjects)
      .innerJoin(hubProjects, eq(taskProjects.projectId, hubProjects.id))
      .where(eq(taskProjects.taskId, taskId));

    // Get existing projects for context
    const existingProjects = await db.select({
      name: hubProjects.name,
      category: hubProjects.category,
    }).from(hubProjects).limit(20);

    const route = getAIModel('goal-development', {
      sources: [task.connectorType],
    });

    const prompt = `You are a project planning assistant. A user has a goal/idea they want to develop into a concrete project plan.

GOAL/IDEA:
Title: "${task.title}"
Description: "${task.description || 'No description provided'}"
Tags: ${taskTagList.map(t => `#${t.slug}`).join(', ') || 'none'}
${linkedProjects.length > 0 ? `Linked projects: ${linkedProjects.map(p => p.name).join(', ')}` : ''}

EXISTING PROJECTS (for context):
${existingProjects.map(p => `- ${p.name} (${p.category || 'uncategorized'})`).join('\n')}

Generate a structured project proposal. Respond in JSON with this exact format:
{
  "summary": "A 1-2 sentence analysis of the goal and what it needs",
  "suggestedTasks": [
    {
      "title": "Task title",
      "description": "Brief description of what this task involves",
      "effort": "~Xd effort",
      "category": "research|implementation|infrastructure|testing"
    }
  ],
  "suggestedProject": {
    "name": "Proposed project name",
    "description": "What this project achieves",
    "category": "Category for the project",
    "phases": [
      {
        "name": "Phase name",
        "description": "What this phase covers",
        "taskIndices": [0, 1]
      }
    ],
    "estimatedEffortDays": 10
  }
}

Generate 3-6 concrete, actionable tasks and organize them into 2-3 phases. Be specific to the goal — not generic project management advice.`;

    const result = await generateText({
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
    });

    // Parse the AI response
    let proposal;
    try {
      // Extract JSON from the response (handle markdown code blocks)
      const jsonMatch = result.text.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, result.text];
      const jsonStr = jsonMatch[1]?.trim() || result.text.trim();
      proposal = JSON.parse(jsonStr);
    } catch {
      // If JSON parsing fails, return the raw text as summary
      proposal = {
        summary: result.text,
        suggestedTasks: [],
        suggestedProject: null,
      };
    }

    return NextResponse.json({
      proposal,
      routing: getAIRouteOutcome(route.context, result.response),
    });
  } catch (error) {
    logger.error({ err: error }, 'Goal development failed');
    return ApiErrors.internal('Failed to develop goal', error);
  }
}
