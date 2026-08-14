'use client';

import { useCallback, useEffect, useRef, useState, type KeyboardEventHandler } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { parseJsonEventStream, type ParseResult } from '@ai-sdk/provider-utils';
import { readUIMessageStream, uiMessageChunkSchema, type UIMessageChunk } from 'ai';
import { AIChatTab } from '@/components/ai/AIChatTab';
import { AIInsightsPanel } from '@/components/ai/AIInsightsPanel';
import { HoustonHomeScreen } from '@/components/houston';
import { MobileChatView } from '@/components/houston/MobileChatView';
import { HoustonContextProvider } from '@/components/houston/ContextProvider';
import { useIsMobile } from '@/lib/hooks/useIsMobile';
import { getLocalFallback, readJsonSafely } from '@/lib/ai/chatFormatters';
import {
  createAssistantMessage,
  createAssistantTextMessage,
  createUserMessage,
  getCachedChatMessages,
  getChatTaskId,
  setCachedChatMessages,
  type AITab,
  type ChatMessage,
  type HubProject,
  type ProviderInfo,
  type SidebarResult,
} from '@/lib/ai/chatMessageFactory';
import { getBackgroundAiTask, submitBackgroundAiTask } from '@/lib/ai/backgroundAiTaskManager';
import { useBackgroundAiTasks } from '@/lib/ai/useBackgroundAiTasks';
import { uiLogger } from '@/lib/client-logger';
import type { ToolApprovalHandler } from '@/components/ai/ToolCard';
import { getToolName, type ToolPart } from '@/lib/ai/chatMessageFactory';

const tabs: ReadonlyArray<{ id: AITab; label: string }> = [
  { id: 'chat', label: 'Chat' },
  { id: 'agents', label: 'Agents' },
  { id: 'insights', label: 'Insights' },
];

