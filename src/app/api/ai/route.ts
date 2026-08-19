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
  InvalidToolApprovalSignatureError,
  isToolUIPart,
  safeValidateUIMessages,
  type InferUITools,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { createHoustonTools } from '@/lib/ai/tools';
import {
  getHoustonToolApprovalSecret,
  HoustonToolApprovalConfigurationError,
  verifyHoustonToolApprovalSignature,
} from '@/lib/ai/tool-approval-config';
import {
  recordHoustonFinanceApprovalAudit,
} from '@/lib/finance/houston-tools';
import {
  assignFinanceTransactionKidInputSchema,
  updateFinanceTransactionCategoryInputSchema,
} from '@/lib/finance/houston-contracts';

const FINANCE_MUTATION_TOOLS = new Set([
  'assignFinanceTransactionKid',
  'updateFinanceTransactionCategory',
]);
type HoustonTools = ReturnType<typeof createHoustonTools>;
type HoustonUIMessage = UIMessage<unknown, never, InferUITools<HoustonTools>>;

export class InvalidAIChatMessagesError extends Error {
  constructor() {
    super('The chat message history is invalid.');
    this.name = 'InvalidAIChatMessagesError';
  }
}

class InvalidFinanceApprovalError extends InvalidAIChatMessagesError {
  constructor(
    readonly toolName: string,
    readonly toolCallId: string,
    readonly decision: 'approve' | 'deny',
    readonly toolInput: unknown,
  ) {
    super();
    this.name = 'InvalidFinanceApprovalError';
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
    const approvalSecret = getHoustonToolApprovalSecret();
    const deniedCalls = financeApprovalParts(normalized.uiMessages, false);
    const approvedCalls = financeApprovalParts(normalized.uiMessages, true);
    const recordDeniedApprovals = () => {
      for (const denied of deniedCalls) {
        recordHoustonFinanceApprovalAudit({
          correlationId: requestCorrelationId,
          toolName: denied.toolName,
          toolCallId: denied.toolCallId,
          decision: 'deny',
          outcome: 'denied',
          durationMs: 0,
          approvalSecret,
          toolInput: denied.toolInput,
        });
      }
    };
    recordDeniedApprovals();
    const { result, context } = await streamChat(normalized.modelMessages, {
      contextPrefix: aiContext.contextPrefix,
      sources: aiContext.sources,
      abortSignal: operationSignal,
      admission: chatAdmission ?? undefined,
      onFinish: finishOperation,
      onAbort: finishOperation,
      onError: (error) => {
        if (InvalidToolApprovalSignatureError.isInstance(error)) {
          for (const responded of approvedCalls) {
            recordHoustonFinanceApprovalAudit({
              correlationId: requestCorrelationId,
              toolName: responded.toolName,
              toolCallId: responded.toolCallId,
              decision: 'approve',
              outcome: 'invalid-approval',
              durationMs: 0,
              approvalSecret,
              toolInput: responded.toolInput,
            });
          }
        }
        finishOperation();
      },
      financeMutationsAllowed: deniedCalls.length === 0 && approvedCalls.length === 0,
      correlationId: requestCorrelationId,
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
    if (error instanceof InvalidFinanceApprovalError) {
      recordHoustonFinanceApprovalAudit({
        correlationId: requestCorrelationId,
        toolName: error.toolName,
        toolCallId: error.toolCallId,
        decision: error.decision,
        outcome: 'invalid-approval',
        durationMs: 0,
        approvalSecret: getHoustonToolApprovalSecret(),
        toolInput: error.toolInput,
      });
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof InvalidAIChatMessagesError) {
      return Response.json({ error: error.message }, { status: 400 });
    }
    if (error instanceof HoustonToolApprovalConfigurationError) {
      return Response.json({ error: error.message }, { status: 503 });
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

export async function normalizeMessages(messages: unknown): Promise<{
  uiMessages: HoustonUIMessage[];
  modelMessages: ModelMessage[];
}> {
  const approvalSecret = getHoustonToolApprovalSecret();
  const tools = createHoustonTools(approvalSecret);
  const validated = await safeValidateUIMessages<HoustonUIMessage>({ messages, tools });
  if (!validated.success || validated.data.some(message =>
    message.role !== 'user'
    && message.role !== 'assistant'
    || message.parts.some(part => part.type === 'dynamic-tool')
  )) {
    throw new InvalidAIChatMessagesError();
  }
  validateFinanceApprovalParts(validated.data, approvalSecret);
  return {
    uiMessages: validated.data,
    modelMessages: await convertToModelMessages(validated.data, { tools }),
  };
}

function validateFinanceApprovalParts(
  messages: HoustonUIMessage[],
  approvalSecret: string,
): void {
  for (const message of messages) {
    for (const part of message.parts) {
      if (!isToolUIPart(part)) continue;
      const toolName = getToolName(part);
      if (!FINANCE_MUTATION_TOOLS.has(toolName)) continue;
      const parsed = toolName === 'assignFinanceTransactionKid'
        ? assignFinanceTransactionKidInputSchema.safeParse(part.input)
        : updateFinanceTransactionCategoryInputSchema.safeParse(part.input);
      const approval = 'approval' in part ? part.approval : undefined;
      if (!parsed.success || !approval) throw new InvalidAIChatMessagesError();
      const decision = 'approved' in approval && approval.approved === false
        ? 'deny'
        : 'approve';
      if (
        typeof approval.signature !== 'string'
        || !verifyHoustonToolApprovalSignature({
          secret: approvalSecret,
          signature: approval.signature,
          approvalId: approval.id,
          toolCallId: part.toolCallId,
          toolName,
          toolInput: parsed.data,
        })
      ) {
        throw new InvalidFinanceApprovalError(
          toolName,
          part.toolCallId,
          decision,
          parsed.data,
        );
      }
    }
  }
}

function financeApprovalParts(
  messages: HoustonUIMessage[],
  approved: boolean,
): Array<{ toolName: string; toolCallId: string; toolInput: unknown }> {
  const calls: Array<{
    toolName: string;
    toolCallId: string;
    toolInput: unknown;
  }> = [];
  const latestMessage = messages.at(-1);
  if (!latestMessage) return calls;
  for (const part of latestMessage.parts) {
    if (
      isToolUIPart(part)
      && part.state === 'approval-responded'
      && part.approval.approved === approved
    ) {
      const toolName = getToolName(part);
      if (FINANCE_MUTATION_TOOLS.has(toolName)) {
        calls.push({
          toolName,
          toolCallId: part.toolCallId,
          toolInput: part.input,
        });
      }
    }
  }
  return calls;
}
