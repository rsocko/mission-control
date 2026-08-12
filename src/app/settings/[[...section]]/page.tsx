'use client';

import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'motion/react';
import {
  Plug, RefreshCw, Tag, FlaskConical, Inbox, Layers,
  FolderTree, Settings2, Brain, Activity, Database, Star, Puzzle, HardDrive, Smartphone, Search, X,
} from 'lucide-react';
import dynamic from 'next/dynamic';

const MobileSettings = dynamic(
  () => import('@/components/settings/MobileSettings').then(mod => mod.MobileSettings),
  {
    ssr: false,
    loading: () => (
      <div className="sm:hidden space-y-4 animate-pulse px-4 pt-4">
        <div className="h-8 w-28 rounded-lg bg-[var(--surface-2)]" />
        <div className="space-y-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 rounded-2xl bg-[var(--surface-1)] border border-[var(--border)]" />
          ))}
        </div>
      </div>
    ),
  },
);
import { ListGroupsSection } from '../components/ListGroupsSection';
import { ConnectorsSection } from '../components/ConnectorsSection';
import { SyncHistorySection } from '../components/SyncHistorySection';
import { TagReviewPanel } from '../components/TagReviewPanel';
import { IntegrationsSection } from '../components/IntegrationsSection';
import { AIProviderSection } from '../components/AIProviderSection';
import { GeneralSettingsSection } from '../components/GeneralSettingsSection';
import { AppModeSection } from '../components/AppModeSection';
import { AddConnectorModal } from '../components/AddConnectorModal';
import { TriageSourcesSection } from '../components/TriageSourcesSection';
import { ContentTypesSection } from '../components/ContentTypesSection';
import { StorageSection } from '../components/StorageSection';
import { DashboardKpiSettings } from '../components/DashboardKpiSettings';
import { ShortcutsSection } from '../components/ShortcutsSection';
import { NotificationEnrichmentSection } from '../components/NotificationEnrichmentSection';
import { RuntimeTelemetrySection } from '../components/RuntimeTelemetrySection';
import { PushNotificationSettings } from '@/components/settings/PushNotificationSettings';
import { PriorityEntitiesPanel } from '@/components/smart-score';
import type { ConnectorConfig, SourceList, ListGroup } from '../components/types';
import { settingsLogger } from '@/lib/client-logger';
import {
  SETTINGS_SECTION_NAMES,
  findSettingsTarget,
  searchSettings,
  type SettingsSearchItem,
  type SettingsSection,
  useSettingsUrlTarget,
} from '../settings-search';
import { resolveSourceListRefresh } from '../source-list-renames';

type ActiveSection = SettingsSection;

// Map URL slugs to section IDs
const SLUG_TO_SECTION: Record<string, ActiveSection> = {
  'connectors': 'connectors',
  'sync-history': 'sync',
  'integrations': 'integrations',
  'list-groups': 'listGroups',
  'tags': 'tags',
  'content-types': 'contentTypes',
  'triage-sources': 'triageSources',
  'priority-entities': 'priorityEntities',
  'dashboard': 'dashboard',
  'shortcuts': 'shortcuts',
  'ai-provider': 'ai',
  'storage': 'storage',
  'app-mode': 'mode',
  'general': 'general',
  'notifications': 'notifications',
  'runtime': 'runtime',
};

const SECTION_TO_SLUG: Record<ActiveSection, string> = Object.fromEntries(
  Object.entries(SLUG_TO_SECTION).map(([slug, section]) => [section, slug])
) as Record<ActiveSection, string>;

type NavItem = { id: ActiveSection; icon: React.ComponentType<{ size?: number; className?: string }>; label: string };
type NavGroup = { label: string; items: NavItem[] };