export default function AIPage() {
  const isMobile = useIsMobile();
  const [activeTab, setActiveTab] = useState<AITab>('chat');
  const [messages, setMessages] = useState<ChatMessage[]>(getCachedChatMessages);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const [sidebarResult, setSidebarResult] = useState<SidebarResult | null>(null);
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const { isAiActive } = useBackgroundAiTasks();

  useEffect(() => setCachedChatMessages(messages), [messages]);
  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [messages]);
  useEffect(() => {
    fetch('/api/hub-projects').then(response => response.json()).then(data => setProjects(data.projects || []));
    fetch('/api/ai/provider').then(response => response.json()).then(setProviderInfo).catch(err => { uiLogger.error('Failed to fetch AI provider info', { err }); });
  }, []);

  const submitChat = useCallback((
    nextMessages: ChatMessage[],
    label: string,
    fallbackPrompt?: string,
  ) => {
    const assistantMessage = createAssistantMessage();
    const taskId = getChatTaskId();
    setMessages(nextMessages);
    setLoading(true);

    submitBackgroundAiTask<ChatMessage[]>({
      id: taskId,
      category: 'chat',
      label: label.length > 60 ? `${label.slice(0, 57)}…` : label,
      execute: async signal => {
        const response = await fetch('/api/ai', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: nextMessages }), signal });
        if (!response.ok) {
          const error = await readJsonSafely(response);
          if (error?.fallback && fallbackPrompt) {
            const result = [...nextMessages, createAssistantTextMessage(await getLocalFallback(fallbackPrompt))];
            setCachedChatMessages(result);
            setMessages(result);
            return result;
          }
          throw new Error(error?.error || 'Request failed');
        }
        if (!response.body) throw new Error('The response body is empty.');

        setMessages(prev => [...prev, assistantMessage]);
        const chunkStream = parseJsonEventStream({ stream: response.body, schema: uiMessageChunkSchema }).pipeThrough(new TransformStream<ParseResult<UIMessageChunk>, UIMessageChunk>({ transform(chunk, controller) { if (!chunk.success) throw chunk.error; controller.enqueue(chunk.value); } }));
        const uiStream = readUIMessageStream({ message: assistantMessage, stream: chunkStream, terminateOnError: true });

        let latestMessage = assistantMessage;
        for await (const message of uiStream) {
          if (signal.aborted) break;
          latestMessage = { ...message, createdAt: assistantMessage.createdAt };
          setMessages(prev => prev.map(existing => (existing.id === assistantMessage.id ? latestMessage : existing)));
        }

        const finalMessages = [...nextMessages, latestMessage];
        setCachedChatMessages(finalMessages);
        return finalMessages;
      },
    });

    const waitForTask = () => {
      const task = getBackgroundAiTask<ChatMessage[]>(taskId);
      if (!task || task.status === 'running' || task.status === 'pending') return void requestAnimationFrame(waitForTask);
      if (task.status === 'completed' && task.result) setMessages(task.result);
      if (task.status === 'failed') {
        const fallback = fallbackPrompt
          ? getLocalFallback(fallbackPrompt)
          : Promise.resolve('The approval response could not be processed.');
        fallback.then(message => {
          const result = [...nextMessages, createAssistantTextMessage(`⚠️ ${task.error || message}`)];
          setCachedChatMessages(result);
          setMessages(result);
        });
      }
      setLoading(false);
    };

    requestAnimationFrame(waitForTask);
  }, []);

  const sendMessage = useCallback(async (text?: string) => {
    if (loading) return;
    const msg = text || input.trim();
    if (!msg) return;
    setInput('');
    submitChat([...messages, createUserMessage(msg)], msg, msg);
  }, [input, loading, messages, submitChat]);

  const handleApprovalResponse = useCallback<ToolApprovalHandler>(async (
    requestedPart,
    approved,
  ) => {
    if (loading || requestedPart.state !== 'approval-requested') return;
    const nextMessages = messages.map(message => ({
      ...message,
      parts: message.parts.map(part => {
        if (
          !('toolCallId' in part)
          || part.toolCallId !== requestedPart.toolCallId
          || !('approval' in part)
          || part.approval?.id !== requestedPart.approval.id
          || part.state !== 'approval-requested'
        ) {
          return part;
        }
        return {
          ...part,
          state: 'approval-responded' as const,
          approval: {
            ...part.approval,
            approved,
            reason: approved ? 'User explicitly approved this proposal.' : 'User denied this proposal.',
          },
        };
      }),
    })) as ChatMessage[];
    const toolName = getToolName(requestedPart as ToolPart);
    submitChat(
      nextMessages,
      `${approved ? 'Approve' : 'Deny'} ${toolName}`,
    );
  }, [loading, messages, submitChat]);

  const handleKeyDown = useCallback<KeyboardEventHandler<HTMLTextAreaElement>>(event => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void sendMessage();
    }
  }, [sendMessage]);

  const runFeature = useCallback(async (endpoint: string, title: string, method = 'GET') => {
    setSidebarResult({ title, content: '', loading: true });
    try {
      const response = await fetch(`/api/ai/${endpoint}`, { method });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error);
      setSidebarResult({ title, content: JSON.stringify(data, null, 2), loading: false });
    } catch (err) {
      setSidebarResult({ title, content: `Error: ${err}`, loading: false });
    }
  }, []);

  // Mobile Houston Home: when user taps a quick action, transition to chat with the prompt
  const handleMobileStartChat = useCallback((prompt: string) => {
    setMobileShowChat(true);
    if (prompt) {
      void sendMessage(prompt);
    }
  }, [sendMessage]);

  const handleMobileBack = useCallback(() => {
    if (!loading) {
      setMobileShowChat(false);
    }
  }, [loading]);

  const handleMobileNewChat = useCallback(() => {
    setMessages([]);
    setCachedChatMessages([]);
    setInput('');
  }, []);

  return (
    <HoustonContextProvider>
      {isMobile ? (
        mobileShowChat ? (
          <MobileChatView
            input={input}
            inputRef={inputRef}
            loading={loading}
            messages={messages}
            messagesEndRef={messagesEndRef}
            onBack={handleMobileBack}
            onInputChange={setInput}
            onKeyDown={handleKeyDown}
            onNewChat={handleMobileNewChat}
            onSend={sendMessage}
            onApprovalResponse={handleApprovalResponse}
            providerInfo={providerInfo}
          />
        ) : (
          <HoustonHomeScreen onStartChat={handleMobileStartChat} loading={loading} />
        )
      ) : (
        <div className="flex h-full flex-col">
          <div className="border-b border-[var(--border)] bg-[var(--surface-1)] px-6 pt-4">
            <div className="flex gap-6">{tabs.map(tab => <button key={tab.id} type="button" onClick={() => setActiveTab(tab.id)} className={`border-b-2 px-1 pb-3 text-sm transition-colors ${activeTab === tab.id ? 'border-blue-500 text-[var(--text-primary)]' : 'border-transparent text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{tab.label}</button>)}</div>
          </div>
          <div className="flex-1 min-h-0">
            <AnimatePresence initial={false} mode="wait">
              <motion.div key={activeTab} initial={{ opacity: 0, y: 12, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -12, filter: 'blur(2px)' }} transition={{ duration: 0.2 }} className="h-full">
                {activeTab === 'chat' ? <AIChatTab input={input} inputRef={inputRef} isAiActive={isAiActive} loading={loading} messages={messages} messagesEndRef={messagesEndRef} onApprovalResponse={handleApprovalResponse} onClearSidebar={() => setSidebarResult(null)} onInputChange={setInput} onKeyDown={handleKeyDown} onRunFeature={runFeature} onSend={sendMessage} projects={projects} providerInfo={providerInfo} sidebarResult={sidebarResult} /> : null}
                {activeTab === 'agents' ? <div className="flex h-full items-center justify-center p-6"><div className="w-full max-w-2xl rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-6 text-center"><h2 className="text-lg font-semibold text-[var(--text-primary)]">Agents</h2><p className="mt-2 text-sm text-[var(--text-secondary)]">The agents workspace is being connected. This tab is reserved for the upcoming agent controls.</p></div></div> : null}
                {activeTab === 'insights' ? <AIInsightsPanel /> : null}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      )}
    </HoustonContextProvider>
  );
}
