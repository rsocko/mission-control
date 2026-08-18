'use client';

import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';
import type { ProjectSubgraph } from '@/lib/graph/types';

export type ProjectGraphLoadingStage = 'fetching' | 'layout';

interface ProjectGraphError {
  projectId: string;
  message: string;
}

export interface ProjectStructureGraphData {
  graph: ProjectSubgraph | null;
  graphProjectId: string | null;
  loadingStage: ProjectGraphLoadingStage | null;
  error: string | null;
  truncated: boolean;
  setGraph: Dispatch<SetStateAction<ProjectSubgraph | null>>;
  completeLayout: (projectId: string) => void;
}

export function useProjectStructureGraphData(
  projectId: string,
  refreshKey?: string | number,
): ProjectStructureGraphData {
  const [graph, setGraph] = useState<ProjectSubgraph | null>(null);
  const [graphProjectId, setGraphProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState<{ projectId: string; stage: ProjectGraphLoadingStage } | null>({
    projectId,
    stage: 'fetching',
  });
  const [error, setError] = useState<ProjectGraphError | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(null);

    void fetch(`/api/projects/${projectId}/graph`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as { graph?: ProjectSubgraph; error?: string };
        if (!response.ok || !payload.graph) {
          throw new Error(payload.error || 'Failed to load project graph');
        }
        if (controller.signal.aborted) return;
        setError(null);
        setLoading({ projectId, stage: 'layout' });
        setGraph(payload.graph);
        setGraphProjectId(projectId);
      })
      .catch((caughtError: unknown) => {
        if (
          controller.signal.aborted
          || (caughtError instanceof DOMException && caughtError.name === 'AbortError')
        ) return;
        setError({
          projectId,
          message: caughtError instanceof Error ? caughtError.message : 'Failed to load project graph',
        });
        setLoading({ projectId, stage: 'fetching' });
      });

    return () => controller.abort();
  }, [projectId, refreshKey]);

  const completeLayout = useCallback((completedProjectId: string) => {
    setLoading((current) => current?.projectId === completedProjectId ? null : current);
  }, []);

  return {
    graph,
    graphProjectId,
    loadingStage: loading?.projectId === projectId ? loading.stage : null,
    error: error?.projectId === projectId ? error.message : null,
    truncated: graphProjectId === projectId ? Boolean(graph?.truncated) : false,
    setGraph,
    completeLayout,
  };
}
