import type { ChatMessage, ChatPart, ToolPart } from '@/lib/ai/chatTypes';

export type { AITab, ChatMessage, ChatPart, HubProject, ProviderInfo, SidebarResult, ToolPart } from '@/lib/ai/chatTypes';

let chatMessageCache: ChatMessage[] = [];
let chatConversationId = crypto.randomUUID();
let chatTaskCounter = 0;

export function getCachedChatMessages() {
  return chatMessageCache;
}

export function setCachedChatMessages(messages: ChatMessage[]) {
  chatMessageCache = messages;
}

export function getCachedChatConversationId(): string {
  return chatConversationId;
}

export function setCachedChatConversationId(id: string): void {
  chatConversationId = id;
}

export function getChatTaskId(): string {
  return `chat-${++chatTaskCounter}`;
}

export function shouldHidePart(part: ChatPart) {
  return part.type === 'step-start' || part.type === 'reasoning' || (isTextLikePart(part) && !part.text.trim());
}

export function isTextLikePart(part: ChatPart): part is Extract<ChatPart, { type: 'text' }> {
  return part.type === 'text';
}

export function isToolPart(part: ChatPart): part is ToolPart {
  return part.type === 'dynamic-tool' || part.type.startsWith('tool-');
}

export function getToolName(part: ToolPart) {
  return part.type === 'dynamic-tool' ? part.toolName : part.type.replace('tool-', '');
}

export function createUserMessage(content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    parts: [{ type: 'text', text: content }],
    createdAt: new Date().toISOString(),
  };
}

export function createAssistantMessage(): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [],
    createdAt: new Date().toISOString(),
  };
}

export function createAssistantTextMessage(content: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    role: 'assistant',
    parts: [{ type: 'text', text: content }],
    createdAt: new Date().toISOString(),
  };
}