const NAV_GROUPS: NavGroup[] = [
  {
    label: 'Data Sources',
    items: [
      { id: 'connectors', icon: Plug, label: 'Connectors' },
      { id: 'sync', icon: RefreshCw, label: 'Sync History' },
      { id: 'integrations', icon: Puzzle, label: 'Integrations' },
      { id: 'notifications', icon: Inbox, label: 'Notifications' },
    ],
  },
  {
    label: 'Organization',
    items: [
      { id: 'listGroups', icon: FolderTree, label: 'List Groups' },
      { id: 'tags', icon: Tag, label: 'Tags' },
      { id: 'contentTypes', icon: Layers, label: 'Content Types' },
      { id: 'triageSources', icon: Inbox, label: 'Triage Sources' },
      { id: 'priorityEntities', icon: Star, label: 'Priority Entities' },
    ],
  },
  {
    label: 'Appearance',
    items: [
      { id: 'dashboard', icon: Activity, label: 'Dashboard' },
      { id: 'shortcuts', icon: Smartphone, label: 'Taskbar Shortcuts' },
    ],
  },
  {
    label: 'System',
    items: [
      { id: 'ai', icon: Brain, label: 'AI Provider' },
      { id: 'storage', icon: HardDrive, label: 'Storage & Cache' },
      { id: 'runtime', icon: Activity, label: 'Runtime Telemetry' },
      { id: 'mode', icon: FlaskConical, label: 'App Mode' },
      { id: 'general', icon: Settings2, label: 'Other' },
    ],
  },
];

