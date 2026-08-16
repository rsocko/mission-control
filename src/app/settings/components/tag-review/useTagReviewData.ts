'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { mapTagApiError, tagReviewApi } from './api';
import type { ConnectorInfo, ReviewTag, SourceListInfo } from './types';

export function useTagReviewData() {
  const [allTags, setAllTags] = useState<ReviewTag[]>([]);
  const [sourceTagSlugs, setSourceTagSlugs] = useState<Set<string>>(new Set());
  const [sourceLists, setSourceLists] = useState<SourceListInfo[]>([]);
  const [connectors, setConnectors] = useState<ConnectorInfo[]>([]);
  const [loading, setLoading] = useState(true);

  const refreshTags = useCallback(async () => {
    setLoading(true);
    try {
      const data = await tagReviewApi.load();
      setAllTags(Array.isArray(data.tags) ? data.tags as ReviewTag[] : []);
      setSourceTagSlugs(new Set(
        Array.isArray(data.sourceTagSlugs) ? data.sourceTagSlugs as string[] : [],
      ));
    } catch (error) {
      toast.error(mapTagApiError('load', error));
      setAllTags([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => void refreshTags(), 0);
    return () => window.clearTimeout(timeoutId);
  }, [refreshTags]);

  useEffect(() => {
    void tagReviewApi.connectors()
      .then(data => {
        setSourceLists(Array.isArray(data.sourceLists) ? data.sourceLists as SourceListInfo[] : []);
        setConnectors(Array.isArray(data.connectors) ? data.connectors as ConnectorInfo[] : []);
      })
      .catch(() => undefined);
  }, []);

  const pushableSourceLists = useMemo(() =>
    sourceLists.filter(sourceList => {
      const connector = connectors.find(item => item.id === sourceList.connectorInstanceId);
      return sourceList.selectedForSync !== false && connector?.capabilities?.tagWriteBack;
    }),
  [sourceLists, connectors]);

  return {
    allTags,
    connectors,
    loading,
    pushableSourceLists,
    refreshTags,
    setAllTags,
    sourceLists,
    sourceTagSlugs,
  };
}
