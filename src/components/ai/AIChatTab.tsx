'use client';

import type { KeyboardEventHandler, RefObject } from 'react';
import Link from 'next/link';
import { BarChart3, Bell, Brain, ClipboardList, Flame, FolderOpen, Loader2, Newspaper, RefreshCw, Send, Tag, Target, TriangleAlert, X, Zap } from 'lucide-react';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import { ChatMessageRow } from '@/components/ai/ChatMessageRow';
import { AgentButton, SuggestionChip } from '@/components/ai/ChatWidgets';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { formatResult } from '@/lib/ai/chatFormatters';
import type { ChatMessage, HubProject, ProviderInfo, SidebarResult } from '@/lib/ai/chatTypes';
import type { ToolApprovalHandler } from '@/components/ai/ToolCard';

const suggestionPrompts = [
  ["What's overdue?", "What's overdue?"],
  ['Summarize my tasks', 'Give me a summary of all my tasks'],
  ['Plan my day', 'Help me plan my day — what should I focus on?'],
  ["What's critical?", 'What are my most critical items?'],
  ['Triage notifications', 'Triage my unread notifications and tell me what needs immediate attention.'],
  ['Suggest tags', 'Look at my untagged tasks and suggest tags.'],
] as const;

const chatActions = [
  { icon: BarChart3, label: 'Summarize tasks', prompt: 'Give me a full summary of my tasks — by status, priority, and source' },
  { icon: Flame, label: "What's overdue?", prompt: 'What tasks are overdue? List them with due dates.' },
  { icon: ClipboardList, label: 'Plan my day', prompt: 'Help me plan my day based on priorities and due dates.' },
  { icon: TriangleAlert, label: 'Triage notifications', prompt: 'Review my unread notifications and categorize them: act now, schedule, or dismiss.' },
] as const;

const analysisActions = [
  { icon: Zap, label: 'Smart Priority', desc: 'Re-rank tasks by urgency', endpoint: 'smart-priority', title: 'Smart Priority Rankings' },
  { icon: Newspaper, label: 'Daily Digest', desc: 'Morning briefing', endpoint: 'daily-digest', title: 'Daily Digest' },
  { icon: Tag, label: 'Infer Tags', desc: 'Suggest tags for untagged', endpoint: 'infer-tags', title: 'Tag Suggestions' },
  { icon: FolderOpen, label: 'Auto-Assign Projects', desc: 'Match tasks to projects', endpoint: 'assign-projects', title: 'Project Assignments' },
  { icon: Target, label: "What's Next?", desc: 'Context-aware advice', endpoint: 'whats-next', title: "What's Next", method: 'POST' },
  { icon: Bell, label: 'Triage Notifications', desc: 'Prioritize notifications', endpoint: 'triage-alerts', title: 'Notification Triage' },
] as const;

type AIChatTabProps = {
  input: string;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  isAiActive: boolean;
  loading: boolean;
  messages: ChatMessage[];
  messagesEndRef: RefObject<HTMLDivElement | null>;
  onClearSidebar: () => void;
  onInputChange: (value: string) => void;
  onKeyDown: KeyboardEventHandler<HTMLTextAreaElement>;
  onRunFeature: (endpoint: string, title: string, method?: string) => void | Promise<void>;
  onSend: (text?: string) => void | Promise<void>;
  onApprovalResponse?: ToolApprovalHandler;
  projects: HubProject[];
  providerInfo: ProviderInfo | null;
  sidebarResult: SidebarResult | null;
};

