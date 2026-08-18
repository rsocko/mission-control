import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import {
  IDEATION_EXPAND_MIN_PROPOSALS,
  getBoundedIdeationContext,
  getIdeationContextVersion,
  normalizeIdeationLabel,
  type IdeationExpansionProposal,
} from '@/lib/graph/ideation-expand';
import type { IdeationNode } from '@/lib/graph/ideation-types';
import { useIdeationStore } from '@/lib/stores/ideationStore';

export interface IdeationExpansionState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  parentId: string | null;
  contextVersion: string;
  proposals: IdeationExpansionProposal[];
  error: string | null;
}

export const EMPTY_IDEATION_EXPANSION: IdeationExpansionState = {
  status: 'idle',
  parentId: null,
  contextVersion: '',
  proposals: [],
  error: null,
};

export function useIdeationExpansion(nodes: IdeationNode[], selected: IdeationNode | null) {
  const acceptProposals = useIdeationStore((state) => state.acceptProposals);
  const [expansion, setExpansion] = useState<IdeationExpansionState>(EMPTY_IDEATION_EXPANSION);
  const requestRef = useRef<{ controller: AbortController; id: number } | null>(null);
  const requestIdRef = useRef(0);
  const currentContextVersion = selected
    ? getIdeationContextVersion(nodes, selected.id)
    : '';

  const clearExpansion = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    requestIdRef.current += 1;
    setExpansion(EMPTY_IDEATION_EXPANSION);
  }, []);

  const expandSelected = useCallback(async () => {
    if (!selected) return;

    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    requestRef.current = { controller, id: requestId };
    const contextVersion = getIdeationContextVersion(nodes, selected.id);
    setExpansion({
      status: 'loading',
      parentId: selected.id,
      contextVersion,
      proposals: [],
      error: null,
    });

    try {
      const response = await fetch('/api/ideation/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          selectedNode: {
            id: selected.id,
            label: selected.label.slice(0, 160),
            kind: selected.kind,
            parentId: selected.parentId,
          },
          contextNodes: getBoundedIdeationContext(nodes, selected.id).map((node) => ({
            ...node,
            label: node.label.slice(0, 160),
          })),
          contextVersion,
        }),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        proposals?: IdeationExpansionProposal[];
        contextVersion?: string;
        selectedNodeId?: string;
      };
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'AI Expand is unavailable while API-key protection is enabled.'
            : result.error ?? 'AI expansion failed',
        );
      }
      if (
        requestIdRef.current !== requestId
        || result.contextVersion !== contextVersion
        || result.selectedNodeId !== selected.id
      ) return;

      const latest = useIdeationStore.getState();
      if (
        latest.selectedNodeId !== selected.id
        || getIdeationContextVersion(latest.nodes, selected.id) !== contextVersion
      ) return;
      if (!result.proposals?.length) throw new Error('AI returned no suggestions');
      const childLabels = new Set(
        latest.nodes
          .filter((node) => node.parentId === selected.id)
          .map((node) => normalizeIdeationLabel(node.label)),
      );
      const proposals = result.proposals.filter(
        (proposal) => !childLabels.has(normalizeIdeationLabel(proposal.label)),
      );
      if (proposals.length < IDEATION_EXPAND_MIN_PROPOSALS) {
        throw new Error('AI returned too many duplicate suggestions. Retry to generate a fresh set.');
      }

      setExpansion({
        status: 'ready',
        parentId: selected.id,
        contextVersion,
        proposals,
        error: null,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestIdRef.current !== requestId) return;
      setExpansion({
        status: 'error',
        parentId: selected.id,
        contextVersion,
        proposals: [],
        error: error instanceof Error ? error.message : 'AI expansion failed',
      });
    } finally {
      if (requestRef.current?.id === requestId) requestRef.current = null;
    }
  }, [nodes, selected]);

  const acceptOne = useCallback((proposalId: string) => {
    if (
      expansion.status !== 'ready'
      || !expansion.parentId
      || expansion.contextVersion !== currentContextVersion
    ) return;
    const proposal = expansion.proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) return;
    const accepted = acceptProposals(expansion.parentId, [{ label: proposal.label }]);
    if (!accepted.length) {
      setExpansion((state) => {
        const proposals = state.proposals.filter((candidate) => candidate.id !== proposalId);
        return proposals.length ? {
          ...state,
          proposals,
          error: 'That suggestion already exists and was dismissed.',
        } : {
          ...EMPTY_IDEATION_EXPANSION,
          status: 'error',
          parentId: state.parentId,
          contextVersion: state.contextVersion,
          error: 'That suggestion already exists and was dismissed.',
        };
      });
      return;
    }
    const remaining = expansion.proposals.filter((candidate) => candidate.id !== proposalId);
    const latest = useIdeationStore.getState();
    setExpansion(remaining.length ? {
      ...expansion,
      contextVersion: getIdeationContextVersion(latest.nodes, expansion.parentId),
      proposals: remaining,
    } : EMPTY_IDEATION_EXPANSION);
  }, [acceptProposals, currentContextVersion, expansion]);

  const acceptAll = useCallback(() => {
    if (
      expansion.status !== 'ready'
      || !expansion.parentId
      || expansion.contextVersion !== currentContextVersion
    ) return;
    const existingLabels = new Set(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === expansion.parentId)
        .map((node) => normalizeIdeationLabel(node.label)),
    );
    const accepted = acceptProposals(
      expansion.parentId,
      expansion.proposals.map((proposal) => ({ label: proposal.label })),
    );
    if (accepted.length !== expansion.proposals.length) {
      const rejected = expansion.proposals.filter(
        (proposal) => existingLabels.has(normalizeIdeationLabel(proposal.label)),
      );
      toast.error(`${rejected.length || expansion.proposals.length - accepted.length} suggestion(s) already existed and were skipped.`);
    }
    setExpansion(EMPTY_IDEATION_EXPANSION);
  }, [acceptProposals, currentContextVersion, expansion]);

  const dismissOne = useCallback((proposalId: string) => {
    setExpansion((state) => {
      const proposals = state.proposals.filter((proposal) => proposal.id !== proposalId);
      return proposals.length ? { ...state, proposals } : EMPTY_IDEATION_EXPANSION;
    });
  }, []);

  useEffect(() => {
    if (
      expansion.status !== 'idle'
      && expansion.contextVersion
      && expansion.contextVersion !== currentContextVersion
    ) {
      const timeout = window.setTimeout(clearExpansion, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [clearExpansion, currentContextVersion, expansion.contextVersion, expansion.status]);

  useEffect(() => () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  return useMemo(() => ({
    expansion,
    clearExpansion,
    expandSelected,
    acceptOne,
    acceptAll,
    dismissOne,
  }), [acceptAll, acceptOne, clearExpansion, dismissOne, expandSelected, expansion]);
}
