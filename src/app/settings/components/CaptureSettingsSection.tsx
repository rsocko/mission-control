'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { Loader2, Inbox, MapPin, Plus, X, Check } from 'lucide-react';
import Image from 'next/image';
import { toast } from 'sonner';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';

// ─── Capture Destination Settings ─────────────────────────────────────────────

interface TaskDestination {
  id: string;
  type: string;
  name: string;
  account?: string;
  lists?: Array<{ sourceId: string; name: string }>;
}

interface CaptureDestination {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
}

function ConnectorIcon({ type, size = 16 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) return <Image src={src} alt={type} width={size} height={size} />;
  return <MapPin size={size} className="text-[var(--text-muted)]" />;
}

export function CaptureDestinationSection() {
  const [destination, setDestination] = useState<CaptureDestination>({ connectorType: 'local' });
  const [destinations, setDestinations] = useState<TaskDestination[]>([]);
  const [sourceLists, setSourceLists] = useState<Array<{ sourceId: string; name: string; connectorType: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([
      fetch('/api/settings/capture-destination').then(r => r.json()),
      fetch('/api/features').then(r => r.json()),
      fetch('/api/source-lists').then(r => r.ok ? r.json() : { sourceLists: [] }),
    ]).then(([destData, featuresData, listsData]) => {
      if (destData.destination) setDestination(destData.destination);
      if (featuresData.taskDestinations) setDestinations(featuresData.taskDestinations);
      if (listsData.sourceLists) {
        setSourceLists(listsData.sourceLists.map((sl: Record<string, unknown>) => ({
          sourceId: sl.sourceId as string,
          name: sl.name as string,
          connectorType: sl.connectorType as string,
        })));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const save = useCallback(async (newDest: CaptureDestination) => {
    setDestination(newDest);
    setSaving(true);
    try {
      await fetch('/api/settings/capture-destination', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newDest),
      });
      toast.success('Default capture location saved');
    } catch {
      toast.error('Failed to save');
    } finally {
      setSaving(false);
    }
  }, []);

  const handleConnectorChange = useCallback((connectorType: string) => {
    if (connectorType === 'local') {
      save({ connectorType: 'local' });
    } else {
      // Find the connector instance
      const dest = destinations.find(d => d.type === connectorType);
      save({
        connectorType,
        connectorInstanceId: dest?.id,
      });
    }
  }, [destinations, save]);

  const handleListChange = useCallback((sourceListId: string) => {
    const list = sourceLists.find(sl => sl.sourceId === sourceListId);
    save({
      ...destination,
      sourceListId,
      sourceListName: list?.name,
    });
  }, [destination, sourceLists, save]);

  if (loading) {
    return (
      <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
          <span className="text-sm text-[var(--text-muted)]">Loading…</span>
        </div>
      </div>
    );
  }

  const connectorOptions = [
    { value: 'local', label: 'Local' },
    ...destinations.map(d => ({ value: d.type, label: d.name })),
  ];

  const listsForConnector = sourceLists.filter(sl => sl.connectorType === destination.connectorType);

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <MapPin size={18} className="text-[var(--text-muted)]" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Default Capture Location</h3>
        {saving && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
      </div>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        Where Quick Capture and Quick Add create new tasks by default. You can always override per-task.
      </p>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[160px]">
          <label className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1 block">Destination</label>
          <Select value={destination.connectorType} onValueChange={handleConnectorChange}>
            <SelectTrigger
              aria-label="Destination"
              className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 text-sm"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {connectorOptions.map(opt => (
                <SelectItem key={opt.value} value={opt.value}>
                  <div className="flex items-center gap-2">
                    <ConnectorIcon type={opt.value} size={14} />
                    {opt.label}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {destination.connectorType !== 'local' && listsForConnector.length > 0 && (
          <div className="flex-1 min-w-[160px]">
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1 block">List</label>
            <Select value={destination.sourceListId || ''} onValueChange={handleListChange}>
              <SelectTrigger className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 text-sm">
                <SelectValue placeholder="Select a list…" />
              </SelectTrigger>
              <SelectContent>
                {listsForConnector.map(sl => (
                  <SelectItem key={sl.sourceId} value={sl.sourceId}>
                    {sl.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Inbox Lists Settings ───────────────────────────────────────────────────

interface InboxListEntry {
  connectorType: string;
  sourceListId?: string;
  sourceListName?: string;
  label?: string;
}

export function InboxListsSection() {
  const [lists, setLists] = useState<InboxListEntry[]>([]);
  const [sourceLists, setSourceLists] = useState<Array<{ sourceId: string; name: string; connectorType: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [newConnector, setNewConnector] = useState('');
  const [newListId, setNewListId] = useState('');
  const [connectors, setConnectors] = useState<Array<{ type: string; name: string }>>([]);

  useEffect(() => {
    Promise.all([
      fetch('/api/settings/inbox-lists').then(r => r.json()),
      fetch('/api/source-lists').then(r => r.ok ? r.json() : { sourceLists: [] }),
      fetch('/api/features').then(r => r.json()),
    ]).then(([inboxData, listsData, featuresData]) => {
      if (inboxData.lists) setLists(inboxData.lists);
      if (listsData.sourceLists) {
        setSourceLists(listsData.sourceLists.map((sl: Record<string, unknown>) => ({
          sourceId: sl.sourceId as string,
          name: sl.name as string,
          connectorType: sl.connectorType as string,
        })));
      }
      if (featuresData.taskDestinations) {
        setConnectors(featuresData.taskDestinations
          .filter((d: Record<string, unknown>) => d.type !== 'local')
          .map((d: Record<string, unknown>) => ({ type: d.type as string, name: d.name as string })));
      }
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const saveLists = useCallback(async (newLists: InboxListEntry[]) => {
    setLists(newLists);
    setSaving(true);
    try {
      await fetch('/api/settings/inbox-lists', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lists: newLists }),
      });
    } catch {
      toast.error('Failed to save inbox lists');
    } finally {
      setSaving(false);
    }
  }, []);

  const removeEntry = useCallback((index: number) => {
    const updated = lists.filter((_, i) => i !== index);
    saveLists(updated);
  }, [lists, saveLists]);

  const addEntry = useCallback(() => {
    if (!newConnector || !newListId) return;
    const list = sourceLists.find(sl => sl.sourceId === newListId);
    const entry: InboxListEntry = {
      connectorType: newConnector,
      sourceListId: newListId,
      sourceListName: list?.name,
      label: list?.name,
    };
    saveLists([...lists, entry]);
    setAdding(false);
    setNewConnector('');
    setNewListId('');
  }, [newConnector, newListId, sourceLists, lists, saveLists]);

  if (loading) {
    return (
      <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
        <div className="flex items-center gap-2">
          <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
          <span className="text-sm text-[var(--text-muted)]">Loading…</span>
        </div>
      </div>
    );
  }

  const listsForNewConnector = sourceLists.filter(sl => sl.connectorType === newConnector);

  return (
    <div className="bg-[var(--surface-2)] rounded-lg border border-[var(--border)] p-5 mt-4">
      <div className="flex items-center gap-2 mb-3">
        <Inbox size={18} className="text-teal-400" />
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Inbox Lists</h3>
        {saving && <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />}
      </div>
      <p className="text-xs text-[var(--text-tertiary)] mb-3">
        Source lists that count as &ldquo;inbox&rdquo; items. Tasks in these lists appear in the Inbox quick filter alongside local captures and tasks tagged &ldquo;needs-triage&rdquo;.
      </p>

      {/* Always-included notice */}
      <div className="mb-3 px-3 py-2 rounded-lg bg-teal-900/10 border border-teal-800/20 text-xs text-teal-300">
        <strong>Always included:</strong> All local tasks + tasks tagged &ldquo;needs-triage&rdquo;
      </div>

      {/* Configured lists */}
      {lists.length > 0 && (
        <div className="space-y-1 mb-3">
          {lists.map((entry, i) => (
            <div key={i} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-0)] border border-[var(--border)]">
              <ConnectorIcon type={entry.connectorType} size={14} />
              <span className="text-sm text-[var(--text-primary)] flex-1">
                {entry.label || entry.sourceListName || entry.connectorType}
              </span>
              <button
                onClick={() => removeEntry(i)}
                className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 transition-colors"
                title="Remove"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Add new */}
      {adding ? (
        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[120px]">
            <label className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1 block">Source</label>
            <Select value={newConnector} onValueChange={(v) => { setNewConnector(v); setNewListId(''); }}>
              <SelectTrigger className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs">
                <SelectValue placeholder="Select source…" />
              </SelectTrigger>
              <SelectContent>
                {connectors.map(c => (
                  <SelectItem key={c.type} value={c.type}>{c.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {newConnector && listsForNewConnector.length > 0 && (
            <div className="flex-1 min-w-[120px]">
              <label className="text-[10px] uppercase tracking-wide text-[var(--text-tertiary)] mb-1 block">List</label>
              <Select value={newListId} onValueChange={setNewListId}>
                <SelectTrigger className="h-8 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 text-xs">
                  <SelectValue placeholder="Select list…" />
                </SelectTrigger>
                <SelectContent>
                  {listsForNewConnector.map(sl => (
                    <SelectItem key={sl.sourceId} value={sl.sourceId}>{sl.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex gap-1">
            <button
              onClick={addEntry}
              disabled={!newConnector || !newListId}
              className="h-8 px-2 rounded-lg bg-teal-600 text-white text-xs font-medium disabled:opacity-50 disabled:cursor-not-allowed hover:bg-teal-500 transition-colors"
            >
              <Check size={12} />
            </button>
            <button
              onClick={() => { setAdding(false); setNewConnector(''); setNewListId(''); }}
              className="h-8 px-2 rounded-lg border border-[var(--border)] text-xs text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <X size={12} />
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setAdding(true)}
          className="flex items-center gap-1.5 text-xs text-teal-400 hover:text-teal-300 transition-colors"
        >
          <Plus size={12} /> Add inbox list
        </button>
      )}
    </div>
  );
}
