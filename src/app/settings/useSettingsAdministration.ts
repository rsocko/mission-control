'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { settingsLogger } from '@/lib/client-logger';
import { loadConnectorData, requestConnectorSync } from '@/lib/connectors/client';
import type { ConnectorConfig, ListGroup, SourceList } from './components/types';
import { resolveSourceListRefresh } from './source-list-renames';

export function useSettingsAdministration() {
  const queryClient = useQueryClient();
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
  const pendingRenamesRef = useRef<Map<string, string>>(new Map());
  const sourceListVersionRef = useRef(0);

  const refreshConnectorLists = useCallback(async (connectorId: string) => {
    const startedVersion = sourceListVersionRef.current;
    try {
      const response = await fetch(`/api/connectors/${connectorId}/lists`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const nextLists = Array.isArray(data.sourceLists) ? data.sourceLists as SourceList[] : [];
      setSourceLists(previousLists => (
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
      const [connectorData, groupsResponse] = await Promise.all([
        loadConnectorData({ includeDeleted: true }),
        fetch('/api/list-groups'),
      ]);
      if (!groupsResponse.ok) throw new Error(`Failed to load list groups (${groupsResponse.status})`);
      const groupsData = await groupsResponse.json();
      setConnectors(connectorData.connectors);
      const resolvedLists = resolveSourceListRefresh(
        connectorData.sourceLists,
        pendingRenamesRef.current,
        startedVersion,
        sourceListVersionRef.current,
      );
      if (resolvedLists) setSourceLists(resolvedLists);
      setListGroups(groupsData.groups || []);
    } catch (error) {
      settingsLogger.error('Failed to fetch settings', { err: error });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      void fetchData();
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [fetchData]);

  const toggleConnector = useCallback(async (id: string, enabled: boolean) => {
    setConnectors(previous => previous.map(connector => (
      connector.id === id ? { ...connector, enabled } : connector
    )));
    await fetch('/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled }),
    });
  }, []);

  const deleteConnector = useCallback(async (id: string) => {
    const connector = connectors.find(candidate => candidate.id === id);
    const deletedAt = new Date().toISOString();
    setConnectors(previous => previous.map(candidate => (
      candidate.id === id ? { ...candidate, deletedAt, enabled: false } : candidate
    )));
    setSelectedConnector(null);
    await fetch(`/api/connectors?id=${id}`, { method: 'DELETE' });
    toast.success(`"${connector?.name || 'Connector'}" removed. Tasks will be kept for 7 days.`);
  }, [connectors]);

  const restoreConnector = useCallback(async (id: string) => {
    setConnectors(previous => previous.map(connector => (
      connector.id === id ? { ...connector, deletedAt: null, enabled: true } : connector
    )));
    await fetch('/api/connectors', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, deletedAt: null, enabled: true }),
    });
  }, []);

  const permanentlyDeleteConnector = useCallback(async (id: string) => {
    setConnectors(previous => previous.filter(connector => connector.id !== id));
    await fetch(`/api/connectors?id=${id}&permanent=true`, { method: 'DELETE' });
  }, []);

  const updateConnector = useCallback(async (id: string, updates: Partial<ConnectorConfig>) => {
    const previous = connectors.find(connector => connector.id === id);
    setConnectors(current => current.map(connector => (
      connector.id === id ? { ...connector, ...updates } : connector
    )));
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
        setConnectors(current => current.map(connector => connector.id === id ? previous : connector));
      }
      throw error;
    }
  }, [connectors]);

  const purgeRetainedSourceList = useCallback(async (connectorId: string, sourceListId: string) => {
    const response = await fetch(
      `/api/connectors/${encodeURIComponent(connectorId)}/retained-lists/${encodeURIComponent(sourceListId)}`,
      { method: 'DELETE' },
    );
    const data = await response.json().catch(() => null) as { error?: string; deletedTasks?: number } | null;
    if (!response.ok) throw new Error(data?.error || 'Failed to delete retained repository items');
    await fetchData();
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      queryClient.invalidateQueries({ queryKey: ['myDay'] }),
    ]);
    toast.success(`${data?.deletedTasks ?? 0} retained item${data?.deletedTasks === 1 ? '' : 's'} deleted from Mission Control`);
  }, [fetchData, queryClient]);

  const handleRenameList = useCallback((sourceListId: string, newName: string) => {
    sourceListVersionRef.current += 1;
    pendingRenamesRef.current.set(sourceListId, newName);
    setSourceLists(previous => previous.map(sourceList => (
      sourceList.id === sourceListId ? { ...sourceList, name: newName } : sourceList
    )));
    for (const queryKey of [
      ['dashboard', 'connectors'],
      ['dashboard', 'listGroups'],
      ['dashboard', 'tasks'],
      ['myDay', 'connectors'],
      ['myDay', 'items'],
    ]) {
      void queryClient.invalidateQueries({ queryKey });
    }
    return () => {
      sourceListVersionRef.current += 1;
      pendingRenamesRef.current.delete(sourceListId);
    };
  }, [queryClient]);

  const triggerSync = useCallback(async (connectorId?: string, options?: { full?: boolean }) => {
    const syncTarget = connectorId || 'all';
    setSyncing(syncTarget);
    try {
      await requestConnectorSync({ connectorId, full: options?.full });
      await fetchData();
      if (connectorId) await refreshConnectorLists(connectorId);
    } catch (error) {
      settingsLogger.error('Failed to trigger sync', { err: error });
    } finally {
      setSyncing(null);
    }
  }, [fetchData, refreshConnectorLists]);

  const createListGroup = useCallback(async (name: string, icon?: string, iconColor?: string) => {
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
  }, [fetchData]);

  const updateListGroup = useCallback(async (id: string, updates: Partial<ListGroup>) => {
    const response = await fetch(`/api/list-groups/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) throw new Error(`Failed to update group (${response.status})`);
    await fetchData();
  }, [fetchData]);

  const deleteListGroup = useCallback(async (id: string) => {
    const response = await fetch(`/api/list-groups/${id}`, { method: 'DELETE' });
    if (!response.ok) throw new Error(`Failed to delete group (${response.status})`);
    await fetchData();
  }, [fetchData]);

  const assignSourceListToGroup = useCallback(async (id: string, groupId: string | null) => {
    const response = await fetch(`/api/source-lists/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId }),
    });
    if (!response.ok) throw new Error(`Failed to update source list (${response.status})`);
    await fetchData();
  }, [fetchData]);

  return {
    connectors,
    sourceLists,
    listGroups,
    loading,
    showAddModal,
    setShowAddModal,
    selectedConnector,
    setSelectedConnector,
    syncing,
    fetchData,
    toggleConnector,
    deleteConnector,
    restoreConnector,
    permanentlyDeleteConnector,
    updateConnector,
    purgeRetainedSourceList,
    handleRenameList,
    triggerSync,
    createListGroup,
    updateListGroup,
    deleteListGroup,
    assignSourceListToGroup,
  };
}
