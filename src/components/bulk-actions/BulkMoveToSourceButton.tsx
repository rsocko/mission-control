'use client';

import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeftRight,
  ArrowRight,
  CheckCircle2,
  Info,
  Loader2,
  Search,
  Shield,
  X,
} from 'lucide-react';
import Image from 'next/image';
import { toast } from 'sonner';
import {
  executeTaskMove,
  previewTaskMove,
  type MoveFieldMapping,
  type MovePreviewResponse,
} from '@/lib/api/tasks';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';
import { getConnectorDisplayName } from '@/lib/connectors/display-name';

const CONNECTOR_ICONS: Record<string, string> = {
  local: LOCAL_CONNECTOR_ICON_PATH,
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
  selectedTaskIds: string[];
  onComplete: () => void;
}

type Step = 'destination' | 'review' | 'confirm';

const STEP_LABELS: Array<{ id: Step; label: string }> = [
  { id: 'destination', label: 'Destination' },
  { id: 'review', label: 'Review' },
  { id: 'confirm', label: 'Confirm' },
];

const STATUS_PRIORITY: Record<MoveFieldMapping['status'], number> = {
  mapped: 0,
  converted: 1,
  lossy: 2,
  dropped: 3,
};

function formatFieldLabel(field: string) {
  return field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function summarizeMappings(previews: MovePreviewResponse[]) {
  const summaries = new Map<string, {
    field: string;
    status: MoveFieldMapping['status'];
    taskCount: number;
    warnings: Set<string>;
  }>();

  for (const preview of previews) {
    for (const mapping of preview.fieldMappings) {
      const existing = summaries.get(mapping.field);
      if (!existing) {
        summaries.set(mapping.field, {
          field: mapping.field,
          status: mapping.status,
          taskCount: 1,
          warnings: new Set(mapping.warning ? [mapping.warning] : []),
        });
        continue;
      }
      existing.taskCount++;
      if (STATUS_PRIORITY[mapping.status] > STATUS_PRIORITY[existing.status]) {
        existing.status = mapping.status;
      }
      if (mapping.warning) existing.warnings.add(mapping.warning);
    }
  }

  return Array.from(summaries.values());
}

export function BulkMoveToSourceButton({ selectedTaskIds, onComplete }: BulkMoveToSourceButtonProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [step, setStep] = useState<Step>('destination');
  const [connectors, setConnectors] = useState<WritableConnector[]>([]);
  const [loadingConnectors, setLoadingConnectors] = useState(false);
  const [connectorsError, setConnectorsError] = useState<string | null>(null);
  const [selectedConnector, setSelectedConnector] = useState<WritableConnector | null>(null);
  const [targetLists, setTargetLists] = useState<TargetList[]>([]);
  const [loadingLists, setLoadingLists] = useState(false);
  const [listsError, setListsError] = useState<string | null>(null);
  const [selectedListId, setSelectedListId] = useState('');
  const [search, setSearch] = useState('');
  const [previews, setPreviews] = useState<MovePreviewResponse[]>([]);
  const [loadingPreviews, setLoadingPreviews] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const previewRequestId = useRef(0);

  useEffect(() => {
    if (!dialogOpen) return;
    setLoadingConnectors(true);
    setConnectorsError(null);
    fetch('/api/connectors')
      .then(async (response) => {
        if (response.ok === false) throw new Error('Failed to load destination sources');
        return response.json() as Promise<{
          connectors?: Array<{
            id: string;
            type: string;
            name: string;
            capabilities: Record<string, unknown>;
          }>;
        }>;
      })
      .then((data) => {
        const writable = (data.connectors || []).filter((connector) => connector.capabilities?.taskCreate);
        setConnectors(writable.map(({ id, type, name }) => ({ id, type, name })));
      })
      .catch((error: unknown) => {
        setConnectors([]);
        setConnectorsError(error instanceof Error ? error.message : 'Failed to load destination sources');
      })
      .finally(() => setLoadingConnectors(false));
  }, [dialogOpen]);

  useEffect(() => {
    if (!dialogOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !executing) setDialogOpen(false);
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [dialogOpen, executing]);

  async function fetchTargetLists(connector: WritableConnector) {
    setLoadingLists(true);
    setListsError(null);
    setTargetLists([]);
    try {
      const response = await fetch(`/api/connectors/${connector.id}/lists`);
      if (response.ok === false) throw new Error('Failed to load destination lists');
      const data = await response.json() as { sourceLists?: TargetList[] };
      setTargetLists(data.sourceLists ?? []);
    } catch (error) {
      setTargetLists([]);
      setListsError(error instanceof Error ? error.message : 'Failed to load destination lists');
    } finally {
      setLoadingLists(false);
    }
  }

  function handleOpen() {
    setDialogOpen(true);
    setStep('destination');
    setSelectedConnector(null);
    setSelectedListId('');
    setTargetLists([]);
    setSearch('');
    setPreviews([]);
    setPreviewError(null);
    setLoadingPreviews(false);
    setExecuting(false);
    setProgress({ done: 0, total: 0 });
  }

  function handleClose() {
    if (!executing) {
      previewRequestId.current++;
      setDialogOpen(false);
    }
  }

  function handleConnectorSelect(connector: WritableConnector) {
    previewRequestId.current++;
    setSelectedConnector(connector);
    setSelectedListId('');
    setSearch('');
    setPreviews([]);
    setPreviewError(null);
    setLoadingPreviews(false);
    void fetchTargetLists(connector);
  }

  async function handleListSelect(listId: string) {
    if (!selectedConnector) return;
    const requestId = ++previewRequestId.current;
    setSelectedListId(listId);
    setPreviews([]);
    setPreviewError(null);
    setLoadingPreviews(true);
    try {
      const results = await Promise.all(selectedTaskIds.map((taskId) => previewTaskMove({
        taskId,
        targetConnectorInstanceId: selectedConnector.id,
        targetSourceListId: listId,
      })));
      if (requestId === previewRequestId.current) setPreviews(results);
    } catch {
      if (requestId === previewRequestId.current) {
        setPreviewError(
          'At least one selected task cannot move to this destination. Choose another destination or adjust the selection.',
        );
      }
    } finally {
      if (requestId === previewRequestId.current) setLoadingPreviews(false);
    }
  }

  async function handleExecute() {
    if (!selectedConnector || !selectedListId || previews.length !== selectedTaskIds.length) return;
    setExecuting(true);
    const total = selectedTaskIds.length;
    setProgress({ done: 0, total });

    const failed: string[] = [];
    for (let index = 0; index < selectedTaskIds.length; index++) {
      const taskId = selectedTaskIds[index];
      const preview = previews.find((item) => item.task.id === taskId);
      try {
        await executeTaskMove({
          taskId,
          targetConnectorInstanceId: selectedConnector.id,
          targetSourceListId: selectedListId,
          sourceAction: 'move',
          subtaskStrategy: preview?.subtasks?.strategy ?? 'move-as-subtasks',
          addCrossReference: true,
        });
      } catch {
        failed.push(taskId);
      }
      setProgress({ done: index + 1, total });
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
    ? targetLists.filter((list) => list.name.toLowerCase().includes(search.toLowerCase()))
    : targetLists;
  const mappings = summarizeMappings(previews);
  const riskyMappings = mappings.filter(({ status }) => status === 'lossy' || status === 'dropped');
  const convertedMappings = mappings.filter(({ status }) => status === 'converted');
  const totalSubtasks = previews.reduce((sum, preview) => sum + (preview.subtasks?.count ?? 0), 0);
  const nativeTransferCount = previews.filter((preview) => preview.isNativeTransfer).length;
  const destinationName = targetLists.find((list) => list.sourceId === selectedListId)?.name ?? selectedListId;
  const sourceEffects = Array.from(new Set(previews.flatMap((preview) => (
    preview.sourceActions
      .filter(({ action }) => action === 'move')
      .map(({ description }) => description)
  ))));

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
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) handleClose();
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bulk-source-move-title"
            className="relative w-full max-w-lg bg-[var(--surface-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden"
          >
            <div className="flex items-start justify-between p-5 border-b border-[var(--border-subtle)]">
              <div className="flex-1 min-w-0">
                <h2 id="bulk-source-move-title" className="text-sm font-semibold text-[var(--text-primary)]">
                  Move {selectedTaskIds.length} task{selectedTaskIds.length > 1 ? 's' : ''} to another source
                </h2>
                <p className="mt-1 text-xs text-[var(--text-muted)]">
                  Review how task data will be preserved before moving.
                </p>
              </div>
              <button
                onClick={handleClose}
                disabled={executing}
                aria-label="Close move dialog"
                className="ml-3 p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-50"
              >
                <X size={16} />
              </button>
            </div>

            <div className="flex items-center gap-1.5 px-5 py-3 border-b border-[var(--border-subtle)]">
              {STEP_LABELS.map(({ id, label }, index) => {
                const activeIndex = STEP_LABELS.findIndex(({ id: stepId }) => stepId === step);
                const isActive = id === step;
                const isDone = index < activeIndex;
                return (
                  <div key={id} className="flex items-center gap-1.5">
                    {index > 0 && <ArrowRight size={11} className="text-[var(--text-muted)]" />}
                    <button
                      onClick={() => {
                        if (isDone) setStep(id);
                      }}
                      disabled={!isDone && !isActive}
                      className={`text-xs px-2 py-0.5 rounded transition-colors ${
                        isActive
                          ? 'text-[var(--text-primary)] font-medium bg-[var(--surface-2)]'
                          : isDone
                            ? 'text-[var(--accent)] hover:underline'
                            : 'text-[var(--text-muted)]'
                      }`}
                    >
                      {label}
                    </button>
                  </div>
                );
              })}
            </div>

            <div className="p-5">
              {step === 'destination' && (
                <div className="space-y-3">
                  <p className="text-xs text-[var(--text-muted)]">Choose a destination source and list.</p>
                  {loadingConnectors ? (
                    <LoadingMessage label="Loading sources..." />
                  ) : connectorsError ? (
                    <ErrorMessage>{connectorsError}</ErrorMessage>
                  ) : connectors.length === 0 ? (
                    <p className="text-sm text-[var(--text-muted)] text-center py-6">
                      No writable connectors configured.
                    </p>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto">
                      {connectors.map((connector) => {
                        const isSelected = selectedConnector?.id === connector.id;
                        const icon = CONNECTOR_ICONS[connector.type];
                        return (
                          <div key={connector.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                            <button
                              onClick={() => handleConnectorSelect(connector)}
                              className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                                isSelected ? 'bg-[var(--surface-2)]' : 'hover:bg-[var(--surface-2)]'
                              }`}
                            >
                              {icon ? (
                                <Image src={icon} alt="" width={16} height={16} className="shrink-0" />
                              ) : (
                                <span className="w-4 h-4 shrink-0 bg-[var(--surface-3)] rounded" />
                              )}
                              <span className="text-sm font-medium text-[var(--text-primary)]">
                                {getConnectorDisplayName(connector)}
                              </span>
                              {isSelected && <CheckCircle2 size={14} className="ml-auto text-emerald-400" />}
                            </button>

                            {isSelected && loadingLists && (
                              <div className="border-t border-[var(--border-subtle)]">
                                <LoadingMessage label="Loading lists..." compact />
                              </div>
                            )}
                            {isSelected && listsError && (
                              <div className="border-t border-[var(--border-subtle)] px-3 py-2">
                                <ErrorMessage>{listsError}</ErrorMessage>
                              </div>
                            )}
                            {isSelected && !loadingLists && !listsError && targetLists.length > 0 && (
                              <div className="border-t border-[var(--border-subtle)]">
                                {targetLists.length > 5 && (
                                  <div className="px-3 pt-2 pb-1">
                                    <label className="input-glow flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                                      <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                                      <span className="sr-only">Search destination lists</span>
                                      <input
                                        type="text"
                                        value={search}
                                        onChange={(event) => setSearch(event.target.value)}
                                        placeholder="Search lists..."
                                        className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                                        autoFocus
                                      />
                                    </label>
                                  </div>
                                )}
                                {filteredLists.map((list) => (
                                  <button
                                    key={list.sourceId}
                                    onClick={() => void handleListSelect(list.sourceId)}
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
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {loadingPreviews && <LoadingMessage label={`Checking ${selectedTaskIds.length} tasks...`} />}
                  {previewError && <ErrorMessage>{previewError}</ErrorMessage>}
                  <button
                    onClick={() => setStep('review')}
                    disabled={previews.length !== selectedTaskIds.length || loadingPreviews}
                    className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all"
                  >
                    Review migration details
                    <ArrowRight size={14} />
                  </button>
                </div>
              )}

              {step === 'review' && (
                <div className="space-y-3">
                  <p className="text-xs text-[var(--text-muted)]">
                    Combined migration preview for {selectedTaskIds.length} selected tasks.
                  </p>

                  {riskyMappings.length > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/40 border border-rose-700/50 text-rose-300">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <div>
                        <p className="text-xs font-semibold">Data loss warning</p>
                        <p className="text-xs mt-0.5">
                          {riskyMappings.map(({ field }) => formatFieldLabel(field)).join(', ')} cannot be fully preserved.
                        </p>
                      </div>
                    </div>
                  )}

                  {nativeTransferCount > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-emerald-950/30 border border-emerald-800/30 text-emerald-400">
                      <Shield size={14} className="shrink-0 mt-0.5" />
                      <p className="text-xs">
                        {nativeTransferCount} task{nativeTransferCount === 1 ? '' : 's'} will use a native transfer with source history intact.
                      </p>
                    </div>
                  )}

                  <div className="max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3">
                    {mappings.map((mapping) => (
                      <div
                        key={mapping.field}
                        className="flex items-start gap-2 py-2 border-b border-[var(--border-subtle)] last:border-0"
                      >
                        {mapping.status === 'mapped' ? (
                          <CheckCircle2 size={13} className="mt-0.5 text-emerald-400 shrink-0" />
                        ) : mapping.status === 'converted' ? (
                          <Info size={13} className="mt-0.5 text-sky-400 shrink-0" />
                        ) : (
                          <AlertTriangle size={13} className="mt-0.5 text-rose-400 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-[var(--text-primary)]">
                            {formatFieldLabel(mapping.field)}
                            <span className="ml-1 font-normal text-[var(--text-muted)]">
                              ({mapping.taskCount} task{mapping.taskCount === 1 ? '' : 's'})
                            </span>
                          </p>
                          {Array.from(mapping.warnings).map((warning) => (
                            <p key={warning} className="mt-0.5 text-xs text-[var(--text-muted)]">{warning}</p>
                          ))}
                        </div>
                        <span className="ml-auto text-xs text-[var(--text-muted)]">{mapping.status}</span>
                      </div>
                    ))}
                  </div>

                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-3">
                    <p className="text-xs font-medium text-[var(--text-primary)]">Mission Control data stays connected</p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Projects, schedules, reminders, dependencies, linked sources, planning fields, tags, and attachments remain attached to the moved tasks.
                      {totalSubtasks > 0 ? ` ${totalSubtasks} subtask${totalSubtasks === 1 ? '' : 's'} will also be preserved using the best format supported by the destination.` : ''}
                    </p>
                  </div>

                  {convertedMappings.length > 0 && (
                    <p className="text-xs text-[var(--text-muted)]">
                      Converted fields stay in Mission Control when the destination has no native equivalent.
                    </p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => setStep('destination')}
                      className="flex-1 py-2 rounded-lg text-sm text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => setStep('confirm')}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:brightness-110 transition-all"
                    >
                      Continue
                      <ArrowRight size={14} />
                    </button>
                  </div>
                </div>
              )}

              {step === 'confirm' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-sm font-medium text-[var(--text-primary)]">
                      Move {selectedTaskIds.length} task{selectedTaskIds.length > 1 ? 's' : ''}?
                    </p>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Destination:                       {selectedConnector ? getConnectorDisplayName(selectedConnector) : 'Unknown source'} / {destinationName}
                    </p>
                  </div>

                  {riskyMappings.length > 0 && (
                    <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/40 border border-rose-700/50 text-rose-300">
                      <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                      <p className="text-xs">
                        This move cannot fully preserve {riskyMappings.map(({ field }) => formatFieldLabel(field)).join(', ')}.
                      </p>
                    </div>
                  )}

                  <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3">
                    <p className="text-xs font-medium text-[var(--text-primary)]">What happens to the originals</p>
                    {sourceEffects.map((effect) => (
                      <p key={effect} className="mt-1 text-xs text-[var(--text-muted)]">{effect}</p>
                    ))}
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Each destination task is created and saved before its original is removed or closed.
                    </p>
                  </div>

                  {executing && (
                    <div className="space-y-1.5" aria-live="polite">
                      <div className="flex items-center justify-between text-xs text-[var(--text-muted)]">
                        <span>Moving tasks...</span>
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

                  <div className="flex gap-2">
                    <button
                      onClick={() => setStep('review')}
                      disabled={executing}
                      className="flex-1 py-2 rounded-lg text-sm text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40"
                    >
                      Back
                    </button>
                    <button
                      onClick={() => void handleExecute()}
                      disabled={executing}
                      className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:brightness-110 transition-all disabled:opacity-60"
                    >
                      {executing ? (
                        <>
                          <Loader2 size={13} className="animate-spin" />
                          Moving...
                        </>
                      ) : (
                        <>Move {selectedTaskIds.length} task{selectedTaskIds.length === 1 ? '' : 's'}</>
                      )}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function LoadingMessage({ label, compact = false }: { label: string; compact?: boolean }) {
  return (
    <div className={`flex items-center gap-2 justify-center ${compact ? 'py-2' : 'py-6'}`}>
      <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
    </div>
  );
}

function ErrorMessage({ children }: { children: string }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-rose-800/30 bg-rose-950/30 p-2.5 text-rose-400" role="alert">
      <AlertTriangle size={13} className="mt-0.5 shrink-0" />
      <p className="text-xs">{children}</p>
    </div>
  );
}
