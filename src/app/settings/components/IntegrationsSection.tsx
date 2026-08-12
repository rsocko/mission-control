'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  Loader2, Plus, Trash2, Zap, Save,
  CheckCircle2, XCircle, Puzzle, Webhook as WebhookIcon, Send, ArrowDownToLine, Copy,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import {
  staggerContainer, fadeSlideUp, modalOverlay, modalContent,
} from '@/lib/motion';
import { settingsLogger } from '@/lib/client-logger';
import type { N8NConfigState, OutboundWebhookSubscription, InboundWebhookConfig } from './types';
import { INTEGRATION_EVENT_OPTIONS } from './types';

const INBOUND_ACTION_OPTIONS: Array<{ value: 'task' | 'alert' | 'auto'; label: string; desc: string }> = [
  { value: 'auto', label: 'Auto-detect', desc: 'Infer task vs alert from payload' },
  { value: 'task', label: 'Always create task', desc: 'Every payload becomes a task' },
  { value: 'alert', label: 'Always create alert', desc: 'Every payload becomes an alert' },
];

function IntegrationsSection() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingN8N, setTestingN8N] = useState(false);
  const [n8nConfig, setN8NConfig] = useState<N8NConfigState>({
    baseUrl: '',
    enabled: false,
    workflowCount: 0,
    connected: false,
    lastCheckedAt: null,
  });
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [webhooks, setWebhooks] = useState<OutboundWebhookSubscription[]>([]);
  const [inboundWebhooks, setInboundWebhooks] = useState<InboundWebhookConfig[]>([]);
  const [statusMessage, setStatusMessage] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [showWebhookModal, setShowWebhookModal] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<OutboundWebhookSubscription | null>(null);
  const [webhookActionId, setWebhookActionId] = useState<string | null>(null);
  const [showInboundModal, setShowInboundModal] = useState(false);
  const [editingInbound, setEditingInbound] = useState<InboundWebhookConfig | null>(null);
  const [inboundActionId, setInboundActionId] = useState<string | null>(null);

  const loadIntegrations = useCallback(async () => {
    try {
      const [n8nRes, webhookRes, inboundRes] = await Promise.all([
        fetch('/api/integrations/n8n'),
        fetch('/api/integrations/webhooks'),
        fetch('/api/inbound-webhooks'),
      ]);
      const [n8nData, webhookData, inboundData] = await Promise.all([n8nRes.json(), webhookRes.json(), inboundRes.json()]);

      setN8NConfig({
        baseUrl: n8nData.baseUrl || '',
        enabled: Boolean(n8nData.enabled),
        workflowCount: n8nData.workflowCount || 0,
        connected: Boolean(n8nData.connected),
        lastCheckedAt: n8nData.lastCheckedAt || null,
      });
      setBaseUrl(n8nData.baseUrl || '');
      setWebhooks(webhookData.webhooks || []);
      setInboundWebhooks(inboundData.webhooks || []);
    } catch (error) {
      settingsLogger.error('Failed to load integrations', { err: error });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadIntegrations();
  }, [loadIntegrations]);

  async function handleSaveN8N() {
    setSaving(true);
    setStatusMessage(null);

    try {
      const response = await fetch('/api/integrations/n8n', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ baseUrl, apiKey }),
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save n8n configuration');
      }

      setStatusMessage({ tone: 'success', text: 'n8n configuration saved' });
      await loadIntegrations();
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to save n8n configuration' });
    } finally {
      setSaving(false);
    }
  }

  async function handleTestN8N() {
    setTestingN8N(true);
    setStatusMessage(null);

    try {
      const response = await fetch('/api/integrations/n8n', { method: 'PUT' });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.error || 'Unable to reach n8n');
      }

      setStatusMessage({ tone: 'success', text: `Connected to n8n • ${data.workflowCount} workflows discovered` });
      await loadIntegrations();
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Unable to reach n8n' });
      await loadIntegrations();
    } finally {
      setTestingN8N(false);
    }
  }

  async function handleWebhookDelete(id: string) {
    setWebhookActionId(id);
    try {
      await fetch(`/api/integrations/webhooks/${id}`, { method: 'DELETE' });
      await loadIntegrations();
    } finally {
      setWebhookActionId(null);
    }
  }

  async function handleWebhookToggle(id: string, enabled: boolean) {
    setWebhookActionId(id);
    try {
      await fetch(`/api/integrations/webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      await loadIntegrations();
    } finally {
      setWebhookActionId(null);
    }
  }

  async function handleWebhookTest(id: string) {
    setWebhookActionId(id);
    setStatusMessage(null);

    try {
      const response = await fetch(`/api/integrations/webhooks/${id}/test`, { method: 'POST' });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.error || `Test failed${data.status ? ` (HTTP ${data.status})` : ''}`);
      }
      setStatusMessage({ tone: 'success', text: `Test event delivered${data.status ? ` • HTTP ${data.status}` : ''}` });
      await loadIntegrations();
    } catch (error) {
      setStatusMessage({ tone: 'error', text: error instanceof Error ? error.message : 'Failed to send test event' });
      await loadIntegrations();
    } finally {
      setWebhookActionId(null);
    }
  }

  async function handleWebhookSaved() {
    setShowWebhookModal(false);
    setEditingWebhook(null);
    await loadIntegrations();
  }

  async function handleInboundDelete(id: string) {
    setInboundActionId(id);
    try {
      await fetch(`/api/inbound-webhooks/${id}`, { method: 'DELETE' });
      await loadIntegrations();
    } finally {
      setInboundActionId(null);
    }
  }

  async function handleInboundToggle(id: string, enabled: boolean) {
    setInboundActionId(id);
    try {
      await fetch(`/api/inbound-webhooks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      await loadIntegrations();
    } finally {
      setInboundActionId(null);
    }
  }

  async function handleInboundSaved() {
    setShowInboundModal(false);
    setEditingInbound(null);
    await loadIntegrations();
  }

  return (
    <>
      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="space-y-6">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)]">Integrations</h2>
          <p className="mt-1 text-sm text-[var(--text-tertiary)]">
            Connect Mission Control to n8n, publish outbound events, and receive inbound pushes from external systems.
          </p>
        </div>

        {statusMessage && (
          <motion.div
            variants={fadeSlideUp}
            className={`rounded-xl border p-3 text-sm ${
              statusMessage.tone === 'success'
                ? 'border-emerald-800/30 bg-emerald-900/10 text-emerald-300'
                : 'border-red-800/30 bg-red-900/10 text-red-300'
            }`}
          >
            {statusMessage.text}
          </motion.div>
        )}

        <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)] text-[var(--accent-400)]">
                  <Puzzle size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">n8n</h3>
                  <p className="text-xs text-[var(--text-tertiary)]">Use Mission Control as both a webhook source and automation target.</p>
                </div>
              </div>
            </div>

            <div className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${
              n8nConfig.connected
                ? 'border-emerald-800/30 bg-emerald-900/20 text-emerald-300'
                : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)]'
            }`}>
              {n8nConfig.connected ? <CheckCircle2 size={12} /> : <XCircle size={12} />}
              {n8nConfig.connected ? 'Connected' : 'Disconnected'}
            </div>
          </div>

          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Base URL</label>
              <input
                type="url"
                value={baseUrl}
                onChange={(event) => setBaseUrl(event.target.value)}
                placeholder="http://n8n.example.com"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">API Key</label>
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="Paste your n8n API key"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
            </div>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-3">
            <motion.button
              onClick={handleSaveN8N}
              disabled={saving || loading}
              whileTap={{ scale: 0.97 }}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              {saving ? 'Saving...' : 'Save Configuration'}
            </motion.button>
            <motion.button
              onClick={handleTestN8N}
              disabled={testingN8N || !baseUrl.trim()}
              whileTap={{ scale: 0.97 }}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
            >
              {testingN8N ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {testingN8N ? 'Testing...' : 'Test Connection'}
            </motion.button>
            {n8nConfig.connected && (
              <span className="text-xs text-[var(--text-tertiary)]">
                {n8nConfig.workflowCount} workflows discovered
                {n8nConfig.lastCheckedAt ? ` • checked ${new Date(n8nConfig.lastCheckedAt).toLocaleString()}` : ''}
              </span>
            )}
          </div>
        </motion.div>

        <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)] text-[var(--accent-400)]">
                  <WebhookIcon size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">Outbound Webhooks</h3>
                  <p className="text-xs text-[var(--text-tertiary)]">Dispatch Mission Control events to n8n workflows or other listeners.</p>
                </div>
              </div>
            </div>

            <motion.button
              onClick={() => {
                setEditingWebhook(null);
                setShowWebhookModal(true);
              }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              <Plus size={14} />
              Add Webhook
            </motion.button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin" />
              Loading integrations...
            </div>
          ) : webhooks.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-0)] p-8 text-center">
              <WebhookIcon size={28} className="mx-auto text-[var(--text-muted)]" />
              <p className="mt-3 text-sm text-[var(--text-secondary)]">No outbound webhooks configured yet.</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Create a subscription to notify n8n when tasks, alerts, syncs, or finance events happen.</p>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
              <div className="min-w-[920px]">
                <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,1fr)_120px_110px_160px] gap-3 border-b border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  <span>Name</span>
                  <span>URL</span>
                  <span>Events</span>
                  <span>Enabled</span>
                  <span>Last Status</span>
                  <span>Actions</span>
                </div>

                {webhooks.map((webhook) => (
                  <div
                    key={webhook.id}
                    className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1.35fr)_minmax(0,1fr)_120px_110px_160px] gap-3 border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--text-primary)]">{webhook.name}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{new Date(webhook.createdAt).toLocaleDateString()}</p>
                    </div>

                    <div className="min-w-0">
                      <p className="truncate text-xs text-[var(--text-secondary)]">{webhook.url}</p>
                      {webhook.lastTriggeredAt && (
                        <p className="mt-1 text-xs text-[var(--text-muted)]">Last sent {new Date(webhook.lastTriggeredAt).toLocaleString()}</p>
                      )}
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {webhook.eventTypes.map((eventType) => (
                        <span key={eventType} className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1 text-xs text-[var(--text-secondary)]">
                          {eventType}
                        </span>
                      ))}
                    </div>

                    <div className="flex items-center">
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={webhook.enabled}
                          onChange={(event) => handleWebhookToggle(webhook.id, event.target.checked)}
                          className="peer sr-only"
                          disabled={webhookActionId === webhook.id}
                        />
                        <div className="h-5 w-9 rounded-full bg-[var(--surface-3)] after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-blue-600 peer-checked:after:translate-x-full" />
                      </label>
                    </div>

                    <div className="flex items-center">
                      <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium ${
                        webhook.lastStatus && webhook.lastStatus >= 200 && webhook.lastStatus < 300
                          ? 'bg-emerald-900/20 text-emerald-300'
                          : webhook.lastStatus
                            ? 'bg-red-900/20 text-red-300'
                            : 'bg-[var(--surface-0)] text-[var(--text-muted)]'
                      }`}>
                        {webhook.lastStatus ?? 'Never'}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => handleWebhookTest(webhook.id)}
                        disabled={webhookActionId === webhook.id}
                        className="inline-flex min-h-10 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)] disabled:opacity-50"
                      >
                        {webhookActionId === webhook.id ? <Loader2 size={12} className="animate-spin" /> : <Send size={12} />}
                        Send Test
                      </button>
                      <button
                        onClick={() => {
                          setEditingWebhook(webhook);
                          setShowWebhookModal(true);
                        }}
                        className="inline-flex min-h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleWebhookDelete(webhook.id)}
                        disabled={webhookActionId === webhook.id}
                        className="inline-flex min-h-10 items-center rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>

        {/* ─── Inbound Webhooks ──────────────────────────────────────────────── */}
        <motion.div variants={fadeSlideUp} className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl p-4">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--surface-0)] text-emerald-400">
                  <ArrowDownToLine size={18} />
                </div>
                <div>
                  <h3 className="text-sm font-semibold text-[var(--text-primary)]">Inbound Webhooks</h3>
                  <p className="text-xs text-[var(--text-tertiary)]">Public endpoints for external systems to push tasks and notifications into Mission Control.</p>
                </div>
              </div>
            </div>

            <motion.button
              onClick={() => {
                setEditingInbound(null);
                setShowInboundModal(true);
              }}
              whileTap={{ scale: 0.97 }}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
            >
              <Plus size={14} />
              Add Endpoint
            </motion.button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center gap-2 py-10 text-sm text-[var(--text-muted)]">
              <Loader2 size={16} className="animate-spin" />
              Loading integrations...
            </div>
          ) : inboundWebhooks.length === 0 ? (
            <div className="mt-4 rounded-xl border border-dashed border-[var(--border)] bg-[var(--surface-0)] p-8 text-center">
              <ArrowDownToLine size={28} className="mx-auto text-[var(--text-muted)]" />
              <p className="mt-3 text-sm text-[var(--text-secondary)]">No inbound webhook endpoints configured yet.</p>
              <p className="mt-1 text-xs text-[var(--text-muted)]">Create an endpoint to let n8n, IFTTT, Home Assistant, or any external system push data into Mission Control.</p>
            </div>
          ) : (
            <div className="mt-4 overflow-x-auto rounded-xl border border-[var(--border)]">
              <div className="min-w-[820px]">
                <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_90px_90px_110px_130px] gap-3 border-b border-[var(--border)] bg-[var(--surface-0)] px-4 py-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-tertiary)]">
                  <span>Name / Source</span>
                  <span>Receive URL</span>
                  <span>Action</span>
                  <span>Enabled</span>
                  <span>Received</span>
                  <span>Actions</span>
                </div>

                {inboundWebhooks.map((wh) => (
                  <div
                    key={wh.id}
                    className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,0.8fr)_90px_90px_110px_130px] gap-3 border-b border-[var(--border-subtle)] px-4 py-3 last:border-b-0"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-[var(--text-primary)]">{wh.name}</p>
                      <p className="mt-1 text-xs text-[var(--text-muted)]">{wh.sourceLabel}</p>
                    </div>

                    <div className="min-w-0 flex items-center gap-1.5">
                      <p className="truncate text-xs font-mono text-[var(--text-secondary)]">/api/inbound-webhooks/{wh.id.slice(0, 8)}…/receive</p>
                      <button
                        onClick={() => {
                          const url = `${window.location.origin}/api/inbound-webhooks/${wh.id}/receive`;
                          navigator.clipboard.writeText(url);
                          setStatusMessage({ tone: 'success', text: 'Receive URL copied to clipboard' });
                        }}
                        className="shrink-0 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
                        title="Copy receive URL"
                      >
                        <Copy size={12} />
                      </button>
                    </div>

                    <div className="flex items-center">
                      <span className={`inline-flex items-center rounded-full border px-2 py-1 text-xs font-medium ${
                        wh.defaultAction === 'task'
                          ? 'border-blue-800/30 bg-blue-900/20 text-blue-300'
                          : wh.defaultAction === 'alert'
                            ? 'border-amber-800/30 bg-amber-900/20 text-amber-300'
                            : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)]'
                      }`}>
                        {wh.defaultAction}
                      </span>
                    </div>

                    <div className="flex items-center">
                      <label className="relative inline-flex cursor-pointer items-center">
                        <input
                          type="checkbox"
                          checked={wh.enabled}
                          onChange={(event) => handleInboundToggle(wh.id, event.target.checked)}
                          className="peer sr-only"
                          disabled={inboundActionId === wh.id}
                        />
                        <div className="h-5 w-9 rounded-full bg-[var(--surface-3)] after:absolute after:left-[2px] after:top-[2px] after:h-4 after:w-4 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-blue-600 peer-checked:after:translate-x-full" />
                      </label>
                    </div>

                    <div className="flex items-center">
                      <span className="text-xs text-[var(--text-secondary)]">
                        {wh.totalReceived > 0 ? (
                          <>
                            <span className="font-mono font-medium">{wh.totalReceived}</span>
                            {wh.lastReceivedAt && (
                              <span className="ml-1 text-[var(--text-muted)]">
                                • {new Date(wh.lastReceivedAt).toLocaleDateString()}
                              </span>
                            )}
                          </>
                        ) : (
                          <span className="text-[var(--text-muted)]">Never</span>
                        )}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          setEditingInbound(wh);
                          setShowInboundModal(true);
                        }}
                        className="inline-flex min-h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
                      >
                        Edit
                      </button>
                      <button
                        onClick={() => handleInboundDelete(wh.id)}
                        disabled={inboundActionId === wh.id}
                        className="inline-flex min-h-10 items-center rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-900/20 disabled:opacity-50"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </motion.div>
      </motion.div>

      <AnimatePresence>
        {showWebhookModal && (
          <WebhookModal
            webhook={editingWebhook}
            onClose={() => {
              setShowWebhookModal(false);
              setEditingWebhook(null);
            }}
            onSaved={handleWebhookSaved}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showInboundModal && (
          <InboundWebhookModal
            webhook={editingInbound}
            onClose={() => {
              setShowInboundModal(false);
              setEditingInbound(null);
            }}
            onSaved={handleInboundSaved}
          />
        )}
      </AnimatePresence>
    </>
  );
}

