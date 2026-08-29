import { randomUUID } from 'node:crypto';
import { getAIRouteOutcome } from '@/lib/ai/provider-factory';
import { getResolvedAIConfig } from '@/lib/ai/config-resolver';
import { streamChat } from '@/lib/ai/features/chat';
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
import {
  convertToModelMessages,
  getToolName,
  isToolUIPart,
  safeValidateUIMessages,
  type InferUITools,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { createHoustonTools } from '@/lib/ai/tools';
import {
  consumeHoustonFinanceApproval,
  FINANCE_MUTATION_TOOL_NAMES,
  InvalidHoustonFinanceApprovalError,
  persistHoustonFinanceApproval,
  type FinanceMutationToolName,
} from '@/lib/ai/finance-approval-store';
import {
  recordHoustonFinanceApprovalAudit,
} from '@/lib/finance/houston-tools';
import {
  assignFinanceTransactionKidInputSchema,
  updateFinanceTransactionCategoryInputSchema,
} from '@/lib/finance/houston-contracts';

const FINANCE_MUTATION_TOOLS = new Set<string>(FINANCE_MUTATION_TOOL_NAMES);
type HoustonTools = ReturnType<typeof createHoustonTools>;
type HoustonUIMessage = UIMessage<unknown, never, InferUITools<HoustonTools>>;

export class InvalidAIChatMessagesError extends Error {
  constructor() {
    super('The chat message history is invalid.');
    this.name = 'InvalidAIChatMessagesError';
  }
}

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
  const requestCorrelationId = randomUUID();
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

    const normalized = await normalizeMessages(messages);
    for (const denied of normalized.financeApprovals.filter(item => !item.approved)) {
      recordHoustonFinanceApprovalAudit({
        approvalId: denied.approvalId,
        correlationId: requestCorrelationId,
        toolName: denied.toolName,
        decision: 'deny',
        outcome: 'denied',
        durationMs: 0,
      });
    }
    const { result, context } = await streamChat(normalized.modelMessages, {
      contextPrefix: aiContext.contextPrefix,
      sources: aiContext.sources,
      abortSignal: operationSignal,
      admission: chatAdmission ?? undefined,
      onFinish: finishOperation,
      onAbort: finishOperation,
      onError: () => {
        finishOperation();
      },
      financeMutationsAllowed: normalized.financeApprovals.length === 0,
      financeApprovalIds: normalized.financeApprovalIds,
      correlationId: requestCorrelationId,
      onStepFinish: ({ content }) => {
        for (const part of content) {
          if (
            part.type !== 'tool-approval-request'
            || !isFinanceMutationToolName(part.toolCall.toolName)
          ) {
            continue;
          }
          persistHoustonFinanceApproval({
            approvalId: part.approvalId,
            toolCallId: part.toolCall.toolCallId,
            toolName: part.toolCall.toolName,
            toolInput: part.toolCall.input,
            correlationId: requestCorrelationId,
          });
        }
      },
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
    if (error instanceof InvalidHoustonFinanceApprovalError) {
      if (error.toolName && error.decision) {
        recordHoustonFinanceApprovalAudit({
          approvalId: error.approvalId,
          correlationId: requestCorrelationId,
          toolName: error.toolName,
          decision: error.decision,
          outcome: 'invalid-approval',
          durationMs: 0,
        });
      }
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidAIChatMessagesError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
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

function isFinanceMutationToolName(value: string): value is FinanceMutationToolName {
  return FINANCE_MUTATION_TOOLS.has(value);
}

export async function normalizeMessages(messages: unknown): Promise<{
  uiMessages: HoustonUIMessage[];
  modelMessages: ModelMessage[];
  financeApprovals: Array<{
    approvalId: string;
    toolName: FinanceMutationToolName;
    toolCallId: string;
    toolInput: unknown;
    approved: boolean;
  }>;
  financeApprovalIds: Record<string, string>;
}> {
  const tools = createHoustonTools();
  const validated = await safeValidateUIMessages<HoustonUIMessage>({ messages, tools });
  if (!validated.success || validated.data.some(message =>
    message.role !== 'user'
    && message.role !== 'assistant'
    || message.parts.some(part => part.type === 'dynamic-tool')
  )) {
    throw new InvalidAIChatMessagesError();
  }
  const financeApprovals = consumeFinanceApprovalParts(validated.data);
  return {
    uiMessages: validated.data,
    modelMessages: await convertToModelMessages(validated.data, { tools }),
    financeApprovals,
    financeApprovalIds: Object.fromEntries(
      financeApprovals.map(item => [item.toolCallId, item.approvalId]),
    ),
  };
}

function consumeFinanceApprovalParts(
  messages: HoustonUIMessage[],
): Array<{
  approvalId: string;
  toolName: FinanceMutationToolName;
  toolCallId: string;
  toolInput: unknown;
  approved: boolean;
}> {
  const approvals: Array<{
    approvalId: string;
    toolName: FinanceMutationToolName;
    toolCallId: string;
    toolInput: unknown;
    approved: boolean;
  }> = [];
  const latestMessage = messages.at(-1);
  if (!latestMessage) return approvals;
  for (const part of latestMessage.parts) {
    if (
      isToolUIPart(part)
      && part.state === 'approval-responded'
    ) {
      const toolName = getToolName(part);
      if (isFinanceMutationToolName(toolName)) {
        const parsed = toolName === 'assignFinanceTransactionKid'
          ? assignFinanceTransactionKidInputSchema.safeParse(part.input)
          : updateFinanceTransactionCategoryInputSchema.safeParse(part.input);
        if (!parsed.success) throw new InvalidAIChatMessagesError();
        let consumed: ReturnType<typeof consumeHoustonFinanceApproval>;
        try {
          consumed = consumeHoustonFinanceApproval({
            approvalId: part.approval.id,
            toolName,
            toolCallId: part.toolCallId,
            toolInput: parsed.data,
          });
        } catch (error) {
          if (error instanceof InvalidHoustonFinanceApprovalError) {
            throw new InvalidHoustonFinanceApprovalError(
              part.approval.id,
              toolName,
              part.approval.approved ? 'approve' : 'deny',
            );
          }
          throw error;
        }
        part.input = consumed.toolInput;
        approvals.push({
          ...consumed,
          approved: part.approval.approved,
        });
      }
    }
  }
  return approvals;
}
