'use client';

import { useState, useEffect, useCallback } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ArrowRight, CheckCircle2, AlertTriangle, Info, X, ChevronRight, Loader2, Shield, Copy, Scissors, Search, ChevronDown } from 'lucide-react';
import Image from 'next/image';
import {
  previewTaskMove,
  executeTaskMove,
  ApiRequestError,
  type MovePreviewResponse,
  type MoveFieldMapping,
} from '@/lib/api/tasks';
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

interface TaskMoveDialogProps {
  taskId: string;
  taskTitle: string;
  sourceConnectorType: string;
  /** Writable connectors (excluding the source's own instance if desired) */
  writableConnectors: WritableConnector[];
  onClose: () => void;
  /** Called after a successful move/copy so the parent can refresh the task list */
  onSuccess: (newTaskId: string, action: 'move' | 'copy') => void;
}

type Step = 'destination' | 'field-mapping' | 'confirm';
type SourceAction = 'move' | 'copy';

function formatFieldLabel(field: string) {
  return field
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (character) => character.toUpperCase());
}

function formatSubtaskStrategy(strategy: NonNullable<MovePreviewResponse['subtasks']>['strategy']) {
  if (strategy === 'preserve-details-and-steps') return 'steps + notes';
  if (strategy === 'move-as-subtasks') return 'native subtasks';
  return 'notes';
}

function FieldMappingRow({ mapping }: { mapping: MoveFieldMapping }) {
  const fieldLabel = formatFieldLabel(mapping.field);
  const showValues =
    mapping.status !== 'mapped' || mapping.sourceValue !== mapping.targetValue;
  const statusIcon =
    mapping.status === 'mapped' ? (
      <CheckCircle2 size={13} className="text-emerald-400 shrink-0" />
    ) : mapping.status === 'converted' ? (
      <Info size={13} className="text-sky-400 shrink-0" />
    ) : mapping.status === 'lossy' ? (
      <AlertTriangle size={13} className="text-amber-400 shrink-0" />
    ) : (
      <AlertTriangle size={13} className="text-rose-400 shrink-0" />
    );

  const statusColor =
    mapping.status === 'mapped'
      ? 'text-emerald-400'
      : mapping.status === 'converted'
      ? 'text-sky-400'
      : mapping.status === 'lossy'
      ? 'text-amber-400'
      : 'text-rose-400';

  return (
    <div className="flex flex-col gap-0.5 py-2 border-b border-[var(--border-subtle)] last:border-0">
      <div className="flex items-center gap-2">
        {statusIcon}
        <span className="text-xs font-medium text-[var(--text-primary)]">{fieldLabel}</span>
        <span className={`text-xs ml-auto ${statusColor}`}>
          {mapping.status === 'dropped' ? 'dropped' : mapping.status}
        </span>
      </div>
      {mapping.warning && (
        <p className="text-xs text-[var(--text-muted)] pl-5">{mapping.warning}</p>
      )}
      {showValues && (
        <div
          className="flex items-center gap-1.5 pl-5 pt-1 text-[11px]"
          aria-label={`${fieldLabel}: ${mapping.sourceValue ?? 'empty'} becomes ${mapping.targetValue ?? 'not preserved'}`}
        >
          <span
            className="max-w-[42%] truncate rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--text-secondary)]"
            title={mapping.sourceValue ?? 'Empty'}
          >
            {mapping.sourceValue ?? 'Empty'}
          </span>
          <ArrowRight size={10} className="shrink-0 text-[var(--text-muted)]" />
          <span
            className={`max-w-[48%] truncate rounded px-1.5 py-0.5 ${
              mapping.targetValue
                ? 'bg-[var(--surface-2)] text-[var(--text-secondary)]'
                : 'bg-rose-950/40 text-rose-300'
            }`}
            title={mapping.targetValue ?? 'Not preserved'}
          >
            {mapping.targetValue ?? 'Not preserved'}
          </span>
        </div>
      )}
    </div>
  );
}

type TargetList = MovePreviewResponse['targetLists'][number];