export default function SettingsPage() {
  const params = useParams();
  const router = useRouter();
  const queryClient = useQueryClient();

  // Derive active section from URL path
  const sectionSlug = Array.isArray(params.section) ? params.section[0] : undefined;
  const activeSection: ActiveSection = (sectionSlug && SLUG_TO_SECTION[sectionSlug]) || 'connectors';

  const navigateToSection = useCallback((id: ActiveSection) => {
    router.push(`/settings/${SECTION_TO_SLUG[id]}`);
  }, [router]);

  const [connectors, setConnectors] = useState<ConnectorConfig[]>([]);
  const [sourceLists, setSourceLists] = useState<SourceList[]>([]);
  const [listGroups, setListGroups] = useState<ListGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAddModal, setShowAddModal] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get('connector');
  });
  const [syncing, setSyncing] = useState<string | null>(null);
  const [settingsQuery, setSettingsQuery] = useState('');
  const [pendingSearchItem, setPendingSearchItem] = useState<SettingsSearchItem | null>(null);

  const [urlSearchTarget, setUrlSearchTarget] = useSettingsUrlTarget();
  const mainContentRef = useRef<HTMLElement | null>(null);
  const settingsResults = searchSettings(settingsQuery);

  const selectSearchResult = useCallback((item: SettingsSearchItem) => {
    setPendingSearchItem(item);
    setSettingsQuery('');
    const target = item.target ?? item.title;
    setUrlSearchTarget(target);
    router.push(`/settings/${SECTION_TO_SLUG[item.section]}?setting=${encodeURIComponent(target)}`);
  }, [router, setUrlSearchTarget]);

  useEffect(() => {
    const selectedSection = pendingSearchItem?.section ?? activeSection;
    const selectedTarget = pendingSearchItem?.target ?? pendingSearchItem?.title ?? urlSearchTarget;
    if (!selectedTarget || selectedSection !== activeSection) return;

    let stopTimeoutId: number | undefined;
    let observer: MutationObserver | undefined;
    let fallbackFocused = false;

    const focusElement = (element: HTMLElement) => {
      const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const hadTabIndex = element.hasAttribute('tabindex');
      if (!hadTabIndex) element.tabIndex = -1;
      element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      element.focus({ preventScroll: true });
      if (!reduceMotion) {
        element.animate(
          [
            { outline: '2px solid rgb(59 130 246 / 0.9)', outlineOffset: '6px', backgroundColor: 'rgb(59 130 246 / 0.12)' },
            { outline: '2px solid transparent', outlineOffset: '10px', backgroundColor: 'transparent' },
          ],
          { duration: 1800, easing: 'ease-out' },
        );
      }
      if (!hadTabIndex) {
        element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
      }
    };

    const locateTarget = () => {
      const root = mainContentRef.current;
      if (!root) return false;

      const { target, sectionHeading } = findSettingsTarget(
        root,
        selectedTarget,
        SETTINGS_SECTION_NAMES[selectedSection],
      );

      if (target) {
        focusElement(target);
        observer?.disconnect();
        if (stopTimeoutId !== undefined) window.clearTimeout(stopTimeoutId);
        setPendingSearchItem(null);
        return true;
      }

      if (sectionHeading && !fallbackFocused) {
        focusElement(sectionHeading);
        fallbackFocused = true;
      }

      return false;
    };

    const startTimeoutId = window.setTimeout(() => {
      if (locateTarget()) return;

      const root = mainContentRef.current;
      if (!root) return;

      observer = new MutationObserver(() => {
        locateTarget();
      });
      observer.observe(root, { childList: true, subtree: true });
      stopTimeoutId = window.setTimeout(() => {
        observer?.disconnect();
        setPendingSearchItem(null);
      }, 10_000);
    }, 220);

    return () => {
      window.clearTimeout(startTimeoutId);
      if (stopTimeoutId !== undefined) window.clearTimeout(stopTimeoutId);
      observer?.disconnect();
    };
  }, [activeSection, pendingSearchItem, urlSearchTarget]);

  // Track in-flight renames so fetchData() never overwrites optimistic names
  const pendingRenamesRef = useRef<Map<string, string>>(new Map());
  const sourceListVersionRef = useRef(0);

  const refreshConnectorLists = useCallback(async (connectorId: string) => {
    const startedVersion = sourceListVersionRef.current;
    try {
      const response = await fetch(`/api/connectors/${connectorId}/lists`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const nextLists = Array.isArray(data.sourceLists) ? data.sourceLists as SourceList[] : [];
      setSourceLists((previousLists) => (
        resolveSourceListRefresh(
          [
            ...previousLists.filter(sourceList => sourceList.connectorInstanceId !== connectorId),
            ...nextLists,
          ],
          pendingRenamesRef.current,
          startedVersion,
          sourceListVersionRef.current,
        ) ?? previousLists
      ));
    } catch (error) {
      settingsLogger.error(`Failed to refresh source lists for connector ${connectorId}`, { err: error });
    }
  }, []);

  const fetchData = useCallback(async () => {
    const startedVersion = sourceListVersionRef.current;
    try {
      const [connRes, groupsRes] = await Promise.all([
        fetch('/api/connectors?includeDeleted=true'),
        fetch('/api/list-groups'),
      ]);
      const connData = await connRes.json();
      const groupsData = await groupsRes.json();
      setConnectors(connData.connectors || []);
      // Merge any pending renames on top of fetched data so optimistic updates
      // are never reverted by a concurrent fetch (including worker sync completion).
      const fetchedLists: SourceList[] = connData.sourceLists || [];
      const resolvedLists = resolveSourceListRefresh(
        fetchedLists,
        pendingRenamesRef.current,
        startedVersion,
        sourceListVersionRef.current,
      );
      if (resolvedLists) setSourceLists(resolvedLists);
      setListGroups(groupsData.groups || []);
    } catch (err) {
      settingsLogger.error('Failed to fetch settings', { err });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  async function toggleConnector(id: string, enabled: boolean) {
    setConnectors(prev => prev.map(c => c.id === id ? { ...c, enabled } : c));
    await fetch('/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
  }

  async function deleteConnector(id: string) {
    const connector = connectors.find(c => c.id === id);
    const now = new Date().toISOString();
    setConnectors(prev => prev.map(c => c.id === id ? { ...c, deletedAt: now, enabled: false } : c));
    setSelectedConnector(null);
    await fetch(`/api/connectors?id=${id}`, { method: 'DELETE' });
    const { toast } = await import('sonner');
    toast.success(`"${connector?.name || 'Connector'}" removed. Tasks will be kept for 7 days.`);
  }

  async function restoreConnector(id: string) {
    setConnectors(prev => prev.map(c => c.id === id ? { ...c, deletedAt: null, enabled: true } : c));
    await fetch('/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, deletedAt: null, enabled: true }),
    });
  }

  async function permanentlyDeleteConnector(id: string) {
    setConnectors(prev => prev.filter(c => c.id !== id));
    await fetch(`/api/connectors?id=${id}&permanent=true`, { method: 'DELETE' });
  }

  async function updateConnector(id: string, updates: Partial<ConnectorConfig>) {
    const previous = connectors.find(connector => connector.id === id);
    setConnectors(prev => prev.map(c => c.id === id ? { ...c, ...updates } : c));
    try {
      const response = await fetch('/api/connectors', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...updates }),
      });
      if (response.ok) return;
      const data = await response.json().catch(() => null) as { error?: string } | null;
      throw new Error(data?.error || 'Failed to update connector');
    } catch (error) {
      if (previous) {
        setConnectors(prev => prev.map(connector => connector.id === id ? previous : connector));
      }
      throw error;
    }
  }

  // Optimistically update a source list's name in local state (called by ListGroupsSection after rename)
  // Returns a cleanup function to clear the pending rename guard once the API has committed.
  const handleRenameList = useCallback((sourceListId: string, newName: string) => {
    sourceListVersionRef.current += 1;
    pendingRenamesRef.current.set(sourceListId, newName);
    setSourceLists(prev => prev.map(sl => sl.id === sourceListId ? { ...sl, name: newName } : sl));
    // Invalidate dashboard React Query cache so navigating to Dashboard shows fresh data
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'connectors'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'listGroups'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard', 'tasks'] });
    queryClient.invalidateQueries({ queryKey: ['myDay', 'connectors'] });
    queryClient.invalidateQueries({ queryKey: ['myDay', 'items'] });
    return () => {
      sourceListVersionRef.current += 1;
      pendingRenamesRef.current.delete(sourceListId);
    };
  }, [queryClient]);

  async function triggerSync(connectorId?: string, options?: { full?: boolean }) {
    const syncTarget = connectorId || 'all';
    setSyncing(syncTarget);
    try {
      const response = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(connectorId ? { connectorId } : {}),
          ...(options?.full ? { full: true } : {}),
        }),
      });
      if (!response.ok) throw new Error(`Sync failed with HTTP ${response.status}`);
      await fetchData();
      if (connectorId) await refreshConnectorLists(connectorId);
    } catch (error) {
      settingsLogger.error('Failed to trigger sync', { err: error });
    } finally {
      setSyncing(null);
    }
  }

  async function createListGroup(name: string, icon?: string, iconColor?: string) {
    const response = await fetch('/api/list-groups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, icon, iconColor }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to create group (${response.status})`);
    }
    await fetchData();
  }

  async function updateListGroup(id: string, updates: Partial<ListGroup>) {
    const response = await fetch(`/api/list-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(`Failed to update group (${response.status})`);
    await fetchData();
  }

  async function deleteListGroup(id: string) {
    const response = await fetch(`/api/list-groups/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to delete group (${response.status})`);
    await fetchData();
  }

  async function assignSourceListToGroup(id: string, groupId: string | null) {
    const response = await fetch(`/api/source-lists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    if (!response.ok) throw new Error(`Failed to update source list (${response.status})`);
    await fetchData();
  }

  return (
    <>
    {/* Mobile settings view (F-99, F-100, F-101) */}
    <MobileSettings />

    {/* Desktop settings view */}
    <div className="hidden sm:flex h-full">
      {/* Settings Sidebar */}
      <aside className="w-56 bg-[var(--surface-1)] border-r border-[var(--border)] p-4 overflow-y-auto flex-shrink-0">
        <div className="relative mb-4">
          <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
          <input
            type="search"
            value={settingsQuery}
            onChange={event => setSettingsQuery(event.target.value)}
            placeholder="Find a setting..."
            aria-label="Search settings"
            className="h-9 w-full rounded-md border border-[var(--border)] bg-[var(--surface-0)] pl-9 pr-8 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-blue-500/60 focus:ring-2 focus:ring-blue-500/20"
          />
          {settingsQuery && (
            <button
              type="button"
              onClick={() => setSettingsQuery('')}
              aria-label="Clear settings search"
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <X size={12} />
            </button>
          )}
        </div>

        {settingsQuery.trim() ? (
          <div aria-live="polite">
            <h4 className="mb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">
              {settingsResults.length} {settingsResults.length === 1 ? 'result' : 'results'}
            </h4>
            {settingsResults.length > 0 ? (
              <div className="space-y-0.5">
                {settingsResults.map(item => (
                  <button
                    type="button"
                    key={`${item.section}-${item.title}`}
                    onClick={() => selectSearchResult(item)}
                    className="w-full rounded-md px-3 py-2 text-left transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
                  >
                    <span className="block text-sm text-[var(--text-primary)]">{item.title}</span>
                    <span className="block text-[11px] text-[var(--text-muted)]">
                      {item.sectionLabel} · {SETTINGS_SECTION_NAMES[item.section]}
                    </span>
                    {item.description && (
                      <span className="mt-0.5 block text-[11px] leading-4 text-[var(--text-tertiary)]">
                        {item.description}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            ) : (
              <p className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
                No settings match “{settingsQuery.trim()}”
              </p>
            )}
          </div>
        ) : (
          <>
          <nav className="space-y-4">
            {NAV_GROUPS.map((group) => (
            <div key={group.label}>
              <h4 className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-1 px-3">
                {group.label}
              </h4>
              <div className="space-y-0.5">
                {group.items.map(item => {
                  const Icon = item.icon;
                  return (
                    <div key={item.id} onClick={() => navigateToSection(item.id)}
                      className={`flex items-center gap-2.5 px-3 py-2 text-sm rounded-md cursor-pointer transition-colors ${
                        activeSection === item.id
                          ? 'font-medium text-blue-300 bg-blue-900/30'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                      }`}>
                      <Icon size={16} className={activeSection === item.id ? 'text-blue-400' : 'text-[var(--text-muted)]'} />
                      <span>{item.label}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            ))}
          </nav>

          <div className="mt-6 pt-4 border-t border-[var(--border)]">
          <h4 className="text-[11px] font-semibold text-[var(--text-tertiary)] uppercase tracking-wider mb-1 px-3">Quick Actions</h4>
          <button onClick={() => triggerSync()} disabled={syncing === 'all'}
            className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] rounded-md disabled:opacity-50">
            <RefreshCw size={14} className={syncing === 'all' ? 'animate-spin text-blue-400' : 'text-[var(--text-muted)]'} />
            {syncing === 'all' ? 'Syncing...' : 'Sync All Now'}
          </button>
          <button onClick={() => triggerSync(undefined, { full: true })} disabled={syncing === 'all'}
            className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded-md disabled:opacity-50">
            <RefreshCw size={14} className="text-[var(--text-muted)]" />
            Force Full Sync
          </button>
          <button className="w-full text-left flex items-center gap-2.5 px-3 py-2 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] rounded-md">
            <Database size={14} className="text-[var(--text-muted)]" />
            Export Data
          </button>
          </div>
          </>
        )}
      </aside>

      {/* Main Content */}
      <main ref={mainContentRef} className={`flex-1 p-6 ${activeSection === 'tags' ? 'overflow-hidden' : 'overflow-y-auto'}`}>
        <div className={`${
          activeSection === 'tags'
            ? 'h-full min-h-0 w-full'
            : activeSection === 'listGroups'
              ? 'max-w-7xl'
              : 'max-w-4xl'
        }`}>
          <AnimatePresence mode="wait">
            {activeSection === 'dashboard' && (
              <motion.div key="dashboard" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <DashboardKpiSettings />
              </motion.div>
            )}
            {activeSection === 'general' && (
              <motion.div key="general" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <GeneralSettingsSection />
              </motion.div>
            )}
            {activeSection === 'connectors' && (
              <motion.div key="connectors" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <ConnectorsSection
                  connectors={connectors.filter(c => !c.deletedAt)}
                  sourceLists={sourceLists}
                  loading={loading}
                  syncing={syncing}
                  onToggle={toggleConnector}
                  onSync={triggerSync}
                  onDelete={deleteConnector}
                  onUpdate={updateConnector}
                  onAdd={() => setShowAddModal(true)}
                  selectedConnector={selectedConnector}
                  onSelect={setSelectedConnector}
                  deletedConnectors={connectors.filter(c => c.deletedAt)}
                  onRestore={restoreConnector}
                  onPermanentDelete={permanentlyDeleteConnector}
                />
              </motion.div>
            )}
            {activeSection === 'sync' && (
              <motion.div key="sync" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <SyncHistorySection connectors={connectors} />
              </motion.div>
            )}
            {activeSection === 'priorityEntities' && (
              <motion.div key="priority-entities" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <PriorityEntitiesPanel />
              </motion.div>
            )}
            {activeSection === 'listGroups' && (
              <motion.div key="list-groups" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <ListGroupsSection
                  connectors={connectors}
                  sourceLists={sourceLists}
                  listGroups={listGroups}
                  loading={loading}
                  onCreateGroup={createListGroup}
                  onUpdateGroup={updateListGroup}
                  onDeleteGroup={deleteListGroup}
                  onAssignList={assignSourceListToGroup}
                  onRefresh={fetchData}
                  onRenameList={handleRenameList}
                />
              </motion.div>
            )}
            {activeSection === 'integrations' && (
              <motion.div key="integrations" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <IntegrationsSection />
              </motion.div>
            )}
            {activeSection === 'triageSources' && (
              <motion.div key="triageSources" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <TriageSourcesSection />
              </motion.div>
            )}
            {activeSection === 'contentTypes' && (
              <motion.div key="contentTypes" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <ContentTypesSection />
              </motion.div>
            )}
            {activeSection === 'notifications' && (
              <motion.div key="notifications" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <NotificationEnrichmentSection />
                <div className="mt-8">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)] mb-4">Push Notifications</h2>
                  <PushNotificationSettings />
                </div>
              </motion.div>
            )}
            {activeSection === 'storage' && (
              <motion.div key="storage" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <StorageSection />
              </motion.div>
            )}
            {activeSection === 'runtime' && (
              <motion.div key="runtime" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <RuntimeTelemetrySection />
              </motion.div>
            )}
            {activeSection === 'shortcuts' && (
              <motion.div key="shortcuts" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <ShortcutsSection />
              </motion.div>
            )}
            {activeSection === 'tags' && (
              <motion.div className="h-full min-h-0" key="tags" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <TagReviewPanel />
              </motion.div>
            )}
            {activeSection === 'ai' && (
              <motion.div key="ai" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <AIProviderSection />
              </motion.div>
            )}
            {activeSection === 'mode' && (
              <motion.div key="mode" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.2 }}>
                <AppModeSection />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </main>

      {/* Add Connector Modal */}
      <AnimatePresence>
        {showAddModal && (
          <AddConnectorModal
            onClose={() => setShowAddModal(false)}
            onAdded={() => { setShowAddModal(false); fetchData(); }}
          />
        )}
      </AnimatePresence>
    </div>
    </>
  );
}