function WebhookModal({
  webhook,
  onClose,
  onSaved,
}: {
  webhook: OutboundWebhookSubscription | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(webhook?.name || '');
  const [url, setUrl] = useState(webhook?.url || '');
  const [secret, setSecret] = useState(webhook?.secret || '');
  const [eventTypes, setEventTypes] = useState<string[]>(webhook?.eventTypes || ['task.created']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleEventType(eventType: string) {
    setEventTypes((current) => (
      current.includes(eventType)
        ? current.filter((item) => item !== eventType)
        : [...current, eventType]
    ));
  }

  async function handleSubmit() {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        webhook ? `/api/integrations/webhooks/${webhook.id}` : '/api/integrations/webhooks',
        {
          method: webhook ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, url, secret, eventTypes }),
        },
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save webhook');
      }

      await onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save webhook');
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
        className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">{webhook ? 'Edit Webhook' : 'Add Webhook'}</h3>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">Choose which Mission Control events should fan out to this destination.</p>
          </div>
          <button onClick={onClose} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
        </div>

        <div className="mt-5 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Name</label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="n8n automation"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Secret</label>
              <input
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                placeholder="Optional signing secret"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Webhook URL</label>
            <input
              type="url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="https://n8n.example.com/webhook/mission-control"
              className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
            />
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Event Types</label>
            <div className="grid gap-2 sm:grid-cols-2">
              {INTEGRATION_EVENT_OPTIONS.map((eventType) => (
                <label
                  key={eventType}
                  className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-xl border px-3 py-2 text-xs transition-colors ${
                    eventTypes.includes(eventType)
                      ? 'border-blue-500/40 bg-blue-900/20 text-blue-200'
                      : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={eventTypes.includes(eventType)}
                    onChange={() => toggleEventType(eventType)}
                    className="h-3.5 w-3.5 rounded border-[var(--border)] bg-[var(--surface-0)]"
                  />
                  <span>{eventType}</span>
                </label>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
          <motion.button
            onClick={handleSubmit}
            disabled={saving}
            whileTap={{ scale: 0.97 }}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving...' : webhook ? 'Save Changes' : 'Create Webhook'}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// --- Inbound Webhook Modal ---------------------------------------------------

function InboundWebhookModal({
  webhook,
  onClose,
  onSaved,
}: {
  webhook: InboundWebhookConfig | null;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [name, setName] = useState(webhook?.name || '');
  const [sourceLabel, setSourceLabel] = useState(webhook?.sourceLabel || 'webhook');
  const [secret, setSecret] = useState(webhook?.secret || '');
  const [defaultAction, setDefaultAction] = useState<'task' | 'alert' | 'auto'>(webhook?.defaultAction || 'auto');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit() {
    setSaving(true);
    setError(null);

    try {
      const response = await fetch(
        webhook ? `/api/inbound-webhooks/${webhook.id}` : '/api/inbound-webhooks',
        {
          method: webhook ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, sourceLabel, secret, defaultAction }),
        },
      );
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save inbound webhook');
      }

      await onSaved();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Failed to save inbound webhook');
    } finally {
      setSaving(false);
    }
  }

  return (
    <motion.div
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
        className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-6 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-lg font-semibold text-[var(--text-primary)]">{webhook ? 'Edit Inbound Endpoint' : 'Add Inbound Endpoint'}</h3>
            <p className="mt-1 text-sm text-[var(--text-tertiary)]">Configure a public URL that external systems can POST to.</p>
          </div>
          <button onClick={onClose} className="text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
        </div>

        <div className="mt-5 space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Name</label>
              <input
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Home Assistant alerts"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Source Label</label>
              <input
                type="text"
                value={sourceLabel}
                onChange={(event) => setSourceLabel(event.target.value)}
                placeholder="home-assistant"
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
              />
              <p className="mt-1 text-xs text-[var(--text-muted)]">Shown as the source attribution on created items.</p>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Signing Secret</label>
            <input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="Optional HMAC-SHA256 secret for payload verification"
              className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]"
            />
            <p className="mt-1 text-xs text-[var(--text-muted)]">If set, incoming requests must include X-Webhook-Signature header.</p>
          </div>

          <div>
            <label className="mb-2 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Default Action</label>
            <div className="grid gap-2 sm:grid-cols-3">
              {INBOUND_ACTION_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className={`flex min-h-10 cursor-pointer flex-col gap-0.5 rounded-xl border px-3 py-2 text-xs transition-colors ${
                    defaultAction === option.value
                      ? 'border-blue-500/40 bg-blue-900/20 text-blue-200'
                      : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="defaultAction"
                      value={option.value}
                      checked={defaultAction === option.value}
                      onChange={() => setDefaultAction(option.value)}
                      className="h-3.5 w-3.5"
                    />
                    <span className="font-medium">{option.label}</span>
                  </div>
                  <span className="ml-5 text-[12px] text-[var(--text-muted)]">{option.desc}</span>
                </label>
              ))}
            </div>
          </div>

          {webhook && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3">
              <label className="mb-1 block text-xs font-semibold uppercase text-[var(--text-tertiary)]">Receive URL</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 truncate text-xs font-mono text-[var(--text-secondary)]">
                  {typeof window !== 'undefined' ? window.location.origin : ''}/api/inbound-webhooks/{webhook.id}/receive
                </code>
                <button
                  onClick={() => {
                    const url = `${window.location.origin}/api/inbound-webhooks/${webhook.id}/receive`;
                    navigator.clipboard.writeText(url);
                  }}
                  className="shrink-0 rounded p-1.5 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
                  title="Copy URL"
                >
                  <Copy size={14} />
                </button>
              </div>
            </div>
          )}

          {error && (
            <div className="rounded-lg border border-red-900/40 bg-red-900/10 px-3 py-2 text-xs text-red-300">
              {error}
            </div>
          )}
        </div>

        <div className="mt-6 flex items-center justify-end gap-3">
          <button
            onClick={onClose}
            className="inline-flex min-h-10 items-center rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-4 py-2 text-sm font-medium text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          >
            Cancel
          </button>
          <motion.button
            onClick={handleSubmit}
            disabled={saving}
            whileTap={{ scale: 0.97 }}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          >
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
            {saving ? 'Saving...' : webhook ? 'Save Changes' : 'Create Endpoint'}
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}


export { IntegrationsSection };
