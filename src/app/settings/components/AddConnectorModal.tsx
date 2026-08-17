'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  ChevronRight, Loader2, Shield, Eye, EyeOff,
  AlertTriangle, ExternalLink, CheckCircle2, XCircle, Save, Activity, Wifi,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  staggerContainer, fadeSlideUp, modalOverlay, modalContent,
} from '@/lib/motion';
import type { ConnectorConfig } from './types';
import { CONNECTOR_TYPES } from './types';
import { DEFAULT_DOCUMENT_INTELLIGENCE_URL } from '@/lib/connectors/document-intelligence';
import {
  DEFAULT_TYRION_BRIDGE_URL,
  defaultTyrionBridgeUrlForEnvironment,
} from '@/lib/connectors/monarch-money/constants';
import { ConnectorBrandIcon } from './ConnectorBrandIcon';
import { useConnectorCreation } from './useConnectorCreation';
import { useOAuthConnectorInstanceId } from './useOAuthConnectorInstanceId';
import { useCloseOnEscape } from '@/lib/hooks/useCloseOnEscape';

const DEFAULT_TYRION_SETUP_BRIDGE_URL = defaultTyrionBridgeUrlForEnvironment(
  process.env.NODE_ENV,
);

// --- Add Connector Modal --------------------------------------------------

type ConnectorSetupStep = 'select' | 'configure-mstodo' | 'configure-work-todo' | 'configure-github' | 'configure-finance' | 'configure-doc-intelligence' | 'configure-outlook-email' | 'configure-outlook-calendar' | 'configure-scout' | 'configure-other';

function AddConnectorModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [step, setStep] = useState<ConnectorSetupStep>('select');
  const [selectedType, setSelectedType] = useState<string | null>(null);
  useCloseOnEscape(onClose);

  function handleSelectType(type: string) {
    setSelectedType(type);
    if (type === 'microsoft-todo') {
      setStep('configure-mstodo');
    } else if (type === 'microsoft-todo-work') {
      setStep('configure-work-todo');
    } else if (type === 'github-issues') {
      setStep('configure-github');
    } else if (type === 'finance-manager') {
      setStep('configure-finance');
    } else if (type === 'document-intelligence') {
      setStep('configure-doc-intelligence');
    } else if (type === 'outlook-email') {
      setStep('configure-outlook-email');
    } else if (type === 'outlook-calendar') {
      setStep('configure-outlook-calendar');
    } else if (type === 'scout') {
      setStep('configure-scout');
    } else {
      setStep('configure-other');
    }
  }

  return (
    <motion.div
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50"
      onClick={onClose}
    >
      <motion.div
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
        role="dialog"
        aria-modal="true"
        aria-label="Add connector"
        className="bg-[var(--surface-1)] rounded-2xl shadow-2xl w-full max-w-lg p-6 border border-[var(--border)]"
        onClick={e => e.stopPropagation()}
      >
        <AnimatePresence mode="wait">
          {step === 'select' && (
            <motion.div key="select" initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -20 }} transition={{ duration: 0.15 }}>
              <ConnectorTypeSelector onSelect={handleSelectType} onClose={onClose} />
            </motion.div>
          )}
          {step === 'configure-mstodo' && (
            <motion.div key="mstodo" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <MicrosoftTodoSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-work-todo' && (
            <motion.div key="work-todo" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <WorkTodoSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-github' && (
            <motion.div key="github" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <GitHubSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-finance' && (
            <motion.div key="finance" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <FinanceManagerSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-doc-intelligence' && (
            <motion.div key="doc-intelligence" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <DocIntelligenceSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-outlook-email' && (
            <motion.div key="outlook-email" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <OutlookSetup connectorType="outlook-email" title="Outlook Email" description="Surface flagged and important emails as alerts." permissions="Mail.Read" onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-outlook-calendar' && (
            <motion.div key="outlook-calendar" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <OutlookSetup connectorType="outlook-calendar" title="Outlook Calendar" description="See upcoming events and get time-based reminders." permissions="Calendars.Read" onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-scout' && (
            <motion.div key="scout" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <ScoutSetup onBack={() => setStep('select')} onClose={onClose} onAdded={onAdded} />
            </motion.div>
          )}
          {step === 'configure-other' && (
            <motion.div key="other" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: 20 }} transition={{ duration: 0.15 }}>
              <div>
                <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">
                  {CONNECTOR_TYPES.find(c => c.type === selectedType)?.name || 'Connector'} Setup
                </h3>
                <p className="text-sm text-[var(--text-tertiary)] mb-4">This connector is not yet available for configuration. It will be enabled in a future update.</p>
                <div className="flex justify-between">
                  <button onClick={() => setStep('select')} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] flex items-center gap-1">
                    <ChevronRight size={12} className="rotate-180" /> Back
                  </button>
                  <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </motion.div>
  );
}

function WorkTodoSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = useState('Microsoft To Do - Work');
  const [tier, setTier] = useState<'standard' | 'extended'>('standard');
  const creation = useConnectorCreation();

  async function createConnector() {
    const extended = tier === 'extended';
    try {
      await creation.create({
        type: 'microsoft-todo-work',
        name: name.trim() || 'Microsoft To Do - Work',
        enabled: true,
        syncMode: 'manual',
        capabilities: {},
        credentials: {},
        settings: {
          transport: extended ? 'power-automate-graph' : 'power-automate-standard',
          capabilityProfile: extended ? 'extended-v1' : 'standard-v1',
        },
        syncedLists: [],
      });
    } catch { /* rendered by the shared creation state */ }
  }

  if (creation.status === 'success') {
    return (
      <div className="text-center py-4">
        <CheckCircle2 size={40} className="mx-auto text-emerald-400 mb-3" />
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Work To Do connector created</h3>
        <p className="text-sm text-[var(--text-tertiary)] mt-2 mb-4">
          Build and bind the matching Power Automate flows, then run the first pull.
          Lists and tasks appear only after Mission Control accepts that baseline.
        </p>
        <button onClick={onAdded} className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium">Done</button>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)]">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <ConnectorBrandIcon type="microsoft-todo-work" size={22} />
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect Work Microsoft To Do</h3>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Display Name</label>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] focus:outline-none"
          />
        </div>

        <fieldset>
          <legend className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Bridge tier</legend>
          <div className="space-y-2">
            <TierOption
              selected={tier === 'standard'}
              onSelect={() => setTier('standard')}
              title="Standard Power Automate"
              description="Core fields and bounded full snapshots using Microsoft To-Do (Business)."
            />
            <TierOption
              selected={tier === 'extended'}
              onSelect={() => setTier('extended')}
              title="Extended Microsoft Graph"
              description="Delta sync, native categories, checklists, recurrence, links, and attachment metadata."
            />
          </div>
        </fieldset>

        <div className="rounded-xl border border-amber-700/30 bg-amber-900/10 p-3 text-xs text-amber-200">
          Power Automate owns the corporate Microsoft connection. Do not paste flow trigger URLs,
          Graph tokens, or connection IDs into Mission Control.
        </div>

        {creation.error && (
          <div className="rounded-lg border border-red-800/40 bg-red-900/20 p-2 text-sm text-red-300">
            {creation.error}
          </div>
        )}

        <button
          onClick={createConnector}
          disabled={creation.status === 'creating'}
          className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {creation.status === 'creating' ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Create Work To Do connector
        </button>
      </div>

      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)]">Cancel</button>
      </div>
    </div>
  );
}

