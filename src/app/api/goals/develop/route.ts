import { NextResponse } from 'next/server';
import { generateText } from 'ai';
import {
  getAsyncAIModel,
  getAsyncAIProviderConfiguration,
  getAsyncAIRouteOutcome,
} from '@/lib/ai/provider-runtime';
import logger from '@/lib/logger';
import { ApiErrors } from '@/lib/api-error';
import { getGoalDevelopmentContext } from '@/lib/projects/organization-service';

/**
 * POST /api/goals/develop — AI-powered idea expansion
 * Takes a goal/idea task and generates a project proposal with phases and tasks.
 * 
 * Body: { taskId: string }
 * Returns: { proposal: { summary, suggestedTasks, suggestedProject } }
 */
export async function POST(request: Request) {
  try {
    if (!(await getAsyncAIProviderConfiguration()).configured) {
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
    const context = await getGoalDevelopmentContext(taskId, 20);
    if (!context) {
      return NextResponse.json({ error: 'Task not found' }, { status: 404 });
    }
    const {
      task,
      tags: taskTagList,
      linkedProjects,
      existingProjects,
    } = context;

    const route = await getAsyncAIModel('goal-development', {
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
      routing: getAsyncAIRouteOutcome(route, result.response),
    });
  } catch (error) {
    logger.error({ err: error }, 'Goal development failed');
    return ApiErrors.internal('Failed to develop goal', error);
  }
}
