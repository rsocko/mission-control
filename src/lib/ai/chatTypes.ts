import type { UIMessage } from 'ai';

export interface HubProject {
  id: string;
  name: string;
  icon: string | null;
  color?: string;
}

export interface ProviderInfo {
  provider: string;
  model: string;
  baseUrl: string;
  configured: boolean;
}

export type ChatMessage = UIMessage & {
  createdAt?: string;
};
export type ChatPart = ChatMessage['parts'][number];
export type ToolPart = Extract<ChatPart, { type: `tool-${string}` } | { type: 'dynamic-tool' }>;
export type AITab = 'chat' | 'agents' | 'insights';

export type SidebarResult = {
  title: string;
  content: string;
  loading: boolean;
};