function TargetListPicker({
  lists,
  search,
  selectedListId,
  unavailableSourceListId,
  onSelect,
}: {
  lists: TargetList[];
  search: string;
  selectedListId: string;
  unavailableSourceListId?: string;
  onSelect: (sourceId: string) => void;
}) {
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());

  const filtered = search
    ? lists.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : lists;

  // Group lists: collect by groupId (null = ungrouped)
  const hasGroups = filtered.some((l) => l.groupId);

  if (!hasGroups) {
    // Flat list — no grouping
    return (
      <div>
        {filtered.length === 0 ? (
          <p className="px-8 py-2 text-xs text-[var(--text-muted)]">No matching lists</p>
        ) : (
          filtered.map((list) => (
            <ListButton
              key={list.id}
              list={list}
              isSelected={selectedListId === list.sourceId}
              isUnavailable={unavailableSourceListId === list.sourceId}
              onSelect={onSelect}
            />
          ))
        )}
      </div>
    );
  }

  // Build ordered groups preserving original list order
  const groups: { key: string; name: string | null; items: TargetList[] }[] = [];
  const groupMap = new Map<string, TargetList[]>();
  const ungrouped: TargetList[] = [];
  const groupOrder: string[] = [];

  for (const list of filtered) {
    const gid = list.groupId ?? null;
    if (!gid) {
      ungrouped.push(list);
    } else {
      if (!groupMap.has(gid)) {
        groupMap.set(gid, []);
        groupOrder.push(gid);
      }
      groupMap.get(gid)!.push(list);
    }
  }

  for (const gid of groupOrder) {
    const items = groupMap.get(gid)!;
    groups.push({ key: gid, name: items[0].groupName ?? null, items });
  }

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div>
      {filtered.length === 0 ? (
        <p className="px-8 py-2 text-xs text-[var(--text-muted)]">No matching lists</p>
      ) : (
        <>
          {/* Ungrouped lists first */}
          {ungrouped.map((list) => (
            <ListButton
              key={list.id}
              list={list}
              isSelected={selectedListId === list.sourceId}
              isUnavailable={unavailableSourceListId === list.sourceId}
              onSelect={onSelect}
            />
          ))}
          {/* Grouped lists */}
          {groups.map((group) => {
            const isCollapsed = collapsedGroups.has(group.key);
            return (
              <div key={group.key}>
                <button
                  onClick={() => toggleGroup(group.key)}
                  className="w-full flex items-center gap-1.5 pl-4 pr-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  <ChevronDown size={10} className={`shrink-0 transition-transform duration-100 ${isCollapsed ? '-rotate-90' : ''}`} />
                  {group.name ?? 'Other'}
                </button>
                {!isCollapsed && group.items.map((list) => (
                  <ListButton
                    key={list.id}
                    list={list}
                    isSelected={selectedListId === list.sourceId}
                    isUnavailable={unavailableSourceListId === list.sourceId}
                    onSelect={onSelect}
                    grouped
                  />
                ))}
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function ListButton({
  list,
  isSelected,
  isUnavailable,
  onSelect,
  grouped,
}: {
  list: TargetList;
  isSelected: boolean;
  isUnavailable: boolean;
  onSelect: (sourceId: string) => void;
  grouped?: boolean;
}) {
  return (
    <button
      onClick={() => onSelect(list.sourceId)}
      disabled={isUnavailable}
      className={`w-full text-left flex items-center gap-2 ${grouped ? 'pl-10' : 'pl-8'} pr-3 py-2 text-xs transition-colors ${
        isUnavailable
          ? 'text-[var(--text-muted)] opacity-60 cursor-not-allowed'
          : isSelected
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'
      }`}
    >
      <span className="truncate">{list.name}</span>
      {isUnavailable && (
        <span className="ml-auto shrink-0 text-[11px]">Current source</span>
      )}
      {isSelected && (
        <CheckCircle2 size={12} className="ml-auto shrink-0" />
      )}
    </button>
  );
}

export function TaskMoveDialog({
  taskId,
  taskTitle,
  sourceConnectorType,
  writableConnectors,
  onClose,
  onSuccess,
}: TaskMoveDialogProps) {
  const [step, setStep] = useState<Step>('destination');
  const [selectedConnector, setSelectedConnector] = useState<WritableConnector | null>(null);
  const [selectedListId, setSelectedListId] = useState<string>('');
  const [preview, setPreview] = useState<MovePreviewResponse | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [sourceAction, setSourceAction] = useState<SourceAction>('move');
  const [executing, setExecuting] = useState(false);
  const [executeError, setExecuteError] = useState<{ message: string; traceId?: string } | null>(null);
  const [listSearch, setListSearch] = useState('');

  // When a connector is chosen, auto-load preview so Step 2 shows quickly
  const loadPreview = useCallback(
    async (connector: WritableConnector, listId?: string) => {
      setLoadingPreview(true);
      setPreviewError(null);
      try {
        const result = await previewTaskMove({
          taskId,
          targetConnectorInstanceId: connector.id,
          targetSourceListId: listId,
        });
        setPreview(result);
        // Apply the suggestion (prefer copy if heuristic says so)
        if (result.suggestion) {
          setSourceAction('copy');
        }
      } catch (err) {
        setPreviewError(err instanceof Error ? err.message : 'Failed to load preview');
      } finally {
        setLoadingPreview(false);
      }
    },
    [taskId],
  );

  // When the user picks a list in Step 1, re-fetch preview
  useEffect(() => {
    if (selectedConnector && selectedListId) {
      loadPreview(selectedConnector, selectedListId);
    }
  }, [selectedConnector, selectedListId, loadPreview]);

  function handleConnectorSelect(connector: WritableConnector) {
    setSelectedConnector(connector);
    setSelectedListId('');
    setListSearch('');
    setPreview(null);
    loadPreview(connector);
  }

  function handleListSelect(listId: string) {
    setSelectedListId(listId);
  }

  async function handleExecute() {
    if (!selectedConnector || !selectedListId) return;
    setExecuting(true);
    setExecuteError(null);
    try {
      const result = await executeTaskMove({
        taskId,
        targetConnectorInstanceId: selectedConnector.id,
        targetSourceListId: selectedListId,
        sourceAction,
        subtaskStrategy: preview?.subtasks?.strategy ?? 'move-as-subtasks',
        addCrossReference: true,
      });
      onSuccess(result.newTaskId, sourceAction);
      onClose();
    } catch (err) {
      setExecuteError({
        message: err instanceof ApiRequestError && err.code === 'SAME_SOURCE_DESTINATION'
          ? 'This task is already in that destination. Choose a different source.'
          : 'Move failed. Please try again.',
        traceId: err instanceof ApiRequestError ? err.traceId : undefined,
      });
      setExecuting(false);
    }
  }

  const canProceedToMapping =
    !!selectedConnector && !!selectedListId && !loadingPreview && !previewError && !!preview;

  const iconSrc = selectedConnector ? CONNECTOR_ICONS[selectedConnector.type] : null;
  const lossyFields = preview?.fieldMappings
    .filter((mapping) => mapping.status === 'lossy' || mapping.status === 'dropped')
    .map((mapping) => formatFieldLabel(mapping.field)) ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <motion.div
        className="relative w-full max-w-md bg-[var(--surface-1)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: 8 }}
        transition={{ duration: 0.18 }}
      >
        {/* Header */}
        <div className="flex items-start justify-between p-5 border-b border-[var(--border-subtle)]">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-[var(--text-muted)] mb-0.5">Moving task</p>
            <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">{taskTitle}</h2>
          </div>
          <button
            onClick={onClose}
            className="ml-3 p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-2)] transition-colors"
          >
            <X size={16} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-1.5 px-5 py-3 border-b border-[var(--border-subtle)]">
          {(['destination', 'field-mapping', 'confirm'] as Step[]).map((s, i) => {
            const labels = ['Destination', 'Field Mapping', 'Confirm'];
            const isActive = step === s;
            const isDone =
              (s === 'destination' && (step === 'field-mapping' || step === 'confirm')) ||
              (s === 'field-mapping' && step === 'confirm');
            return (
              <div key={s} className="flex items-center gap-1.5">
                {i > 0 && <ChevronRight size={12} className="text-[var(--text-muted)]" />}
                <button
                  onClick={() => {
                    if (isDone) setStep(s);
                  }}
                  disabled={!isDone && !isActive}
                  className={`text-xs px-2 py-0.5 rounded transition-colors ${
                    isActive
                      ? 'text-[var(--text-primary)] font-medium bg-[var(--surface-2)]'
                      : isDone
                      ? 'text-[var(--accent)] hover:underline cursor-pointer'
                      : 'text-[var(--text-muted)] cursor-default'
                  }`}
                >
                  {labels[i]}
                </button>
              </div>
            );
          })}
        </div>

        {/* Step content */}
        <div className="p-5">
          <AnimatePresence mode="wait">
            {/* ── Step 1: Destination ─────────────────────────────────────── */}
            {step === 'destination' && (
              <motion.div
                key="destination"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="space-y-3"
              >
                <p className="text-xs text-[var(--text-muted)]">Choose a destination connector and list.</p>

                {writableConnectors.length === 0 ? (
                  <div className="text-sm text-[var(--text-muted)] text-center py-6">
                    No writable connectors configured.
                  </div>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {writableConnectors.map((connector) => {
                      const isSelected = selectedConnector?.id === connector.id;
                      const icon = CONNECTOR_ICONS[connector.type];
                      return (
                        <div key={connector.id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                          <button
                            onClick={() => handleConnectorSelect(connector)}
                            className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-left transition-colors ${
                              isSelected
                                ? 'bg-[var(--surface-2)]'
                                : 'hover:bg-[var(--surface-2)]'
                            }`}
                          >
                            {icon ? (
                              <Image src={icon} alt={connector.type} width={16} height={16} className="shrink-0" />
                            ) : (
                              <div className="w-4 h-4 shrink-0 bg-[var(--surface-3)] rounded" />
                            )}
                            <span className="text-sm font-medium text-[var(--text-primary)]">{getConnectorDisplayName(connector)}</span>
                            {isSelected && (
                              <CheckCircle2 size={14} className="ml-auto text-emerald-400" />
                            )}
                          </button>

                          {/* List picker (only shown for the selected connector) */}
                          {isSelected && loadingPreview && !preview && (
                            <div className="px-4 py-2 border-t border-[var(--border-subtle)] flex items-center gap-2">
                              <Loader2 size={12} className="animate-spin text-[var(--text-muted)]" />
                              <span className="text-xs text-[var(--text-muted)]">Loading lists…</span>
                            </div>
                          )}

                          {isSelected && preview && preview.targetLists.length > 0 && (
                            <div className="border-t border-[var(--border-subtle)]">
                              {/* Search input (shown when 6+ lists) */}
                              {preview.targetLists.length >= 6 && (
                                <div className="px-3 py-1.5 border-b border-[var(--border-subtle)]">
                                  <div className="input-glow flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                                    <Search size={11} className="shrink-0 text-[var(--text-muted)]" />
                                    <input
                                      type="text"
                                      value={listSearch}
                                      onChange={(e) => setListSearch(e.target.value)}
                                      placeholder="Search lists…"
                                      className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                                    />
                                  </div>
                                </div>
                              )}
                              <TargetListPicker
                                lists={preview.targetLists}
                                search={listSearch}
                                selectedListId={selectedListId}
                                unavailableSourceListId={
                                  preview.task.connectorInstanceId === selectedConnector.id
                                    ? preview.task.sourceListId
                                    : undefined
                                }
                                onSelect={handleListSelect}
                              />
                            </div>
                          )}

                          {isSelected && preview && preview.targetLists.length === 0 && (
                            <p className="px-8 py-2 border-t border-[var(--border-subtle)] text-xs text-[var(--text-muted)]">
                              No lists available.
                            </p>
                          )}

                          {isSelected && previewError && (
                            <p className="px-4 py-2 border-t border-[var(--border-subtle)] text-xs text-rose-400">
                              {previewError}
                            </p>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}

                {/* Native transfer badge */}
                {preview?.isNativeTransfer && (
                  <div className="flex items-center gap-1.5 p-2 rounded-lg bg-emerald-950/30 border border-emerald-800/30 text-emerald-400">
                    <Shield size={12} className="shrink-0" />
                    <p className="text-xs">{preview.nativeTransferNote}</p>
                  </div>
                )}

                <button
                  onClick={() => setStep('field-mapping')}
                  disabled={!canProceedToMapping}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white disabled:opacity-40 disabled:cursor-not-allowed hover:brightness-110 transition-all"
                >
                  Review field mapping
                  <ArrowRight size={14} />
                </button>
              </motion.div>
            )}

            {/* ── Step 2: Field Mapping ────────────────────────────────────── */}
            {step === 'field-mapping' && preview && (
              <motion.div
                key="field-mapping"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="space-y-3"
              >
                <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                  <span>{sourceConnectorType}</span>
                  <ArrowRight size={12} />
                  {iconSrc && <Image src={iconSrc} alt={preview.targetConnector.type} width={13} height={13} />}
                  <span className="text-[var(--text-secondary)]">{preview.targetConnector.name}</span>
                  <span className="text-[var(--text-muted)]">›</span>
                  <span className="text-[var(--text-secondary)] truncate">{preview.targetLists.find((l) => l.sourceId === selectedListId)?.name ?? selectedListId}</span>
                </div>

                {preview.isNativeTransfer && (
                  <div className="flex items-center gap-1.5 p-2 rounded-lg bg-emerald-950/30 border border-emerald-800/30 text-emerald-400">
                    <Shield size={12} className="shrink-0" />
                    <p className="text-xs">{preview.nativeTransferNote}</p>
                  </div>
                )}

                {preview.hasLossyFields && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/40 border border-rose-700/50 text-rose-300">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-semibold">Data loss warning</p>
                      <p className="text-xs mt-0.5">
                        {lossyFields.join(', ')} cannot be fully preserved in the destination.
                      </p>
                    </div>
                  </div>
                )}

                <div className="rounded-xl border border-[var(--border)] divide-y divide-[var(--border-subtle)] bg-[var(--surface-0)]">
                  <div className="px-3 py-1.5">
                    {preview.fieldMappings.map((m) => (
                      <FieldMappingRow key={m.field} mapping={m} />
                    ))}
                  </div>

                  {preview.subtasks && (
                    <div className="px-3 py-2">
                      <div className="flex items-center gap-2 mb-0.5">
                        <Info size={13} className="text-sky-400 shrink-0" />
                        <span className="text-xs font-medium text-[var(--text-primary)]">
                          Subtasks ({preview.subtasks.count})
                        </span>
                        <span className="text-xs text-[var(--text-muted)] ml-auto">
                          {formatSubtaskStrategy(preview.subtasks.strategy)}
                        </span>
                      </div>
                      {preview.subtasks.warning && (
                        <p className="text-xs text-[var(--text-muted)] pl-5">{preview.subtasks.warning}</p>
                      )}
                    </div>
                  )}
                </div>

                {preview.suggestion && (
                  <div className="flex items-start gap-1.5 p-2.5 rounded-lg bg-amber-950/30 border border-amber-800/30">
                    <Info size={13} className="text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-300">💡 {preview.suggestion}</p>
                  </div>
                )}

                <button
                  onClick={() => setStep('confirm')}
                  className="w-full flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:brightness-110 transition-all"
                >
                  Continue
                  <ArrowRight size={14} />
                </button>
              </motion.div>
            )}

            {/* ── Step 3: Confirm ──────────────────────────────────────────── */}
            {step === 'confirm' && preview && (
              <motion.div
                key="confirm"
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.15 }}
                className="space-y-4"
              >
                <p className="text-xs text-[var(--text-muted)]">What should happen to the original task?</p>

                {preview.hasLossyFields && (
                  <div className="flex items-start gap-2 p-3 rounded-xl bg-rose-950/40 border border-rose-700/50 text-rose-300">
                    <AlertTriangle size={14} className="shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-semibold">Confirm data loss</p>
                      <p className="text-xs mt-0.5">
                        This operation will not carry {lossyFields.join(', ')} to the destination.
                      </p>
                    </div>
                  </div>
                )}

                <div className="space-y-2">
                  {preview.sourceActions.map(({ action, label, description }) => (
                    <button
                      key={action}
                      onClick={() => setSourceAction(action)}
                      className={`w-full flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                        sourceAction === action
                          ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                          : 'border-[var(--border)] hover:border-[var(--border-hover)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      <div className={`mt-0.5 shrink-0 ${sourceAction === action ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                        {action === 'move' ? <Scissors size={14} /> : <Copy size={14} />}
                      </div>
                      <div>
                        <p className={`text-sm font-medium ${sourceAction === action ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                          {label}
                        </p>
                        <p className="text-xs text-[var(--text-muted)] mt-0.5">{description}</p>
                      </div>
                      <div className={`ml-auto mt-0.5 w-3.5 h-3.5 rounded-full border-2 shrink-0 flex items-center justify-center ${
                        sourceAction === action ? 'border-[var(--accent)]' : 'border-[var(--text-muted)]'
                      }`}>
                        {sourceAction === action && (
                          <div className="w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                        )}
                      </div>
                    </button>
                  ))}
                </div>

                {executeError && (
                  <div className="flex items-start gap-1.5 p-2.5 rounded-lg bg-rose-950/30 border border-rose-800/30 text-rose-400">
                    <AlertTriangle size={13} className="shrink-0" />
                    <p className="text-xs">
                      {executeError.message}
                      {executeError.traceId && (
                        <span className="ml-1.5 text-[var(--text-muted)]">
                          Reference: <code>{executeError.traceId}</code>
                        </span>
                      )}
                    </p>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button
                    onClick={() => setStep('field-mapping')}
                    disabled={executing}
                    className="flex-1 py-2 rounded-lg text-sm text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-2)] transition-colors disabled:opacity-40"
                  >
                    Back
                  </button>
                  <button
                    onClick={handleExecute}
                    disabled={executing}
                    className="flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-sm font-medium bg-[var(--accent)] text-white hover:brightness-110 transition-all disabled:opacity-60"
                  >
                    {executing ? (
                      <>
                        <Loader2 size={13} className="animate-spin" />
                        {sourceAction === 'move' ? 'Moving…' : 'Copying…'}
                      </>
                    ) : (
                      <>
                        {preview.hasLossyFields
                          ? `${sourceAction === 'move' ? 'Move' : 'Copy'} Anyway`
                          : sourceAction === 'move' ? 'Move Task' : 'Copy Task'} →
                      </>
                    )}
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