function TierOption({
  selected,
  onSelect,
  title,
  description,
}: {
  selected: boolean;
  onSelect: () => void;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`w-full text-left rounded-xl border p-3 ${
        selected ? 'border-blue-500 bg-blue-900/20' : 'border-[var(--border)] bg-[var(--surface-0)]'
      }`}
    >
      <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
      <div className="text-xs text-[var(--text-tertiary)] mt-1">{description}</div>
    </button>
  );
}

function ConnectorTypeSelector({ onSelect, onClose }: { onSelect: (type: string) => void; onClose: () => void }) {
  return (
    <>
      <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Add Connector</h3>
      <p className="text-sm text-[var(--text-tertiary)] mb-4">Choose a data source to connect:</p>
      <motion.div variants={staggerContainer} initial="hidden" animate="show" className="grid grid-cols-2 gap-3">
        {CONNECTOR_TYPES.map(ct => (
            <motion.button
              key={ct.type}
              variants={fadeSlideUp}
              onClick={() => onSelect(ct.type)}
              whileHover={{ scale: 1.02, borderColor: 'rgba(96, 165, 250, 0.5)' }}
              whileTap={{ scale: 0.97 }}
              className="border border-[var(--border)] rounded-xl p-4 text-left hover:bg-blue-900/10 transition-colors"
            >
              <div className="flex items-center gap-2.5 mb-1">
                <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
                  <ConnectorBrandIcon type={ct.type} size={20} />
                </div>
                <span className="text-sm font-medium text-[var(--text-primary)]">{ct.name}</span>
              </div>
              <p className="text-xs text-[var(--text-tertiary)] ml-10">{ct.description}</p>
            </motion.button>
        ))}
      </motion.div>
      <div className="flex justify-end mt-6">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </>
  );
}

// --- Tyrion Setup -----------------------------------------------------------

function FinanceManagerSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [instanceName, setInstanceName] = useState('Tyrion');
  const [bridgeUrl, setBridgeUrl] = useState(DEFAULT_TYRION_SETUP_BRIDGE_URL);
  const [serviceToken, setServiceToken] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<'idle' | 'testing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; details: string } | null>(null);
  const creation = useConnectorCreation();

  async function testConnection() {
    setStatus('testing');
    setErrorMessage('');
    setTestResult(null);

    try {
      const res = await fetch('/api/connectors/test-pre-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'finance-manager',
          credentials: serviceToken.trim() ? { serviceToken: serviceToken.trim() } : {},
          settings: { bridgeUrl: bridgeUrl.trim() },
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setStatus('error');
        setErrorMessage(data.error || 'Tyrion connection failed');
        return;
      }
      setStatus('idle');
      setTestResult({ success: true, details: data.details });
    } catch (err) {
      setStatus('error');
      setErrorMessage(`Unable to reach Tyrion: ${String(err)}`);
    }
  }

  async function createConnector() {
    setStatus('idle');
    setErrorMessage('');
    try {
      await creation.create({
        type: 'finance-manager',
        name: instanceName.trim() || 'Tyrion',
        enabled,
        syncMode: 'poll',
        pollIntervalMinutes: 240,
        capabilities: { read: true, write: true, delete: false, sync: true, lists: false, subtasks: false, tags: true, tagWriteBack: false },
        credentials: serviceToken.trim() ? { serviceToken: serviceToken.trim() } : {},
        settings: { bridgeUrl: bridgeUrl.trim() },
        syncedLists: [],
      });
    } catch { /* rendered by the shared creation state */ }
  }

  if (creation.status === 'success') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-4">
        <div className="w-14 h-14 rounded-full bg-emerald-900/30 border border-emerald-800/30 flex items-center justify-center mx-auto mb-3">
          <ConnectorBrandIcon type="finance-manager" size={32} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Tyrion connected</h3>
        <p className="text-sm text-[var(--text-tertiary)] mb-4">Mission Control will sync transaction snapshots and send category changes through Tyrion.</p>
        <motion.button onClick={onAdded} whileTap={{ scale: 0.97 }}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500">
          Done
        </motion.button>
      </motion.div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <ConnectorBrandIcon type="finance-manager" size={20} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect Tyrion</h3>
      </div>

      <div className="space-y-4">
        <div>
          <label htmlFor="tyrion-bridge-url" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
            Tyrion Bridge API URL
          </label>
          <input
            id="tyrion-bridge-url"
            type="url"
            maxLength={2048}
            required
            value={bridgeUrl}
            onChange={(event) => setBridgeUrl(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            placeholder={DEFAULT_TYRION_SETUP_BRIDGE_URL || DEFAULT_TYRION_BRIDGE_URL}
          />
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Enter the protected Bridge API base URL, including its versioned path.
          </p>
        </div>

        <div>
          <label htmlFor="tyrion-service-token" className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
            Service token
          </label>
          <input
            id="tyrion-service-token"
            type="password"
            value={serviceToken}
            onChange={(event) => setServiceToken(event.target.value)}
            autoComplete="new-password"
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"
            placeholder="Tyrion BRIDGE_API_TOKEN"
          />
          <p className="mt-1 text-xs text-[var(--text-muted)]">
            Stored server-side for this connector and never returned to the browser.
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Display Name</label>
          <input
            type="text"
            value={instanceName}
            onChange={e => setInstanceName(e.target.value)}
            placeholder="Tyrion"
            className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>

        <label className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">Enable connector</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5">Start syncing Tyrion transaction snapshots after setup</div>
          </div>
          <span className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="sr-only peer" />
            <span className="w-9 h-5 bg-[var(--surface-3)] rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-full" />
          </span>
        </label>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 text-xs text-[var(--text-tertiary)]">
          <p className="text-[var(--text-secondary)]">
            Tyrion is a Monarch Money bridge for Mission Control.
          </p>
          <p className="mt-1">
            Tyrion owns Monarch authentication; Mission Control stores no Monarch credentials.
          </p>
          <p className="mt-1">
            The recommended production gateway is <code>https://tyrion.example/api/connector/v1</code>. The bare operations UI and browser proxy are not connector APIs.
          </p>
        </div>

        {testResult && (
          <div className={`rounded-xl border p-3 text-sm ${testResult.success ? 'bg-emerald-900/10 border-emerald-800/30 text-emerald-300' : 'bg-amber-900/10 border-amber-800/30 text-amber-300'}`}>
            {testResult.details}
          </div>
        )}

        {(status === 'error' || creation.status === 'error') && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-red-900/20 border border-red-800/30 rounded-lg text-sm text-red-400 flex items-center gap-2">
            <XCircle size={14} /> {creation.error || errorMessage}
          </motion.div>
        )}

        <div className="flex flex-col gap-2">
          <motion.button
            onClick={testConnection}
            disabled={status === 'testing' || creation.status === 'creating'}
            whileTap={{ scale: 0.97 }}
            className="w-full px-4 py-2.5 bg-[var(--surface-2)] text-[var(--text-secondary)] rounded-lg text-sm font-medium hover:bg-[var(--surface-3)] disabled:opacity-50 flex items-center justify-center gap-2 border border-[var(--border)]"
          >
            {status === 'testing' ? (
              <><Loader2 size={14} className="animate-spin" /> Testing...</>
            ) : (
              <><Activity size={14} /> Test Connection</>
            )}
          </motion.button>

          <motion.button
            onClick={createConnector}
            disabled={creation.status === 'creating'}
            whileTap={{ scale: 0.97 }}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {creation.status === 'creating' ? (
              <><Loader2 size={14} className="animate-spin" /> Saving...</>
            ) : (
              <><Save size={14} /> Add Tyrion</>
            )}
          </motion.button>
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

// --- OWL Setup -------------------------------------------------------------

function DocIntelligenceSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [instanceName, setInstanceName] = useState('OWL');
  const [baseUrl, setBaseUrl] = useState(DEFAULT_DOCUMENT_INTELLIGENCE_URL);
  const [apiKey, setApiKey] = useState('');
  const [showApiKey, setShowApiKey] = useState(false);
  const [modules, setModules] = useState({ actionQueue: true, statements: true, eobMatching: true });
  const [enabled, setEnabled] = useState(true);
  const [status, setStatus] = useState<'idle' | 'testing' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [testResult, setTestResult] = useState<{ success: boolean; details: string } | null>(null);
  const creation = useConnectorCreation();

  function toggleModule(key: keyof typeof modules) {
    setModules(prev => ({ ...prev, [key]: !prev[key] }));
  }

  async function testConnection() {
    setStatus('testing');
    setErrorMessage('');
    setTestResult(null);

    try {
      const res = await fetch('/api/connectors/test-pre-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'document-intelligence',
          credentials: apiKey.trim() ? { apiKey: apiKey.trim() } : {},
          settings: {
            baseUrl: baseUrl.trim() || DEFAULT_DOCUMENT_INTELLIGENCE_URL,
            modules,
          },
        }),
        signal: AbortSignal.timeout(15000),
      });

      const data = await res.json();

      if (data.success) {
        setStatus('idle');
        setTestResult({ success: true, details: data.details || 'OWL is connected and responding.' });
      } else {
        setStatus('error');
        setErrorMessage(data.error || 'OWL returned an error');
      }
    } catch (err) {
      setStatus('error');
      setErrorMessage(`Unable to reach OWL: ${String(err)}`);
    }
  }

  async function createConnector() {
    setStatus('idle');
    setErrorMessage('');
    try {
      await creation.create({
        type: 'document-intelligence',
        name: instanceName.trim() || 'OWL',
        enabled,
        syncMode: 'poll',
        pollIntervalMinutes: 60,
        capabilities: { read: true, write: true, delete: false, sync: true, lists: true, subtasks: false, tags: true, tagWriteBack: false },
        credentials: apiKey.trim() ? { apiKey: apiKey.trim() } : {},
        settings: {
          baseUrl: baseUrl.trim() || DEFAULT_DOCUMENT_INTELLIGENCE_URL,
          modules,
        },
        syncedLists: [],
      });
    } catch { /* rendered by the shared creation state */ }
  }

  if (creation.status === 'success') {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-4">
        <div className="w-14 h-14 rounded-full bg-indigo-900/30 border border-indigo-800/30 flex items-center justify-center mx-auto mb-3">
          <ConnectorBrandIcon type="document-intelligence" size={28} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">OWL Connected!</h3>
        <p className="text-sm text-[var(--text-tertiary)] mb-4">OWL will surface actions from Paperless-ngx in Mission Control while your documents remain in Paperless-ngx.</p>
        <motion.button onClick={onAdded} whileTap={{ scale: 0.97 }}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500">
          Done
        </motion.button>
      </motion.div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <ConnectorBrandIcon type="document-intelligence" size={18} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect OWL</h3>
      </div>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Display Name</label>
          <input
            type="text"
            value={instanceName}
            onChange={e => setInstanceName(e.target.value)}
            placeholder="OWL"
            className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
            Base URL <span className="text-[var(--text-muted)] text-xs">(default: {DEFAULT_DOCUMENT_INTELLIGENCE_URL})</span>
          </label>
          <input
            type="url"
            value={baseUrl}
            onChange={e => setBaseUrl(e.target.value)}
            placeholder={DEFAULT_DOCUMENT_INTELLIGENCE_URL}
            className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none font-mono"
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">
            API Key <span className="text-[var(--text-muted)] text-xs">(optional)</span>
          </label>
          <div className="relative">
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="Leave blank if not required"
              className="w-full px-3 py-2 pr-10 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none font-mono"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
            >
              {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>

        {/* Module toggles */}
        <div>
          <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Modules</label>
          <div className="space-y-2">
            {([
              { key: 'actionQueue' as const, label: 'Action Queue', desc: 'Bills, forms, letters requiring action (pay, sign, file, review, respond, schedule)' },
              { key: 'statements' as const, label: 'Statement Tracking', desc: 'Alerts for expected periodic statements that haven\'t arrived' },
              { key: 'eobMatching' as const, label: 'EOB Matching', desc: 'Alerts for Explanation of Benefits without a matching bill' },
            ]).map(mod => (
              <label key={mod.key} className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
                <div>
                  <div className="text-sm font-medium text-[var(--text-primary)]">{mod.label}</div>
                  <div className="text-xs text-[var(--text-tertiary)] mt-0.5">{mod.desc}</div>
                </div>
                <span className="relative inline-flex items-center cursor-pointer ml-3 flex-shrink-0">
                  <input type="checkbox" checked={modules[mod.key]} onChange={() => toggleModule(mod.key)} className="sr-only peer" />
                  <span className="w-9 h-5 bg-[var(--surface-3)] rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-full" />
                </span>
              </label>
            ))}
          </div>
        </div>

        <label className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2.5">
          <div>
            <div className="text-sm font-medium text-[var(--text-primary)]">Enable connector</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5">Start syncing document actions after setup</div>
          </div>
          <span className="relative inline-flex items-center cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} className="sr-only peer" />
            <span className="w-9 h-5 bg-[var(--surface-3)] rounded-full peer peer-checked:bg-blue-600 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-transform peer-checked:after:translate-x-full" />
          </span>
        </label>

        <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 text-xs text-[var(--text-tertiary)]">
          <p className="text-[var(--text-secondary)]">
            OWL is the Paperless-ngx connector and document agent for Mission Control.
          </p>
          <p className="mt-1">
            Paperless-ngx remains the system of record for documents; OWL surfaces their actions in Docs.
          </p>
        </div>

        {testResult && (
          <div className={`rounded-xl border p-3 text-sm ${testResult.success ? 'bg-emerald-900/10 border-emerald-800/30 text-emerald-300' : 'bg-amber-900/10 border-amber-800/30 text-amber-300'}`}>
            {testResult.details}
          </div>
        )}

        {(status === 'error' || creation.status === 'error') && (
          <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
            className="p-3 bg-red-900/20 border border-red-800/30 rounded-lg text-sm text-red-400 flex items-center gap-2">
            <XCircle size={14} /> {creation.error || errorMessage}
          </motion.div>
        )}

        <div className="flex flex-col gap-2">
          <motion.button
            onClick={testConnection}
            disabled={status === 'testing' || creation.status === 'creating'}
            whileTap={{ scale: 0.97 }}
            className="w-full px-4 py-2.5 bg-[var(--surface-2)] text-[var(--text-secondary)] rounded-lg text-sm font-medium hover:bg-[var(--surface-3)] disabled:opacity-50 flex items-center justify-center gap-2 border border-[var(--border)]"
          >
            {status === 'testing' ? (
              <><Loader2 size={14} className="animate-spin" /> Testing...</>
            ) : (
              <><Activity size={14} /> Test Connection</>
            )}
          </motion.button>

          <motion.button
            onClick={createConnector}
            disabled={creation.status === 'creating'}
            whileTap={{ scale: 0.97 }}
            className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 flex items-center justify-center gap-2"
          >
            {creation.status === 'creating' ? (
              <><Loader2 size={14} className="animate-spin" /> Saving...</>
            ) : (
              <><Save size={14} /> Add OWL</>
            )}
          </motion.button>
        </div>
      </div>

      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

// --- Outlook Email / Calendar Setup (progressive consent) -------------------

function OutlookSetup({ connectorType, title, description, permissions, onBack, onClose, onAdded }: {
  connectorType: string;
  title: string;
  description: string;
  permissions: string;
  onBack: () => void;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [accountType, setAccountType] = useState<'personal' | 'work'>('personal');
  const [status, setStatus] = useState<'idle' | 'checking' | 'connecting' | 'success' | 'error'>('checking');
  const [existingAccount, setExistingAccount] = useState<{ id: string; email: string; hasPermission: boolean } | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const creation = useConnectorCreation();

  const getInstanceId = useOAuthConnectorInstanceId(connectorType);

  // Check for existing Microsoft accounts on mount
  useEffect(() => {
    fetch('/api/connectors')
      .then(r => r.json())
      .then(data => {
        const msConnectors = (data.connectors || []).filter(
          (c: ConnectorConfig) => c.type === 'microsoft-todo' && c.settings
        );
        if (msConnectors.length > 0) {
          const first = msConnectors[0];
          const settings = typeof first.settings === 'string' ? JSON.parse(first.settings) : first.settings;
          setExistingAccount({
            id: first.id,
            email: settings?.userEmail || settings?.userName || 'Connected account',
            hasPermission: false, // We'll check on demand
          });
          setAccountType(settings?.accountType || 'personal');
        }
        setStatus('idle');
      })
      .catch(() => setStatus('idle'));
  }, []);

  function startOAuth() {
    const instanceId = getInstanceId();
    setStatus('connecting');
    setErrorMessage('');
    creation.markCreating();

    const authUrl = `/api/auth/microsoft/connect?instanceId=${encodeURIComponent(instanceId)}&accountType=${accountType}&connectorType=${encodeURIComponent(connectorType)}`;
    const popup = window.open(authUrl, 'microsoft-oauth', 'width=600,height=700,popup=yes');

    // Listen for postMessage from the OAuth callback popup
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'mc-oauth-callback') return;

      window.removeEventListener('message', handleMessage);
      clearInterval(pollInterval);
      clearTimeout(timeoutId);

      if (event.data.success) {
        creation.markSuccess();
        setStatus('success');
        popup?.close();
        setTimeout(() => { onAdded(); onClose(); }, 800);
      } else {
        creation.markError(event.data.error || 'OAuth sign-in failed.');
        setStatus('error');
        setErrorMessage(event.data.error || 'OAuth sign-in failed.');
        popup?.close();
      }
    }
    window.addEventListener('message', handleMessage);

    // Fallback polling in case postMessage doesn't work
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/connectors');
        const data = await res.json();
        const connector = (data.connectors || []).find((c: ConnectorConfig) => c.id === instanceId);

        if (connector?.hasCredentials) {
          window.removeEventListener('message', handleMessage);
          clearInterval(pollInterval);
          clearTimeout(timeoutId);
          creation.markSuccess();
          setStatus('success');
          popup?.close();
          setTimeout(() => { onAdded(); onClose(); }, 800);
        }
      } catch {
        // continue polling
      }
    }, 2000);

    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handleMessage);
      clearInterval(pollInterval);
      creation.markError('OAuth sign-in timed out. Please try again.');
      setStatus('error');
      setErrorMessage('OAuth sign-in timed out. Please try again.');
    }, 300000);
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">{title}</h3>
      <p className="text-sm text-[var(--text-tertiary)] mb-4">{description}</p>

      {/* What you'll get */}
      <div className="mb-4 p-3 rounded-lg bg-[var(--surface-0)] border border-[var(--border)]">
        <p className="text-xs font-semibold text-[var(--text-secondary)] uppercase mb-2">What you&apos;ll get</p>
        <div className="flex flex-wrap gap-1.5 mb-2">
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-green-900/30 text-green-400 border border-green-800/40">âœ“ Alerts</span>
          {connectorType === 'outlook-calendar' && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-amber-900/30 text-amber-400 border border-amber-800/40">âœ“ My Day Timeline</span>
          )}
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-zinc-800/50 text-zinc-400 border border-zinc-700/40">âœ— Tasks</span>
          <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[12px] font-medium rounded-full bg-zinc-800/50 text-zinc-400 border border-zinc-700/40">âœ— Write-back</span>
        </div>
        <p className="text-[12px] text-[var(--text-muted)]">
          {connectorType === 'outlook-calendar'
            ? 'Upcoming events appear as time-based alerts and on the My Day timeline. No tasks are created.'
            : 'Flagged and important emails surface as actionable alerts. No tasks are created.'}
        </p>
        {connectorType === 'outlook-email' && existingAccount && (
          <p className="mt-2 text-[12px] text-amber-400/80 flex items-start gap-1">
            <span className="shrink-0 mt-px">âš ï¸</span>
            <span>Microsoft Todo is also connected â€” flagged emails will be managed as Todo tasks instead of appearing as email alerts, to avoid duplicates.</span>
          </p>
        )}
      </div>

      {status === 'checking' && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)] mb-4">
          <Loader2 size={14} className="animate-spin" /> Checking existing accounts...
        </div>
      )}

      {status === 'success' && (
        <div className="flex items-center gap-2 text-sm text-green-400 mb-4">
          <CheckCircle2 size={14} /> Connected successfully!
        </div>
      )}

      {status === 'error' && (errorMessage || creation.error) && (
        <div className="text-sm text-red-400 mb-4">{creation.error || errorMessage}</div>
      )}

      {status === 'idle' && (
        <>
          {existingAccount && (
            <div className="mb-4 p-3 rounded-lg bg-[var(--surface-0)] border border-[var(--border)]">
              <p className="text-xs text-[var(--text-muted)] mb-1">Existing Microsoft account detected:</p>
              <p className="text-sm text-[var(--text-primary)] font-medium mb-2">{existingAccount.email}</p>
              <p className="text-xs text-[var(--text-tertiary)] mb-3">
                This will request additional <span className="font-mono text-[var(--accent-400)]">{permissions}</span> permission via the same sign-in.
              </p>
              <Button
                onClick={startOAuth}
                className="w-full mt-1"
                size="lg"
              >
                Sign in &amp; grant {permissions}
              </Button>
            </div>
          )}

          {!existingAccount && (
            <>
              <div className="mb-4">
                <label className="block text-xs font-medium text-[var(--text-secondary)] mb-2">Account type</label>
                <div className="flex gap-2">
                  <button
                    onClick={() => setAccountType('personal')}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${accountType === 'personal' ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent-400)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}
                  >Personal</button>
                  <button
                    onClick={() => setAccountType('work')}
                    className={`px-3 py-1.5 text-xs rounded-lg border transition-colors ${accountType === 'work' ? 'border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--accent-400)]' : 'border-[var(--border)] text-[var(--text-secondary)]'}`}
                  >Work / School</button>
                </div>
              </div>
              <p className="text-xs text-[var(--text-tertiary)] mb-3">
                Requires <span className="font-mono text-[var(--accent-400)]">{permissions}</span> permission.
              </p>
              <Button
                onClick={startOAuth}
                className="w-full"
                size="lg"
              >
                Sign in with Microsoft
              </Button>
            </>
          )}
        </>
      )}

      {status === 'connecting' && (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 size={14} className="animate-spin" /> Waiting for sign-in...
        </div>
      )}

      <div className="flex justify-between mt-4">
        <button onClick={onBack} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] flex items-center gap-1">
          <ChevronRight size={12} className="rotate-180" /> Back
        </button>
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Close</button>
      </div>
    </div>
  );
}

