'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion } from 'motion/react';
import {
  GripVertical, Plus, Trash2, RotateCcw, Loader2, Check, Eye, EyeOff,
  Sun, Inbox, ChartNetwork, LayoutDashboard, Columns3, Target, Repeat,
  CalendarDays, Settings, AppWindow, ExternalLink, Bell, Zap, Activity, Search,
} from 'lucide-react';
import { toast } from 'sonner';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import {
  SHORTCUT_PAGES,
  TASKBAR_SHORTCUT_LIMIT,
  type ShortcutIconKey,
} from '@/lib/navigation/shortcut-catalog';

interface ShortcutConfig {
  id: string;
  name: string;
  url: string;
  description: string;
  icon: string;
  enabled: boolean;
  openInNewWindow?: boolean;
}

type LaunchMode = 'navigate-existing' | 'navigate-new';

const MAX_ENABLED_SHORTCUTS = TASKBAR_SHORTCUT_LIMIT;

import type { ComponentType } from 'react';

const SHORTCUT_ICONS: Record<ShortcutIconKey, ComponentType<{ size?: number; className?: string }>> = {
  dashboard: LayoutDashboard,
  today: Sun,
  projects: ChartNetwork,
  kanban: Columns3,
  goals: Target,
  timeline: CalendarDays,
  notifications: Bell,
  routines: Repeat,
  triage: Inbox,
  'quick-sort': Zap,
  insights: Activity,
  'icon-finder': Search,
  houston: HoustonIcon,
  settings: Settings,
};