export function AIChatTab({
  input,
  inputRef,
  isAiActive,
  loading,
  messages,
  messagesEndRef,
  onClearSidebar,
  onInputChange,
  onKeyDown,
  onRunFeature,
  onSend,
  onApprovalResponse,
  projects,
  providerInfo,
  sidebarResult,
}: AIChatTabProps) {
  return (
    <div className="flex h-full">
      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex-1 overflow-y-auto p-6">
          {messages.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center max-w-lg">
                <div className="flex items-center justify-center mx-auto mb-4">
                  {providerInfo?.configured ? <HoustonIcon size={56} /> : <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center"><span className="text-2xl">🔌</span></div>}
                </div>
                <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Houston</h2>
                {providerInfo?.configured ? (
                  <>
                    <p className="text-sm text-[var(--text-tertiary)] mb-2">Powered by <span className="font-medium">{providerInfo.model}</span> via <span className="font-medium">{providerInfo.provider}</span></p>
                    <p className="text-xs text-[var(--text-muted)] mb-4">Houston here. Ask questions, get prioritization advice, or let me run analysis on your tasks and notifications.</p>
                    <div className="flex flex-wrap gap-2 justify-center">
                      {suggestionPrompts.map(([label, prompt]) => <SuggestionChip key={label} disabled={loading} text={label} onClick={() => void onSend(prompt)} />)}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-[var(--text-tertiary)] mb-2">AI features are not configured yet.</p>
                    <p className="text-xs text-[var(--text-muted)] mb-4">Set <code className="bg-[var(--surface-2)] px-1 rounded">AI_PROVIDER</code> and related keys in <code className="bg-[var(--surface-2)] px-1 rounded">.env.local</code> to enable AI assistant. Supports OpenAI, Azure OpenAI, and local Ollama.</p>
                    <Link href="/settings" className="text-sm text-blue-400 hover:underline">Go to Settings →</Link>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-4" role="log" aria-live="polite" aria-label="Chat messages">
              {messages.map(message => (
                <ChatMessageRow
                  key={message.id}
                  message={message}
                  loading={loading}
                  onApprovalResponse={onApprovalResponse}
                />
              ))}
              <div ref={messagesEndRef} />
            </div>
          )}
        </div>

        <div className="p-4 border-t border-[var(--border)] bg-[var(--surface-1)]">
          <div className="flex items-end gap-3 max-w-3xl mx-auto">
            <textarea ref={inputRef} rows={1} value={input} onChange={event => onInputChange(event.target.value)} onKeyDown={onKeyDown} placeholder="Ask Houston about your tasks, request analysis, or plan your day..." className="flex-1 px-4 py-3 border border-[var(--border)] rounded-lg resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm bg-[var(--surface-0)] text-[var(--text-primary)]" disabled={loading} />
            <button onClick={() => void onSend()} disabled={loading || !input.trim()} className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg hover:bg-blue-700 text-sm font-medium disabled:opacity-50 transition-colors">
              <Send className="w-4 h-4" />
              {loading ? 'Sending…' : 'Send'}
            </button>
          </div>
          <div className="flex items-center gap-3 mt-2 text-xs text-[var(--text-muted)] max-w-3xl mx-auto">
            <span className="flex items-center gap-1">
              <span className={`w-2 h-2 rounded-full ${providerInfo?.configured ? 'bg-green-400' : 'bg-gray-400'}`} />
              {providerInfo?.configured ? `${providerInfo.provider} / ${providerInfo.model}` : 'AI not configured'}
            </span>
            {isAiActive ? <span className="flex items-center gap-1 text-blue-400"><span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />AI processing…</span> : null}
            {providerInfo?.configured && providerInfo.baseUrl && providerInfo.baseUrl !== 'default' ? <span className="text-gray-300">@ {providerInfo.baseUrl.replace('http://', '').replace('/v1', '')}</span> : null}
            {!providerInfo?.configured ? <span className="text-[var(--text-muted)]">Configure in <Link href="/settings" className="text-blue-500 hover:underline">.env.local</Link></span> : null}
          </div>
        </div>
      </div>

      <aside className="w-80 bg-[var(--surface-1)] border-l border-[var(--border)] flex flex-col overflow-hidden flex-shrink-0" aria-label="AI intelligence sidebar">
        <div className="p-4 border-b border-[var(--border-subtle)]">
          <h3 className="font-semibold text-[var(--text-primary)] text-sm flex items-center gap-2"><Brain size={16} className="text-[var(--accent-400)]" /> AI Intelligence</h3>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Chat Actions</h4>
            {chatActions.map(action => <AgentButton key={action.label} disabled={loading} icon={<action.icon size={14} />} label={action.label} onClick={() => void onSend(action.prompt)} />)}
          </div>

          <hr className="border-[var(--border-subtle)]" />

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">AI Analysis</h4>
            {analysisActions.map(action => <AgentButton key={action.label} icon={<action.icon size={14} />} label={action.label} desc={action.desc} onClick={() => void onRunFeature(action.endpoint, action.title, 'method' in action ? action.method : undefined)} />)}
          </div>

          <hr className="border-[var(--border-subtle)]" />

          <div className="space-y-2">
            <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">Focus Planner</h4>
            <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--surface-0)]">
              <Select value="" onValueChange={() => {}}>
                <SelectTrigger className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] mb-2 bg-[var(--surface-1)]"><SelectValue placeholder="Any project" /></SelectTrigger>
                <SelectContent>{projects.map(project => <SelectItem key={project.id} value={project.id}><span className="inline-flex items-center gap-1.5"><IconRenderer value={project.icon} size={14} color={project.color} fallback={null} />{project.name}</span></SelectItem>)}</SelectContent>
              </Select>
              <Select value="" onValueChange={() => {}}>
                <SelectTrigger className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] mb-2 bg-[var(--surface-1)]"><SelectValue placeholder="Any time" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 min</SelectItem>
                  <SelectItem value="30">30 min</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="120">2+ hours</SelectItem>
                </SelectContent>
              </Select>
              <Select value="medium" onValueChange={() => {}}>
                <SelectTrigger className="w-full border border-[var(--border)] rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] mb-2 bg-[var(--surface-1)]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="medium">Medium energy</SelectItem>
                  <SelectItem value="high">High energy</SelectItem>
                  <SelectItem value="low">Low energy</SelectItem>
                </SelectContent>
              </Select>
              <button onClick={() => void onSend('I want to focus on work right now. What should I do next based on my priorities and due dates?')} disabled={loading} className="w-full px-3 py-1.5 bg-blue-600 text-white text-xs rounded-md hover:bg-blue-700 font-medium transition-colors disabled:opacity-50">Suggest What&apos;s Next</button>
            </div>
          </div>

          {sidebarResult ? (
            <>
              <hr className="border-[var(--border-subtle)]" />
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-semibold text-[var(--text-tertiary)] uppercase tracking-wider">{sidebarResult.title}</h4>
                  <button onClick={onClearSidebar} className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] text-xs"><X size={12} /></button>
                </div>
                <div className="border border-[var(--border)] rounded-lg p-3 bg-[var(--surface-0)] max-h-64 overflow-y-auto">
                  {sidebarResult.loading ? <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]"><Loader2 size={12} className="animate-spin" /> Analyzing...</div> : <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap break-words font-mono">{formatResult(sidebarResult.content)}</pre>}
                </div>
              </div>
            </>
          ) : null}

          <hr className="border-[var(--border-subtle)]" />
          <button onClick={() => { void fetch('/api/sync', { method: 'POST' }); }} className="w-full text-left border border-[var(--border)] rounded-lg p-3 hover:border-green-300 hover:bg-green-900/30/30 transition-colors">
            <div className="flex items-center gap-2">
              <RefreshCw size={14} />
              <span className="text-xs font-medium text-[var(--text-secondary)]">Sync All Sources</span>
            </div>
          </button>
        </div>
      </aside>
    </div>
  );
}