// --- Microsoft Todo Setup --------------------------------------------------

function MicrosoftTodoSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [accountType, setAccountType] = useState<'personal' | 'work'>('personal');
  const [instanceName, setInstanceName] = useState('');
  const [status, setStatus] = useState<'idle' | 'connecting' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [configComplete, setConfigComplete] = useState(false);
  const creation = useConnectorCreation();

  const getInstanceId = useOAuthConnectorInstanceId('mstodo');

  async function startOAuth() {
    const instanceId = getInstanceId();
    setStatus('connecting');
    setErrorMessage('');
    creation.markCreating();

    const authUrl = `/api/auth/microsoft/connect?instanceId=${encodeURIComponent(instanceId)}&accountType=${accountType}${instanceName ? `&name=${encodeURIComponent(instanceName)}` : ''}`;
    const popup = window.open(authUrl, 'microsoft-oauth', 'width=600,height=700,popup=yes');

    // Listen for postMessage from the OAuth callback popup
    function handleMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type !== 'mc-oauth-callback') return;

      window.removeEventListener('message', handleMessage);
      clearInterval(pollInterval);
      clearTimeout(timeoutId);

      if (event.data.success) {
        creation.markSuccess();
        setStatus('success');
        popup?.close();
        setConfigComplete(true);
      } else {
        creation.markError(event.data.error || 'OAuth sign-in failed.');
        setStatus('error');
        setErrorMessage(event.data.error || 'OAuth sign-in failed.');
        popup?.close();
      }
    }
    window.addEventListener('message', handleMessage);

    // Fallback polling in case postMessage doesn't work (e.g. popup blocked, cross-origin)
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch('/api/connectors');
        const data = await res.json();
        const connector = (data.connectors || []).find((c: ConnectorConfig) => c.id === instanceId);

        if (connector?.hasCredentials) {
          window.removeEventListener('message', handleMessage);
          clearInterval(pollInterval);
          clearTimeout(timeoutId);
          creation.markSuccess();
          setStatus('success');
          popup?.close();
          setConfigComplete(true);
        }
      } catch {
        // continue polling
      }
    }, 2000);

    const timeoutId = setTimeout(() => {
      window.removeEventListener('message', handleMessage);
      clearInterval(pollInterval);
      creation.markError('OAuth sign-in timed out. Please try again.');
      setStatus('error');
      setErrorMessage('OAuth sign-in timed out. Please try again.');
    }, 300000);
  }

  async function createWithoutOAuth() {
    setStatus('connecting');
    try {
      await creation.create({
        type: 'microsoft-todo',
        name: instanceName || `Microsoft Todo (${accountType})`,
        enabled: true,
        syncMode: 'poll',
        pollIntervalMinutes: 5,
        capabilities: { read: true, write: true, delete: true, sync: true, lists: true, subtasks: true, tags: true, tagWriteBack: true },
        credentials: {},
        settings: { accountType, syncMicroStatus: false },
        syncedLists: [],
      });
      setStatus('success');
      setConfigComplete(true);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (configComplete) {
    return (
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-4">
        <div className="w-14 h-14 rounded-full bg-emerald-900/30 border border-emerald-800/30 flex items-center justify-center mx-auto mb-3">
          <CheckCircle2 size={28} className="text-emerald-400" />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">Microsoft Todo Connected!</h3>
        <p className="text-sm text-[var(--text-tertiary)] mb-4">Your connector is ready. Configure which lists to sync from the connector detail panel.</p>
        <motion.button onClick={onAdded} whileTap={{ scale: 0.97 }}
          className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500">
          Done
        </motion.button>
      </motion.div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <ConnectorBrandIcon type="microsoft-todo" size={18} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect Microsoft Todo</h3>
      </div>

      {/* Account Type */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">Account Type</label>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => setAccountType('personal')}
            className={`p-3 rounded-xl border-2 text-left text-sm transition-colors ${
              accountType === 'personal' ? 'border-blue-500/50 bg-blue-900/20' : 'border-[var(--border)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div className="font-medium text-[var(--text-primary)]">Personal</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5">Outlook.com, Hotmail, Live</div>
          </button>
          <button
            onClick={() => setAccountType('work')}
            className={`p-3 rounded-xl border-2 text-left text-sm transition-colors ${
              accountType === 'work' ? 'border-blue-500/50 bg-blue-900/20' : 'border-[var(--border)] hover:border-[var(--border-strong)]'
            }`}
          >
            <div className="font-medium text-[var(--text-primary)]">Work / School</div>
            <div className="text-xs text-[var(--text-tertiary)] mt-0.5">Microsoft 365, Azure AD</div>
          </button>
        </div>
      </div>

      {/* Display Name */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Display Name (optional)</label>
        <input
          type="text"
          value={instanceName}
          onChange={e => setInstanceName(e.target.value)}
          placeholder={`Microsoft Todo (${accountType})`}
          className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>

      {/* Error */}
      {status === 'error' && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-red-900/20 border border-red-800/30 rounded-lg text-sm text-red-400 flex items-center gap-2">
          <XCircle size={14} /> {creation.error || errorMessage || 'Connection failed. Please try again.'}
        </motion.div>
      )}

      {/* Actions */}
      <div className="flex flex-col gap-2">
        <motion.button
          onClick={startOAuth}
          disabled={status === 'connecting'}
          whileTap={{ scale: 0.97 }}
          className="w-full px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 flex items-center justify-center gap-2"
        >
          {status === 'connecting' ? (
            <><Loader2 size={14} className="animate-spin" /> Waiting for sign-in...</>
          ) : (
            <><Shield size={14} /> Sign in with Microsoft</>
          )}
        </motion.button>

        <div className="relative my-2">
          <div className="absolute inset-0 flex items-center"><div className="w-full border-t border-[var(--border)]" /></div>
          <div className="relative flex justify-center text-xs"><span className="bg-[var(--surface-1)] px-2 text-[var(--text-muted)]">or</span></div>
        </div>

        <button
          onClick={createWithoutOAuth}
          disabled={status === 'connecting'}
          className="w-full px-4 py-2 text-sm text-[var(--text-secondary)] border border-[var(--border-strong)] rounded-lg hover:bg-[var(--surface-2)] disabled:opacity-50"
        >
          Add without sign-in (configure later)
        </button>
      </div>

      {/* Info */}
      <div className="mt-4 p-3 bg-[var(--surface-0)] rounded-lg border border-[var(--border)]">
        <p className="text-xs text-[var(--text-tertiary)]">
          <strong className="text-[var(--text-secondary)]">Requires:</strong> <code className="bg-[var(--surface-2)] px-1.5 py-0.5 rounded text-[var(--text-secondary)]">MS_CLIENT_ID</code> and <code className="bg-[var(--surface-2)] px-1.5 py-0.5 rounded text-[var(--text-secondary)]">MS_CLIENT_SECRET</code> in <code className="bg-[var(--surface-2)] px-1.5 py-0.5 rounded text-[var(--text-secondary)]">.env.local</code>.
          <br />Register an app at <a href="https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps" target="_blank" rel="noopener" className="text-blue-400 underline inline-flex items-center gap-0.5">Azure Portal <ExternalLink size={9} /></a>.
          <br />Redirect URI: <code className="bg-[var(--surface-2)] px-1.5 py-0.5 rounded text-xs text-[var(--text-secondary)]">http://localhost:3099/api/auth/microsoft/callback</code>
        </p>
      </div>

      <div className="flex justify-end mt-4">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
      </div>
    </div>
  );
}

// --- GitHub Issues Setup --------------------------------------------------

function GitHubSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const [pat, setPat] = useState('');
  const [repos, setRepos] = useState('');
  const [instanceName, setInstanceName] = useState('');
  const [syncNotifications, setSyncNotifications] = useState(true);
  const [showToken, setShowToken] = useState(false);
  const [status, setStatus] = useState<'idle' | 'testing' | 'success' | 'scanning-labels' | 'labels-found' | 'normalizing-labels' | 'done' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [scopeWarnings, setScopeWarnings] = useState<Array<{ scope: string; label: string }>>([]);
  const [createdConnectorId, setCreatedConnectorId] = useState<string | null>(null);
  const creation = useConnectorCreation();
  const [labelScanResult, setLabelScanResult] = useState<{
    normalizations: Array<{ current: string; canonical: string; category: string; issueCount: number; repo: string }>;
    totalLabelsToNormalize: number;
    totalIssuesAffected: number;
  } | null>(null);

  async function testAndCreate() {
    setStatus('testing');
    setErrorMessage('');
    setScopeWarnings([]);

    const repoList = repos.split('\n').map(r => r.trim()).filter(Boolean);
    if (!pat) {
      setStatus('error');
      setErrorMessage('Personal Access Token is required');
      return;
    }
    if (repoList.length === 0) {
      setStatus('error');
      setErrorMessage('At least one repository is required (e.g., owner/repo)');
      return;
    }

    try {
      const testRes = await fetch('https://api.github.com/user', {
        headers: { Authorization: `token ${pat}` },
      });
      if (!testRes.ok) {
        setStatus('error');
        setErrorMessage(`GitHub API returned ${testRes.status}. Check your token.`);
        return;
      }
      const user = await testRes.json();

      // Detect token scopes from response header
      const oauthScopes = (testRes.headers.get('x-oauth-scopes') || '')
        .split(',').map(s => s.trim()).filter(Boolean);

      // Check for missing recommended scopes (classic tokens only)
      if (oauthScopes.length > 0) {
        const warnings: Array<{ scope: string; label: string }> = [];
        if (!oauthScopes.includes('project')) warnings.push({ scope: 'project', label: 'Projects v2 boards' });
        if (!oauthScopes.includes('notifications') && syncNotifications) warnings.push({ scope: 'notifications', label: 'Notification sync' });
        setScopeWarnings(warnings);
      }

      const created = await creation.create({
        type: 'github-issues',
        name: instanceName || `GitHub (${user.login})`,
        enabled: true,
        syncMode: 'poll',
        pollIntervalMinutes: 10,
        capabilities: { read: true, write: true, delete: false, sync: true, lists: true, subtasks: true, tags: true, tagWriteBack: true, tagScope: 'per-list', tagCreationMode: 'predefined' },
        credentials: { token: pat },
        settings: {
          repos: repoList,
          username: user.login,
          fetchNotifications: syncNotifications,
          syncMicroStatus: false,
        },
        syncedLists: repoList,
      });
      {
        const nestedConnector = created.connector as { id?: unknown } | undefined;
        const connId = typeof created.id === 'string'
          ? created.id
          : typeof nestedConnector?.id === 'string' ? nestedConnector.id : null;
        setCreatedConnectorId(connId);

        // Auto-scan for non-canonical labels
        if (connId) {
          try {
            setStatus('scanning-labels');
            const scanRes = await fetch(`/api/connectors/${connId}/label-scan`);
            if (scanRes.ok) {
              const scanData = await scanRes.json();
              if (scanData.totalLabelsToNormalize > 0) {
                setLabelScanResult(scanData);
                setStatus('labels-found');
                return;
              }
            }
          } catch {
            // Label scan failure is non-blocking
          }
        }
        setStatus('done');
      }
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  if (status === 'success' || status === 'scanning-labels' || status === 'labels-found' || status === 'normalizing-labels' || status === 'done') {
    async function handleNormalize() {
      if (!createdConnectorId || !labelScanResult) return;
      setStatus('normalizing-labels');
      try {
        const res = await fetch(`/api/connectors/${createdConnectorId}/label-normalize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ normalizations: labelScanResult.normalizations }),
        });
        if (!res.ok) throw new Error(await res.text());
        const result = await res.json();
        const { toast } = await import('sonner');
        if (result.failed === 0) {
          toast.success(`Normalized ${result.succeeded} label${result.succeeded !== 1 ? 's' : ''}`);
        } else {
          toast.warning(`Normalized ${result.succeeded}, ${result.failed} failed`);
        }
      } catch {
        // Non-blocking — just move on
      }
      setStatus('done');
    }

    return (
      <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} className="text-center py-4">
        <div className="w-14 h-14 rounded-full bg-emerald-900/30 border border-emerald-800/30 flex items-center justify-center mx-auto mb-3">
          <ConnectorBrandIcon type="github-issues" size={28} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-2">GitHub Connected!</h3>
        <p className="text-sm text-[var(--text-tertiary)] mb-4">Your repositories will be synced on the next poll cycle.</p>

        {/* Scope warnings */}
        {scopeWarnings.length > 0 && (
          <div className="mb-4 p-3 bg-amber-900/20 border border-amber-800/30 rounded-lg text-left">
            <p className="text-xs font-medium text-amber-300 mb-1.5 flex items-center gap-1.5">
              <AlertTriangle size={11} /> Missing token scopes
            </p>
            <div className="space-y-1">
              {scopeWarnings.map(w => (
                <div key={w.scope} className="text-xs text-amber-200/80 flex items-center gap-2">
                  <XCircle size={10} className="text-amber-400 shrink-0" />
                  <code className="bg-amber-900/30 px-1 py-0.5 rounded">{w.scope}</code>
                  <span className="text-[var(--text-muted)]">— {w.label}</span>
                </div>
              ))}
            </div>
            <p className="text-xs text-[var(--text-muted)] mt-2">
              Add these scopes to your PAT on{' '}
              <a href="https://github.com/settings/tokens" target="_blank" rel="noopener" className="text-blue-400 underline">GitHub</a>
              {' '}to unlock full functionality.
            </p>
          </div>
        )}

        {/* Label scanning states */}
        {status === 'scanning-labels' && (
          <div className="mb-4 p-3 bg-blue-900/20 border border-blue-800/30 rounded-lg text-left">
            <p className="text-xs text-blue-300 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Scanning labels for consistency…
            </p>
          </div>
        )}

        {status === 'labels-found' && labelScanResult && (
          <div className="mb-4 p-3 bg-amber-900/20 border border-amber-800/30 rounded-lg text-left">
            <p className="text-xs font-medium text-amber-300 mb-2 flex items-center gap-1.5">
              <AlertTriangle size={11} /> Found {labelScanResult.totalLabelsToNormalize} non-standard label{labelScanResult.totalLabelsToNormalize !== 1 ? 's' : ''}
            </p>
            <p className="text-xs text-[var(--text-muted)] mb-3">
              Mission Control uses canonical <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">priority:*</code> and{' '}
              <code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">effort:*</code> labels for bidirectional sync.
              We can rename these across {labelScanResult.totalIssuesAffected} issue{labelScanResult.totalIssuesAffected !== 1 ? 's' : ''}.
            </p>
            <div className="space-y-1 mb-3 max-h-32 overflow-y-auto">
              {labelScanResult.normalizations.map(n => (
                <div key={`${n.repo}:${n.current}`} className="flex items-center gap-2 text-xs">
                  <code className="bg-red-900/20 text-red-300 px-1.5 py-0.5 rounded border border-red-800/30">{n.current}</code>
                  <span className="text-[var(--text-muted)]">→</span>
                  <code className="bg-emerald-900/20 text-emerald-300 px-1.5 py-0.5 rounded border border-emerald-800/30">{n.canonical}</code>
                  <span className="text-[var(--text-muted)] ml-auto">{n.issueCount} issue{n.issueCount !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
            <div className="flex gap-2">
              <motion.button onClick={handleNormalize} whileTap={{ scale: 0.97 }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-500 transition-colors">
                Normalize Labels
              </motion.button>
              <motion.button onClick={() => setStatus('done')} whileTap={{ scale: 0.97 }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)] transition-colors border border-[var(--border)]">
                Skip
              </motion.button>
            </div>
          </div>
        )}

        {status === 'normalizing-labels' && (
          <div className="mb-4 p-3 bg-blue-900/20 border border-blue-800/30 rounded-lg text-left">
            <p className="text-xs text-blue-300 flex items-center gap-1.5">
              <Loader2 size={11} className="animate-spin" /> Normalizing labels across repos…
            </p>
          </div>
        )}

        {(status === 'done' || status === 'success') && (
          <motion.button onClick={onAdded} whileTap={{ scale: 0.97 }}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500">
            Done
          </motion.button>
        )}
      </motion.div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-5">
        <button onClick={onBack} className="p-1 rounded hover:bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
          <ChevronRight size={16} className="rotate-180" />
        </button>
        <div className="w-8 h-8 rounded-lg bg-[var(--surface-2)] flex items-center justify-center">
          <ConnectorBrandIcon type="github-issues" size={18} />
        </div>
        <h3 className="text-lg font-semibold text-[var(--text-primary)]">Connect GitHub Issues</h3>
      </div>

      {/* Display Name */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Display Name (optional)</label>
        <input
          type="text"
          value={instanceName}
          onChange={e => setInstanceName(e.target.value)}
          placeholder="GitHub (Personal)"
          className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>

      {/* PAT */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Personal Access Token</label>
        <div className="relative">
          <input
            type={showToken ? 'text' : 'password'}
            value={pat}
            onChange={e => setPat(e.target.value)}
            placeholder="ghp_..."
            className="w-full px-3 py-2 pr-10 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <button onClick={() => setShowToken(!showToken)} type="button"
            className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
            {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        </div>
        <div className="mt-2 space-y-2">
          <details className="group">
            <summary className="text-xs font-medium text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] flex items-center gap-1.5">
              <ChevronRight size={10} className="shrink-0 transition-transform duration-150 group-open:rotate-90" />
              Fine-grained token
            </summary>
            <div className="mt-2 ml-4 space-y-1.5 text-xs text-[var(--text-secondary)]">
              <p className="font-medium text-[var(--text-primary)] text-[12px] uppercase tracking-wide mb-1">Repository permissions</p>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded shrink-0">Required</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">Issues</code> â†’ Read and write</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-amber-400 bg-amber-900/20 px-1.5 py-0.5 rounded shrink-0">Recommended</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">Pull requests</code> â†’ Read-only</span>
              </div>
              <p className="text-[var(--text-muted)] mt-1.5"><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">Metadata</code> read is auto-granted.</p>
              <p className="text-amber-400/80 mt-1.5 text-[12px]">âš  Notification sync requires a classic token â€” the notifications API is not available with fine-grained tokens.</p>
            </div>
          </details>
          <details className="group" open>
            <summary className="text-xs font-medium text-[var(--text-secondary)] cursor-pointer hover:text-[var(--text-primary)] flex items-center gap-1.5">
              <ChevronRight size={10} className="shrink-0 transition-transform duration-150 group-open:rotate-90" />
              Classic token <span className="text-[12px] text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded">Recommended</span>
            </summary>
            <div className="mt-2 ml-4 space-y-1 text-xs text-[var(--text-secondary)]">
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded shrink-0">Required</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">repo</code> â€” issues, labels, projects</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-emerald-400 bg-emerald-900/20 px-1.5 py-0.5 rounded shrink-0">Required</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">project</code> â€” read GitHub Projects v2 boards</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-amber-400 bg-amber-900/20 px-1.5 py-0.5 rounded shrink-0">Recommended</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">notifications</code> â€” alert sync</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[12px] font-semibold text-[var(--text-muted)] bg-[var(--surface-2)] px-1.5 py-0.5 rounded shrink-0">Optional</span>
                <span><code className="bg-[var(--surface-2)] px-1 py-0.5 rounded">read:org</code> â€” private org repo access</span>
              </div>
            </div>
          </details>
          <p className="text-xs text-[var(--text-muted)] flex items-center gap-1 pt-0.5">
            <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener" className="text-blue-400 underline inline-flex items-center gap-0.5">Create fine-grained token <ExternalLink size={9} /></a>
            <span className="text-[var(--text-muted)]">Â·</span>
            <a href="https://github.com/settings/tokens/new?scopes=repo,project,notifications" target="_blank" rel="noopener" className="text-blue-400 underline inline-flex items-center gap-0.5">Create classic token <ExternalLink size={9} /></a>
          </p>
        </div>
      </div>

      {/* Repos */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-[var(--text-secondary)] mb-1">Repositories (one per line)</label>
        <textarea
          value={repos}
          onChange={e => setRepos(e.target.value)}
          placeholder={"owner/repo\nowner/another-repo"}
          rows={3}
          className="w-full px-3 py-2 bg-[var(--surface-0)] border border-[var(--border-strong)] rounded-lg text-sm font-mono text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none"
        />
      </div>

      <label className="mb-4 flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-1)] p-3 cursor-pointer hover:border-[var(--border-strong)] transition-colors">
        <input
          type="checkbox"
          checked={syncNotifications}
          onChange={e => setSyncNotifications(e.target.checked)}
          className="mt-0.5 h-4 w-4 rounded border-[var(--border-strong)] bg-[var(--surface-0)] text-blue-600 focus:ring-2 focus:ring-blue-500/50"
        />
        <span className="min-w-0">
          <span className="block text-sm text-[var(--text-primary)]">Sync GitHub notifications as alerts</span>
          <span className="mt-1 block text-xs text-[var(--text-muted)]">
            Includes PR review requests, mentions, CI failures, release updates, and security alerts.
          </span>
        </span>
      </label>

      {/* Error */}
      {status === 'error' && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}
          className="mb-4 p-3 bg-red-900/20 border border-red-800/30 rounded-lg text-sm text-red-400 flex items-center gap-2">
          <XCircle size={14} /> {errorMessage}
        </motion.div>
      )}

      {/* Actions */}
      <div className="flex justify-between">
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">Cancel</button>
        <motion.button
          onClick={testAndCreate}
          disabled={status === 'testing'}
          whileTap={{ scale: 0.97 }}
          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500 disabled:opacity-50 flex items-center gap-2"
        >
          {status === 'testing' ? <><Loader2 size={14} className="animate-spin" /> Testing...</> : <><Wifi size={14} /> Test & Connect</>}
        </motion.button>
      </div>
    </div>
  );
}

// ─── TRIAGE SOURCES SECTION ─────────────────────────────────────────────────


// ─── Scout Setup ────────────────────────────────────────────────────────────

function ScoutSetup({ onBack, onClose, onAdded }: { onBack: () => void; onClose: () => void; onAdded: () => void }) {
  const creation = useConnectorCreation();

  const mcpSnippet = JSON.stringify({
    'mission-control': {
      type: 'streamable-http',
      url: 'https://mission-control.example/api/mcp',
    },
  }, null, 2);

  async function handleEnable() {
    try {
      await creation.create({
        id: 'scout-primary',
        type: 'scout',
        name: 'Scout',
        syncMode: 'push',
        capabilities: {
          read: true,
          write: false,
          delete: false,
          sync: false,
          subtasks: false,
          lists: true,
          tags: true,
          tagWriteBack: false,
          listSelectionMode: 'not-applicable',
        },
      });
      onAdded();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to register connector';
      if (message.toLowerCase().includes('already')) {
        creation.markSuccess();
        onAdded();
      }
    }
  }

  return (
    <div>
      <h3 className="text-lg font-semibold text-[var(--text-primary)] mb-1">Scout Setup</h3>
      <p className="text-sm text-[var(--text-tertiary)] mb-4">
        Scout is a push-only AI connector — it pushes curated action items into Mission Control via MCP. No credentials needed.
      </p>

      <div className="space-y-4">
        <div>
          <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
            1. Register the connector
          </label>
          {creation.status === 'success' ? (
            <p className="text-sm text-emerald-400 flex items-center gap-1.5">
              <CheckCircle2 size={14} /> Scout connector registered. It will appear in your connectors list.
            </p>
          ) : (
            <Button
              onClick={handleEnable}
              disabled={creation.status === 'creating'}
              className="bg-blue-600 hover:bg-blue-500 text-white text-sm"
            >
              {creation.status === 'creating' ? <Loader2 size={14} className="animate-spin mr-1.5" /> : null}
              Enable Scout Connector
            </Button>
          )}
          {creation.error && creation.status === 'error' && (
            <p className="mt-2 text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle size={10} /> {creation.error}
            </p>
          )}
        </div>

        <div>
          <label className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-1.5 block">
            2. Add to your MCP client config
          </label>
          <pre className="bg-[var(--surface-2)] border border-[var(--border-subtle)] rounded-lg p-3 text-xs font-mono text-[var(--text-secondary)] overflow-x-auto whitespace-pre">
            {mcpSnippet}
          </pre>
          <p className="mt-1.5 text-xs text-[var(--text-muted)]">
            Paste this into your MCP client&apos;s server configuration (Copilot CLI, Claude Desktop, etc.)
          </p>
        </div>
      </div>

      <div className="flex justify-between mt-6">
        <button onClick={onBack} className="text-sm text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] flex items-center gap-1">
          <ChevronRight size={12} className="rotate-180" /> Back
        </button>
        <button onClick={onClose} className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
          {creation.status === 'success' ? 'Done' : 'Close'}
        </button>
      </div>
    </div>
  );
}

export { AddConnectorModal };
