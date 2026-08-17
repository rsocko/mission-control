'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CONNECTOR_COLORS } from '@/lib/constants/colors';
import { taskLogger } from '@/lib/client-logger';
import type { QuickAddDestination } from '@/components/add-task/quick-add-types';

export const LOCAL_QUICK_ADD_DESTINATION: QuickAddDestination = {
  id: 'local',
  label: 'Local',
  shortLabel: 'Local',
  connectorType: 'local',
  account: null,
  color: CONNECTOR_COLORS.local,
};

interface QuickAddDestinationContext {
  sourceFilter: string | null;
  listFilter: string | null;
  listFilterName: string | null;
  listFilterConnectorType: string | null;
}

export function findQuickAddContextDestination({
  destinations,
  context,
  defaultDestination,
}: {
  destinations: QuickAddDestination[];
  context: QuickAddDestinationContext;
  defaultDestination: { connectorType: string; sourceListId?: string } | null;
}): QuickAddDestination | undefined {
  if (context.listFilter && context.listFilterConnectorType) {
    return destinations.find(
      (entry) =>
        entry.listId === context.listFilter
        && entry.connectorType === context.listFilterConnectorType,
    ) ?? destinations.find(
      (entry) =>
        entry.connectorType === context.listFilterConnectorType
        && !entry.listId,
    );
  }
  if (context.sourceFilter) {
    return destinations.find(
      (entry) => entry.connectorType === context.sourceFilter && !entry.listId,
    );
  }
  if (!defaultDestination) return undefined;
  return defaultDestination.sourceListId
    ? destinations.find(
        (entry) =>
          entry.connectorType === defaultDestination.connectorType
          && entry.listId === defaultDestination.sourceListId,
      )
    : destinations.find(
        (entry) =>
          entry.connectorType === defaultDestination.connectorType
          && !entry.listId,
      );
}

export function useQuickAddDestinations(context: QuickAddDestinationContext) {
  const {
    sourceFilter,
    listFilter,
    listFilterName,
    listFilterConnectorType,
  } = context;
  const [destinations, setDestinations] = useState<QuickAddDestination[]>([
    LOCAL_QUICK_ADD_DESTINATION,
  ]);
  const [destination, setDestination] = useState<QuickAddDestination>(
    LOCAL_QUICK_ADD_DESTINATION,
  );
  const [isPickerOpen, setPickerOpen] = useState(false);
  const [defaultCaptureDestination, setDefaultCaptureDestination] = useState<{
    connectorType: string;
    sourceListId?: string;
  } | null>(null);
  const userOverrodeDestinationRef = useRef(false);

  const selectDestination = useCallback((
    nextDestination: QuickAddDestination,
    options?: { manual?: boolean },
  ) => {
    setDestination(nextDestination);
    if (options?.manual) userOverrodeDestinationRef.current = true;
  }, []);

  useEffect(() => {
    userOverrodeDestinationRef.current = false;
  }, [sourceFilter, listFilter]);

  useEffect(() => {
    fetch('/api/settings/capture-destination')
      .then((response) => response.json())
      .then((data) => {
        if (data.destination) setDefaultCaptureDestination(data.destination);
      })
      .catch((error) => {
        taskLogger.error('Failed to fetch the default Quick Add destination', { error });
      });
  }, []);

  useEffect(() => {
    let cancelled = false;
    const abortController = new AbortController();

    fetch('/api/features', { signal: abortController.signal })
      .then((response) => response.json())
      .then((data) => {
        if (cancelled) return;
        const taskDestinations = data.taskDestinations as Array<{
          id: string;
          type: string;
          name: string;
          account?: string;
          listSelectionMode?: string;
        }> | undefined;
        if (!taskDestinations?.length) return;

        const dynamicDestinations: QuickAddDestination[] = taskDestinations.map((item) => ({
          id: item.id,
          label: item.name,
          shortLabel: item.name,
          connectorType: item.type,
          account: (item.account as 'personal' | 'work') || null,
          color: CONNECTOR_COLORS[item.type] || 'var(--text-muted)',
          listSelectionMode: item.listSelectionMode as QuickAddDestination['listSelectionMode'],
        }));
        dynamicDestinations.push(LOCAL_QUICK_ADD_DESTINATION);
        setDestinations(dynamicDestinations);
        setDestination((current) =>
          current.id === LOCAL_QUICK_ADD_DESTINATION.id
            ? dynamicDestinations[0]
            : current
        );

        for (const item of taskDestinations) {
          fetch(`/api/connectors/${item.id}/lists`, { signal: abortController.signal })
            .then((response) => response.ok ? response.json() : { sourceLists: [] })
            .then((listData) => {
              if (cancelled) return;
              const lists = (listData.sourceLists || listData.lists || []) as Array<{
                sourceId: string;
                name: string;
                groupId?: string;
              }>;
              const groups = (listData.groups || []) as Array<{
                id: string;
                name: string;
                sortOrder: number;
              }>;
              if (lists.length === 0) return;

              const groupMap = new Map(groups.map((group) => [group.id, group]));
              setDestinations((current) => {
                const existingListIds = new Set(
                  current
                    .filter((entry) => entry.listId)
                    .map((entry) => `${entry.id}-${entry.listId}`),
                );
                const additions: QuickAddDestination[] = lists
                  .map((list) => {
                    const group = list.groupId ? groupMap.get(list.groupId) : undefined;
                    return {
                      id: item.id,
                      label: `${item.name} › ${list.name}`,
                      shortLabel: list.name,
                      connectorType: item.type,
                      account: (item.account as 'personal' | 'work') || null,
                      color: CONNECTOR_COLORS[item.type] || 'var(--text-muted)',
                      listId: list.sourceId,
                      listName: list.name,
                      listSelectionMode: item.listSelectionMode as QuickAddDestination['listSelectionMode'],
                      groupName: group?.name,
                      groupSortOrder: group?.sortOrder,
                    };
                  })
                  .filter((entry) => !existingListIds.has(`${entry.id}-${entry.listId}`));
                return additions.length > 0 ? [...current, ...additions] : current;
              });
            })
            .catch((error) => {
              if (!cancelled && error?.name !== 'AbortError') {
                taskLogger.error('Failed to fetch available lists', { error });
              }
            });
        }
      })
      .catch((error) => {
        if (!cancelled && error?.name !== 'AbortError') {
          taskLogger.error('Failed to fetch connectors for Quick Add', { error });
        }
      });

    return () => {
      cancelled = true;
      abortController.abort();
    };
  }, []);

  useEffect(() => {
    if (userOverrodeDestinationRef.current || destinations.length <= 1) return;
    const nextDestination = findQuickAddContextDestination({
      destinations,
      context: {
        sourceFilter,
        listFilter,
        listFilterName,
        listFilterConnectorType,
      },
      defaultDestination: defaultCaptureDestination,
    });
    if (
      !nextDestination
      || (
        nextDestination.id === destination.id
        && nextDestination.listId === destination.listId
      )
    ) return;

    const frame = requestAnimationFrame(() => setDestination(nextDestination));
    return () => cancelAnimationFrame(frame);
  }, [
    defaultCaptureDestination,
    destination.id,
    destination.connectorType,
    destination.listId,
    destinations,
    listFilter,
    listFilterConnectorType,
    listFilterName,
    sourceFilter,
  ]);

  return {
    destinations,
    destination,
    selectDestination,
    isPickerOpen,
    setPickerOpen,
  };
}
