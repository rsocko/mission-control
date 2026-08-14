'use client';

import { useEffect, useState } from 'react';
import { CONNECTOR_ICON_PATHS, CONNECTOR_LABELS } from '@/lib/constants/colors';
import { kanbanLogger } from '@/lib/client-logger';
import type { SourceItem } from '../components';

interface ConnectorResponseItem {
  id: string;
  type: string;
  name?: string;
  enabled: boolean;
}

interface SourceListResponseItem {
  hidden?: boolean;
  sourceId: string;
  name: string;
  connectorInstanceId: string;
  selectedForSync?: boolean;
}

export function useKanbanSources() {
  const [availableSources, setAvailableSources] = useState<SourceItem[]>([]);
  const [selectedSources, setSelectedSources] = useState<string[]>([]);
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);

  useEffect(() => {
    fetch('/api/connectors')
      .then(r => r.json())
      .then(data => {
        const connectors = ((data.connectors || []) as ConnectorResponseItem[]).filter(c => c.enabled);
        const lists = (data.sourceLists || []) as SourceListResponseItem[];
        const items: SourceItem[] = [];
        const seenTypes = new Set<string>();

        for (const connector of connectors) {
          if (seenTypes.has(connector.type)) continue;
          seenTypes.add(connector.type);
          items.push({
            id: `connector:${connector.type}`,
            name: CONNECTOR_LABELS[connector.type] || connector.name || connector.type,
            icon: CONNECTOR_ICON_PATHS[connector.type] || '',
            type: 'connector',
            connectorType: connector.type,
            connectorInstanceId: connector.id,
          });
        }

        const connectorIds = new Set(connectors.map(connector => connector.id));
        for (const list of lists) {
          if (list.hidden || !connectorIds.has(list.connectorInstanceId)) continue;
          const parentConnector = connectors.find(connector => connector.id === list.connectorInstanceId);
          items.push({
            id: `list:${list.sourceId}`,
            name: list.name,
            icon: parentConnector ? (CONNECTOR_ICON_PATHS[parentConnector.type] || '') : '',
            type: 'list',
            connectorType: parentConnector?.type || '',
            connectorInstanceId: list.connectorInstanceId,
            selectedForSync: list.selectedForSync,
          });
        }

        setAvailableSources(items);
      })
      .catch(err => {
        kanbanLogger.error('Failed to fetch connector capabilities', { err });
      });
  }, []);

  return {
    availableSources,
    selectedSources,
    setSelectedSources,
    showSourceDropdown,
    setShowSourceDropdown,
  };
}
