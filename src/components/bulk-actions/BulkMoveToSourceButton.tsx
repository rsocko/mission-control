'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ArrowLeftRight, CheckCircle2, Loader2, Search, X } from 'lucide-react';
import Image from 'next/image';
import { toast } from 'sonner';
import { executeTaskMove } from '@/lib/api/tasks';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { getConnectorDisplayName } from '@/lib/connectors/display-name';

const CONNECTOR_ICONS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
};

interface WritableConnector {
  id: string;
  type: string;
  name: string;
}

interface TargetList {
  id: string;
  name: string;
  sourceId: string;
}

interface BulkMoveToSourceButtonProps {
  /** IDs of the currently selected tasks */
  selectedTaskIds: string[];
  /** Called after execution completes (success or partial) so parent can refresh */
  onComplete: () => void;
}

/**
 * Bulk action button that opens a dialog for cross-source move of multiple tasks.
 * Allows selecting a target connector and list, then executes the move for all selected tasks.
 */
export function BulkMoveToSourceButton({ selectedTaskIds, onComplete }: BulkMoveToSourceButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [connectors, setConnectors] = useState<WritableConnector[]>([]);
  const [loadingConnectors, setLoadingConnectors] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<WritableConnector | null>(null);
  const [targetLists, setTargetLists] = useState<TargetList[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [selectedListId, setSelectedListId] = useState('');
  const [search, setSearch] = useState('');
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const dialogRef = useRef<HTMLDivElement>(null);

  // Fetch writable connectors when dialog opens
  useEffect(() => {
    if (!dialogOpen) return;
    setLoadingConnectors(true);
    fetch('/api/connectors')
      .then((r) => r.json())
      .then((data: { connectors?: Array<{ id: string; type: string; name: string; capabilities: Record<string, unknown> }> }) => {
        const writable = (data.connectors || []).filter((c) => c.capabilities?.taskCreate);
        setConnectors(writable.map((c) => ({ id: c.id, type: c.type, name: c.name })));
      })
      .catch(() => setConnectors([]))
      .finally(() => setLoadingConnectors(false));
  }, [dialogOpen]);

  // Fetch target lists when connector is selected
  const fetchTargetLists = useCallback(async (connector: WritableConnector) => {
    setLoadingLists(true);
    setTargetLists([]);
    try {
      const res = await fetch(`/api/connectors/${connector.id}/lists`);
      const data = await res.json();
      setTargetLists(
        (data.sourceLists || []).map((l: { id: string; name: string; sourceId: string }) => ({
          id: l.id,
          name: l.name,
          sourceId: l.sourceId,
        })),
      );
    } catch {
      setTargetLists([]);
    } finally {
      setLoadingLists(false);
    }
  }, []);

  function handleOpen() {
    setDialogOpen(true);
    setSelectedConnector(null);
    setSelectedListId('');
    setTargetLists([]);
    setSearch('');
    setExecuting(false);
    setProgress({ done: 0, total: 0 });
  }

  function handleClose() {
    if (executing) return;
    setDialogOpen(false);
  }

  function handleConnectorSelect(connector: WritableConnector) {
    setSelectedConnector(connector);
    setSelectedListId('');
    setSearch('');
    fetchTargetLists(connector);
  }

  async function handleExecute() {
    if (!selectedConnector || !selectedListId) return;
    setExecuting(true);
    const total = selectedTaskIds.length;
    setProgress({ done: 0, total });

    const failed: string[] = [];
    for (let i = 0; i < selectedTaskIds.length; i++) {
      try {
        await executeTaskMove({
          taskId: selectedTaskIds[i],
          targetConnectorInstanceId: selectedConnector.id,
          targetSourceListId: selectedListId,
          sourceAction: 'move',
          subtaskStrategy: 'move-as-subtasks',
          addCrossReference: true,
        });
      } catch {
        failed.push(selectedTaskIds[i]);
      }
      setProgress({ done: i + 1, total });
    }

    setExecuting(false);
    setDialogOpen(false);

    if (failed.length === 0) {
      toast.success(`Moved ${total} task${total > 1 ? 's' : ''} to ${selectedConnector.name}`);
    } else if (failed.length === total) {
      toast.error(`All ${total} moves failed`);
    } else {
      toast.warning(`${total - failed.length} moved, ${failed.length} failed`);
    }

    onComplete();
  }

  const filteredLists = search
    ? targetLists.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : targetLists;

  return (
    <>
      <button
        onClick={handleOpen}
        className="text-xs px-2 py-1 bg-indigo-900/30 text-indigo-300 border border-indigo-800/40 rounded-[var(--radius-sm)] hover:bg-indigo-900/50 transition-colors duration-100 flex items-center gap-1"
      >
        <ArrowLeftRight size={11} />
        Move to source
      </button>

      {dialogOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div
            ref={dialogRef}
            className="relative w-full max-w-md bg-[var(--surface-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden"
          >
            {/* Header */}
            <div className="flex items-start justify-between p-5 border-b border-[var(--border-subtle)]">
              <div className="flex-1 min-w-0">
                <p className="text-xs text-[var(--text-muted)] mb-0.5">Move to source</p>
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">
                  {selectedTaskIds.length} task{selectedTaskIds.length > 1 ? 's' : ''} selected
                </h2>
              </div>
              <button
                onClick={handleClose}
                disabled={executing}
                className="ml-3 p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
              >
                <X size={16} />
              </button>
            </div>

            {/* Content */}
            <div className="p-5 space-y-3">
              {loadingConnectors ? (
                <div className="flex items-center gap-2 py-6 justify-center">
                  <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
                  <span className="text-xs text-[var(--text-muted)]">Loading connectors…</span>
                </div>
              ) : connectors.length === 0 ? (
                <div className="text-sm text-[var(--text-muted)] text-center py-6">
                  No writable connectors configured.
                </div>
              ) : (
                <>
                  <p className="text-xs text-[var(--text-muted)]">Choose a destination connector and list.</p>
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {connectors.map((connector) => {
                      const isSelected = selectedConnector?.id === connector.id;
                      const icon = CONNECTOR_ICONS[connector.type];
                      return (
                        <div key={connector.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                          <button
                            onClick={() => handleConnectorSelect(connector)}
                            disabled={executing}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                              isSelected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                            }`}
                          >
                            {icon ? (
                              <Image src={icon} alt={connector.type} width={16} height={16} className="shrink-0" />
                            ) : (
                              <div className="w-4 h-4 shrink-0 bg-[var(--surface-3)] rounded" />
                            )}
                            <span className="text-sm font-medium text-[var(--text-primary)]">{getConnectorDisplayName(connector)}</span>
                            {isSelected && <CheckCircle2 size={14} className="ml-auto text-emerald-400" />}
                          </button>

                          {/* List picker */}
                          {isSelected && loadingLists && (
                            <div className="px-4 py-2 border-t border-[var(--border-subtle)] flex items-center gap-2">
                              <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />
                              <span className="text-xs text-[var(--text-muted)]">Loading lists…</span>
                            </div>
                          )}

                          {isSelected && !loadingLists && targetLists.length > 0 && (
                            <div className="border-t border-[var(--border-subtle)]">
                              {targetLists.length > 5 && (
                                <div className="px-3 pt-2 pb-1">
                                  <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                                    <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                                    <input
                                      type="text"
                                      value={search}
                                      onChange={(e) => setSearch(e.target.value)}
                                      placeholder="Search lists…"
                                      className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                                      autoFocus
                                    />
                                  </div>
                                </div>
                              )}
                              <div>
                                {filteredLists.map((list) => (
                                  <button
                                    key={list.sourceId}
                                    onClick={() => setSelectedListId(list.sourceId)}
                                    disabled={executing}
                                    className={`w-full text-left flex items-center gap-2 pl-8 pr-3 py-2 text-xs transition-colors ${
                                      selectedListId === list.sourceId
                                        ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
                                        : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
                                    }`}
                                  >
                                    <span className="truncate">{list.name}</span>
                                    {selectedListId === list.sourceId && (
                                      <CheckCircle2 size={12} className="ml-auto shrink-0" />
                                    )}
                                  </button>
                                ))}
                                {filteredLists.length === 0 && (
                                  <p className="px-8 py-2 text-xs text-[var(--text-muted)]">No lists found</p>
                                )}
                              </div>
                            </div>
                          )}

                          {isSelected && !loadingLists && targetLists.length === 0 && (
                            <p className="px-8 py-2 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                              No lists available.
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* Progress bar during execution */}
              {executing && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                    <span>Moving tasks…</span>
                    <span>{progress.done}/{progress.total}</span>
                  </div>
                  <div className="h-1.5 bg-[var(--surface-3)] rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all duration-200"
                      style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2 px-5 py-4 border-t border-[var(--border-subtle)]">
              <button
                onClick={handleClose}
                disabled={executing}
                className="text-xs px-3 py-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleExecute}
                disabled={!selectedConnector || !selectedListId || executing}
                className="text-xs px-3 py-1.5 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1.5"
              >
                {executing ? (
                  <>
                    <Loader2 size={12} className="animate-spin" />
                    Moving…
                  </>
                ) : (
                  <>
                    <ArrowLeftRight size={12} />
                    Move {selectedTaskIds.length} task{selectedTaskIds.length > 1 ? 's' : ''}
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
