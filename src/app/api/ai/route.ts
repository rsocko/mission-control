import { getAIRouteOutcome, getResolvedAIConfig, streamChat } from '@/lib/ai';
import { aiLogger } from '@/lib/logger';
import { getLocalToday } from '@/lib/utils/date';
import { startRuntimeOperation } from '@/lib/runtime/lifecycle';
import {
  applyAIContextCharacterBudget,
  loadAIContextSnapshot,
} from '@/lib/ai/context-budget';
import {
  acquireOllamaAdmissionWithTimeout,
  getAIOverloadDetails,
  type AIAdmission,
} from '@/lib/ai/admission-controller';

/**
 * POST /api/ai — Chat with the AI assistant
 * Streams responses back using the Vercel AI SDK UI message stream format.
 * Injects current task/triage context for context-aware responses.
 */
export async function POST(request: Request) {
  const runtimeOperation = startRuntimeOperation('ai');
  if (!runtimeOperation.accepted) {
    return Response.json(
      { error: 'Service is draining' },
      { status: 503, headers: { 'Retry-After': '30' } },
    );
  }
  let chatAdmission: AIAdmission | null = null;
  let operationFinished = false;
  const finishOperation = () => {
    if (operationFinished) return;
    operationFinished = true;
    chatAdmission?.release();
    runtimeOperation.finish();
  };

  try {
    const { messages } = await request.json();

    if (!messages || !Array.isArray(messages)) {
      finishOperation();
      return new Response(JSON.stringify({ error: 'messages array is required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Check if any AI provider is configured
    const resolvedConfig = getResolvedAIConfig();
    if (!resolvedConfig.configured) {
      finishOperation();
      return new Response(JSON.stringify({
        error: 'AI provider not configured. Add settings in /settings or set AI_PROVIDER + AI_BASE_URL / OPENAI_API_KEY in .env.local',
        fallback: true,
      }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Build context prefix from current task/triage state
    const aiContext = await buildContextPrefix();
    const operationSignal = AbortSignal.any([request.signal, runtimeOperation.signal]);
    if (resolvedConfig.provider === 'ollama') {
      chatAdmission = await acquireOllamaAdmissionWithTimeout(operationSignal);
    }

    const { result, context } = await streamChat(normalizeMessages(messages), {
      contextPrefix: aiContext.contextPrefix,
      sources: aiContext.sources,
      abortSignal: operationSignal,
      admission: chatAdmission ?? undefined,
      onFinish: finishOperation,
      onAbort: finishOperation,
      onError: finishOperation,
    });
    return result.toUIMessageStreamResponse({
      headers: {
        'x-mc-ai-feature-id': context.featureId,
        'x-mc-ai-sensitivity': context.sensitivity,
        'x-mc-ai-allowed-routes': context.allowedRoutes.join(','),
        'x-mc-correlation-id': context.correlationId,
      },
      messageMetadata: ({ part }) => part.type === 'finish-step'
        ? { routing: getAIRouteOutcome(context, part.response) }
        : undefined,
    });
  } catch (error) {
    finishOperation();
    const overload = getAIOverloadDetails(error);
    if (overload) {
      aiLogger.warn({ code: overload.code }, 'AI chat capacity exhausted');
      return Response.json(
        { error: overload.message, code: overload.code },
        {
          status: overload.status,
          headers: { 'Retry-After': String(overload.retryAfter) },
        },
      );
    }
    aiLogger.error({ err: error }, 'AI chat request failed');
    return new Response(JSON.stringify({ error: 'AI request failed. Please try again.' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function buildContextPrefix(): Promise<{ contextPrefix?: string; sources: string[] }> {
  const snapshot = await loadAIContextSnapshot(getLocalToday());
  const sections: string[] = [];

  if (snapshot.counts.overdue > 0) {
    sections.push(`Overdue (${snapshot.counts.overdue}): ${snapshot.overdue.map(t => `"${t.title}" (${t.priority}, due ${t.dueDate})`).join('; ')}`);
  }
  if (snapshot.counts.dueToday > 0) {
    sections.push(`Due today (${snapshot.counts.dueToday}): ${snapshot.dueToday.map(t => `"${t.title}" (${t.priority})`).join('; ')}`);
  }
  if (snapshot.counts.inProgress > 0) {
    sections.push(`In progress (${snapshot.counts.inProgress}): ${snapshot.inProgress.map(t => `"${t.title}"`).join(', ')}`);
  }
  if (snapshot.counts.unreadNotifications > 0) {
    sections.push(`Unread notifications: ${snapshot.counts.unreadNotifications} (${snapshot.counts.urgentNotifications} critical/urgent)`);
  }

  aiLogger.info({
    event: 'ai_context_rows',
    featureId: 'houston-chat',
    contextRows: snapshot.rowCount,
  }, 'Selected bounded AI context rows');
  if (sections.length === 0) return { sources: snapshot.sources };
  return {
    contextPrefix: applyAIContextCharacterBudget(
      `[CURRENT USER STATE]\n${sections.join('\n')}\n\nReference specific tasks by name when relevant to the user's question.`,
      'houston-chat',
    ),
    sources: snapshot.sources,
  };
}

function normalizeMessages(messages: unknown[]): Array<{ role: 'user' | 'assistant'; content: string }> {
  return messages.flatMap(message => {
    if (!message || typeof message !== 'object') return [];

    const role = (message as { role?: string }).role === 'assistant' ? 'assistant' : 'user';

    if (typeof (message as { content?: unknown }).content === 'string') {
      return [{ role, content: (message as { content: string }).content }];
    }

    const parts = Array.isArray((message as { parts?: unknown[] }).parts)
      ? (message as { parts: unknown[] }).parts
      : [];

    const content = parts
      .map(part => normalizePart(part))
      .filter(Boolean)
      .join('\n\n')
      .trim();

    return content ? [{ role, content }] : [];
  });
}

function normalizePart(part: unknown): string {
  if (!part || typeof part !== 'object') return '';

  if ((part as { type?: string }).type === 'text' && typeof (part as { text?: unknown }).text === 'string') {
    return (part as { text: string }).text;
  }

  const type = (part as { type?: string }).type;
  if (!type || (!type.startsWith('tool-') && type !== 'dynamic-tool')) {
    return '';
  }

  const toolName = type === 'dynamic-tool'
    ? String((part as { toolName?: unknown }).toolName || 'tool')
    : type.replace('tool-', '');

  const input = (part as { input?: unknown }).input;
  const output = (part as { output?: unknown }).output;
  const errorText = (part as { errorText?: unknown }).errorText;

  const lines = [`[Tool ${toolName}]`];
  if (input !== undefined) lines.push(`Input: ${safeStringify(input)}`);
  if (output !== undefined) lines.push(`Result: ${safeStringify(output)}`);
  if (typeof errorText === 'string' && errorText) lines.push(`Error: ${errorText}`);
  return lines.join('\n');
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