export function ShortcutsSection() {
  const [shortcuts, setShortcuts] = useState<ShortcutConfig[]>([]);
  const [launchMode, setLaunchMode] = useState<LaunchMode>('navigate-existing');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  const enabledCount = shortcuts.filter(s => s.enabled).length;
  const atLimit = enabledCount >= MAX_ENABLED_SHORTCUTS;

  const fetchShortcuts = useCallback(async () => {
    try {
      const res = await fetch('/api/settings/shortcuts');
      const data = await res.json();
      setShortcuts(data.shortcuts || []);
      setLaunchMode(data.launchMode || 'navigate-existing');
    } catch {
      toast.error('Failed to load shortcuts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchShortcuts(); }, [fetchShortcuts]);

  async function save() {
    setSaving(true);
    try {
      const res = await fetch('/api/settings/shortcuts', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shortcuts, launchMode }),
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Save failed');
      }
      setDirty(false);
      toast.success('Shortcuts saved! Reinstall or reopen the app for taskbar changes to take effect.');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save shortcuts');
    } finally {
      setSaving(false);
    }
  }

  async function reset() {
    try {
      const res = await fetch('/api/settings/shortcuts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset' }),
      });
      const data = await res.json();
      setShortcuts(data.shortcuts);
      setLaunchMode('navigate-existing');
      setDirty(false);
      toast.success('Shortcuts reset to defaults');
    } catch {
      toast.error('Failed to reset shortcuts');
    }
  }

  function toggleEnabled(id: string) {
    setShortcuts(prev => prev.map(s => {
      if (s.id !== id) return s;
      // Prevent enabling beyond limit
      if (!s.enabled && atLimit) {
        toast.error(`Maximum ${MAX_ENABLED_SHORTCUTS} enabled shortcuts allowed`);
        return s;
      }
      return { ...s, enabled: !s.enabled };
    }));
    setDirty(true);
  }

  function toggleNewWindow(id: string) {
    setShortcuts(prev => prev.map(s => {
      if (s.id !== id) return s;
      return { ...s, openInNewWindow: !s.openInNewWindow };
    }));
    setDirty(true);
  }

  function removeShortcut(id: string) {
    setShortcuts(prev => prev.filter(s => s.id !== id));
    setDirty(true);
  }

  function addShortcut(page: typeof SHORTCUT_PAGES[number]) {
    // New shortcuts are added enabled; check limit
    if (atLimit) {
      toast.error(`Maximum ${MAX_ENABLED_SHORTCUTS} enabled shortcuts. Disable one first or add as hidden.`);
    }
    const newShortcut: ShortcutConfig = {
      id: page.id,
      name: page.name,
      url: page.url,
      description: page.description,
      icon: page.icon,
      enabled: !atLimit, // Auto-disable if at limit
    };
    setShortcuts(prev => [...prev, newShortcut]);
    setDirty(true);
  }

  function handleDragStart(idx: number) {
    setDragIdx(idx);
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === idx) return;
    setShortcuts(prev => {
      const next = [...prev];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(idx, 0, moved);
      return next;
    });
    setDragIdx(idx);
    setDirty(true);
  }

  function handleDragEnd() {
    setDragIdx(null);
  }

  const usedUrls = new Set(shortcuts.map(s => s.url));
  const availableToAdd = SHORTCUT_PAGES.filter(p => !usedUrls.has(p.url));

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-[var(--text-tertiary)]">
        <Loader2 size={16} className="animate-spin" />
        <span className="text-sm">Loading shortcuts...</span>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-xl font-semibold text-[var(--text-primary)]">Taskbar Shortcuts</h2>
        <div className="flex items-center gap-2">
          <button onClick={reset} className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] rounded-md transition-colors">
            <RotateCcw size={12} />
            Reset
          </button>
          <button onClick={save} disabled={!dirty || saving}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed rounded-md transition-colors">
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
            Save
          </button>
        </div>
      </div>
      <p className="text-sm text-[var(--text-tertiary)] mb-4">
        Configure the items that appear in the taskbar right-click menu when the app is pinned.
      </p>

      {/* Enabled count indicator */}
      <div className="flex items-center gap-2 mb-4">
        <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
          atLimit
            ? 'bg-amber-900/40 text-amber-300 border border-amber-700/40'
            : 'bg-[var(--surface-2)] text-[var(--text-tertiary)] border border-[var(--border)]'
        }`}>
          {enabledCount} / {MAX_ENABLED_SHORTCUTS} enabled
        </span>
        {atLimit && (
          <span className="text-xs text-amber-400/70">
            Limit reached — most browsers only show {MAX_ENABLED_SHORTCUTS} shortcuts
          </span>
        )}
      </div>

      {/* Current shortcuts */}
      <div className="space-y-2 mb-6">
        {shortcuts.map((shortcut, idx) => {
          const page = SHORTCUT_PAGES.find(p => p.url === shortcut.url);
          const Icon = page ? SHORTCUT_ICONS[page.iconKey] : LayoutDashboard;
          return (
            <motion.div
              key={shortcut.id}
              layout
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e as unknown as React.DragEvent, idx)}
              onDragEnd={handleDragEnd}
              className={`flex items-center gap-3 px-4 py-3 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg cursor-grab active:cursor-grabbing transition-colors ${
                !shortcut.enabled ? 'opacity-50' : ''
              } ${dragIdx === idx ? 'ring-2 ring-blue-500/40' : ''}`}
            >
              <GripVertical size={14} className="text-[var(--text-muted)] flex-shrink-0" />
              <div className={`w-8 h-8 rounded-md flex items-center justify-center flex-shrink-0 ${page?.iconBackground ?? 'bg-blue-400/15'}`}>
                <Icon size={16} className={page?.iconColor ?? 'text-blue-400'} />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-[var(--text-primary)] truncate">
                  {shortcut.name}
                  {shortcut.openInNewWindow && (
                    <span className="ml-1.5 text-xs text-purple-400">↗</span>
                  )}
                </div>
                <div className="text-xs text-[var(--text-tertiary)] truncate">
                  {shortcut.url}
                  {shortcut.openInNewWindow && (
                    <span className="ml-1 text-purple-400/70">(new window)</span>
                  )}
                </div>
              </div>
              <button onClick={() => toggleNewWindow(shortcut.id)} className="p-1.5 rounded hover:bg-[var(--surface-3)] transition-colors"
                title={shortcut.openInNewWindow ? 'Open in same window' : 'Open in new window'}>
                <ExternalLink size={14} className={shortcut.openInNewWindow ? 'text-purple-400' : 'text-[var(--text-muted)]'} />
              </button>
              <button onClick={() => toggleEnabled(shortcut.id)} className="p-1.5 rounded hover:bg-[var(--surface-3)] transition-colors"
                title={shortcut.enabled ? 'Hide from taskbar' : 'Show in taskbar'}>
                {shortcut.enabled ? <Eye size={14} className="text-green-400" /> : <EyeOff size={14} className="text-[var(--text-muted)]" />}
              </button>
              <button onClick={() => removeShortcut(shortcut.id)} className="p-1.5 rounded hover:bg-red-900/30 transition-colors"
                title="Remove shortcut">
                <Trash2 size={14} className="text-red-400" />
              </button>
            </motion.div>
          );
        })}
        {shortcuts.length === 0 && (
          <div className="text-center py-8 text-sm text-[var(--text-tertiary)]">
            No shortcuts configured. Add pages below.
          </div>
        )}
      </div>

      {/* Add new shortcut */}
      {availableToAdd.length > 0 && (
        <div>
          <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3 flex items-center gap-2">
            <Plus size={14} />
            Add Page
          </h3>
          <div className="grid grid-cols-2 gap-2">
            {availableToAdd.map(page => {
              const Icon = SHORTCUT_ICONS[page.iconKey];
              return (
                <button
                  key={page.url}
                  onClick={() => addShortcut(page)}
                  className="flex items-center gap-2.5 px-3 py-2.5 text-left bg-[var(--surface-1)] border border-[var(--border)] rounded-lg hover:border-blue-500/40 hover:bg-[var(--surface-2)] transition-colors"
                >
                  <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${page.iconBackground}`}>
                    <Icon size={14} className={page.iconColor} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm text-[var(--text-primary)] truncate">{page.name}</div>
                    <div className="text-xs text-[var(--text-tertiary)] truncate">{page.url}</div>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Launch behavior */}
      <div className="mt-6">
        <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Launch Behavior</h3>
        <p className="text-xs text-[var(--text-tertiary)] mb-3">
          When you click a taskbar shortcut and the app is already open, should it reuse the existing window or open a new one?
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={() => { setLaunchMode('navigate-existing'); setDirty(true); }}
            className={`flex items-center gap-2.5 px-3 py-3 text-left rounded-lg border transition-colors ${
              launchMode === 'navigate-existing'
                ? 'bg-blue-600/15 border-blue-500/50 text-blue-300'
                : 'bg-[var(--surface-1)] border-[var(--border)] text-[var(--text-secondary)] hover:border-blue-500/30'
            }`}
          >
            <AppWindow size={16} className="flex-shrink-0" />
            <div>
              <div className="text-sm font-medium">Reuse window</div>
              <div className="text-xs opacity-70">Navigate in existing app window</div>
            </div>
          </button>
          <button
            onClick={() => { setLaunchMode('navigate-new'); setDirty(true); }}
            className={`flex items-center gap-2.5 px-3 py-3 text-left rounded-lg border transition-colors ${
              launchMode === 'navigate-new'
                ? 'bg-blue-600/15 border-blue-500/50 text-blue-300'
                : 'bg-[var(--surface-1)] border-[var(--border)] text-[var(--text-secondary)] hover:border-blue-500/30'
            }`}
          >
            <ExternalLink size={16} className="flex-shrink-0" />
            <div>
              <div className="text-sm font-medium">New window</div>
              <div className="text-xs opacity-70">Always open a new app window</div>
            </div>
          </button>
        </div>
      </div>

      {/* Info note */}
      <div className="mt-6 p-3 bg-blue-950/30 border border-blue-800/30 rounded-lg">
        <p className="text-xs text-blue-300/80">
          <strong>Note:</strong> Changes to taskbar shortcuts require reopening (or reinstalling) the PWA to take effect, as the browser caches the manifest.
        </p>
      </div>
    </div>
  );
}
