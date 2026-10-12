'use client';

import React, { useMemo, useState } from 'react';
import * as Popover from '@radix-ui/react-popover';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  type DragEndEvent,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Check,
  ChevronDown,
  Eye,
  EyeOff,
  FolderOpen,
  FolderPlus,
  GripVertical,
  Loader2,
  List,
  Palette,
  Plus,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { IconPickerButton } from '@rsocko/icon-picker/picker';
import { IconRenderer } from '@rsocko/icon-picker/renderer';
import { toast } from '@/lib/toast';
import { settingsLogger } from '@/lib/client-logger';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ContextAppearancePicker } from '@/components/context-theme/ContextAppearancePicker';
import { ConnectorIcon } from '@/components/sources/SourceIcons';
import { Tooltip, TooltipProvider } from '@/components/ui/Tooltip';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { ContextAppearance } from '@/types';
import { getConnectorDisplayName } from '@/lib/connectors/display-name';
import { runSourceListRenameRequest, settleSourceListRename } from '../source-list-renames';
import {
  isSourceListSelected,
  type ConnectorConfig,
  type ListGroup,
  type SourceList,
} from './types';

type GroupScope = string | 'other' | null;

interface ListGroupsSectionProps {
  connectors: ConnectorConfig[];
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  loading: boolean;
  onCreateGroup: (
    connectorInstanceId: string,
    name: string,
    icon?: string,
    iconColor?: string,
  ) => Promise<void>;
  onUpdateGroup: (id: string, updates: Partial<ListGroup>) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onAssignList: (id: string, groupId: string | null) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRenameList: (sourceListId: string, newName: string) => (() => Promise<void>);
  onUpdateAppearance?: (
    sourceListId: string,
    appearance: ContextAppearance | null,
  ) => Promise<void>;
}

export function ListGroupsSection(props: ListGroupsSectionProps) {
  const {
    connectors,
    sourceLists,
    listGroups,
    loading,
    onCreateGroup,
    onUpdateGroup,
    onDeleteGroup,
    onAssignList,
    onRefresh,
    onRenameList,
    onUpdateAppearance,
  } = props;
  const availableConnectors = useMemo(
    () => connectors.filter((connector) => !connector.deletedAt),
    [connectors],
  );
  const [selectedConnectorId, setSelectedConnectorId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState<GroupScope>(null);
  const [groupQuery, setGroupQuery] = useState('');
  const [listQuery, setListQuery] = useState('');
  const [groupOrder, setGroupOrder] = useState<string[]>([]);
  const [listOrder, setListOrder] = useState<string[]>([]);
  const [selectedListIds, setSelectedListIds] = useState<Set<string>>(new Set());
  const [creatingGroup, setCreatingGroup] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupIcon, setNewGroupIcon] = useState<string | null>(null);
  const [newGroupColor, setNewGroupColor] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleteGroup, setDeleteGroup] = useState<ListGroup | null>(null);
  const [appearanceListId, setAppearanceListId] = useState<string | null>(null);

  const connectorId = availableConnectors.some((item) => item.id === selectedConnectorId)
    ? selectedConnectorId
    : availableConnectors[0]?.id ?? '';

  const connector = availableConnectors.find((candidate) => candidate.id === connectorId);
  const connectorLists = useMemo(
    () => sourceLists
      .filter((list) => list.connectorInstanceId === connectorId)
      .map((list) => ({
        ...list,
        selectedForSync: connector ? isSourceListSelected(connector, list) : false,
      })),
    [connector, connectorId, sourceLists],
  );
  const connectorGroups = useMemo(
    () => listGroups
      .filter((group) => group.connectorInstanceId === connectorId)
      .sort(compareGroupOrder),
    [connectorId, listGroups],
  );

  const orderedGroupIds = [
    ...groupOrder.filter((id) => connectorGroups.some((group) => group.id === id)),
    ...connectorGroups
      .map((group) => group.id)
      .filter((id) => !groupOrder.includes(id)),
  ];
  const orderedGroups = orderedGroupIds
    .map((id) => connectorGroups.find((group) => group.id === id))
    .filter((group): group is ListGroup => Boolean(group));
  const visibleGroups = orderedGroups.filter((group) =>
    group.name.toLocaleLowerCase().includes(groupQuery.trim().toLocaleLowerCase()),
  );
  const activeGroup = selectedGroupId && selectedGroupId !== 'other'
    ? connectorGroups.find((group) => group.id === selectedGroupId) ?? null
    : null;
  const scopeLists = connectorLists
    .filter((list) => {
      if (selectedGroupId === null) return true;
      if (selectedGroupId === 'other') return !list.groupId;
      return list.groupId === selectedGroupId;
    })
    .sort(compareListOrder);
  const normalizedListQuery = listQuery.trim().toLocaleLowerCase();
  const visibleLists = scopeLists.filter((list) =>
    !normalizedListQuery
    || [list.name, list.sourceId, list.type]
      .some((value) => value.toLocaleLowerCase().includes(normalizedListQuery)),
  );
  const ungroupedCount = connectorLists.filter((list) => !list.groupId).length;
  const scopeTitle = selectedGroupId === null
    ? ''
    : selectedGroupId === 'other'
      ? 'Not in a group'
      : activeGroup?.name ?? '';
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const orderedListIds = [
    ...listOrder.filter((id) => scopeLists.some((list) => list.id === id)),
    ...scopeLists.map((list) => list.id).filter((id) => !listOrder.includes(id)),
  ];

  function selectGroup(groupId: GroupScope) {
    setSelectedGroupId(groupId);
    setSelectedListIds(new Set());
    setListOrder([]);
  }

  function changeConnector(nextConnectorId: string) {
    setSelectedConnectorId(nextConnectorId);
    setSelectedGroupId(null);
    setGroupQuery('');
    setListQuery('');
    setGroupOrder([]);
    setListOrder([]);
    setSelectedListIds(new Set());
    setAppearanceListId(null);
  }

  async function createGroup() {
    const name = newGroupName.trim();
    if (!connectorId || !name) return;
    setSaving(true);
    try {
      await onCreateGroup(
        connectorId,
        name,
        newGroupIcon?.trim() || undefined,
        newGroupColor?.trim() || undefined,
      );
      setCreatingGroup(false);
      setNewGroupName('');
      setNewGroupIcon(null);
      setNewGroupColor(null);
      toast.success('Group created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group');
    } finally {
      setSaving(false);
    }
  }

  async function reorderGroups(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || groupQuery) return;
    const previous = orderedGroupIds;
    const next = arrayMove(previous, previous.indexOf(String(active.id)), previous.indexOf(String(over.id)));
    setGroupOrder(next);
    try {
      const response = await fetch('/api/list-groups/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connectorInstanceId: connectorId, orderedIds: next }),
      });
      if (!response.ok) throw new Error('Failed to save group order');
    } catch (error) {
      setGroupOrder(previous);
      toast.error(error instanceof Error ? error.message : 'Failed to save group order');
    }
  }

  async function reorderLists(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id || listQuery || selectedGroupId === null) return;
    const previous = orderedListIds;
    const next = arrayMove(previous, previous.indexOf(String(active.id)), previous.indexOf(String(over.id)));
    setListOrder(next);
    try {
      const response = await fetch('/api/source-lists/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: next }),
      });
      if (!response.ok) throw new Error('Failed to save list order');
    } catch (error) {
      setListOrder(previous);
      toast.error(error instanceof Error ? error.message : 'Failed to save list order');
    }
  }

  async function moveLists(ids: readonly string[], groupId: string | null) {
    setSaving(true);
    try {
      await Promise.all(ids.map((id) => onAssignList(id, groupId)));
      setSelectedListIds(new Set());
      toast.success(ids.length === 1 ? 'List moved' : `${ids.length} lists moved`);
    } catch (error) {
      settingsLogger.error('Failed to move source lists', { err: error });
      toast.error('Failed to move lists');
    } finally {
      setSaving(false);
    }
  }

  async function renameList(
    sourceListId: string,
    name: string,
    icon?: string,
    iconColor?: string,
  ) {
    const clearPending = onRenameList(sourceListId, name);
    const response = await runSourceListRenameRequest(
      () => fetch('/api/source-lists/rename', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: sourceListId, name, icon, iconColor }),
      }),
      (result) => settleSourceListRename(result, clearPending, onRefresh),
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || 'Rename failed');
    }
  }

  const displayedLists = selectedGroupId === null
    ? visibleLists
    : orderedListIds
      .map((id) => visibleLists.find((list) => list.id === id))
      .filter((list): list is SourceList & { selectedForSync: boolean } => Boolean(list));

  return (
    <TooltipProvider>
      <div className="space-y-5">
      <div className="max-w-3xl">
        <h2 className="text-xl font-semibold text-[var(--text-primary)] [text-wrap:balance]">
          List organization
        </h2>
        <p className="mt-1 text-sm leading-relaxed text-[var(--text-tertiary)] [text-wrap:pretty]">
          Arrange the groups and lists shown under each source in navigation. Sources without
          groups stay as a simple flat list.
        </p>
      </div>

      <div className="grid gap-3 md:grid-cols-[minmax(240px,0.8fr)_minmax(280px,1.2fr)]">
        <Select value={connectorId} onValueChange={changeConnector}>
          <SelectTrigger className="h-14 px-4" aria-label="Choose source">
            <SelectValue placeholder="Choose a source" />
          </SelectTrigger>
          <SelectContent>
            {availableConnectors.map((item) => {
              const count = sourceLists.filter((list) => list.connectorInstanceId === item.id).length;
              return (
                <SelectItem key={item.id} value={item.id} className="py-3">
                  <span className="flex min-w-0 items-center gap-3 text-left">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)]">
                      <ConnectorIcon connectorType={item.type} size={18} />
                    </span>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{getConnectorDisplayName(item)}</span>
                      <span className="text-xs font-normal text-[var(--text-muted)]">
                        {item.type} · {count} {count === 1 ? 'list' : 'lists'}
                      </span>
                    </span>
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <SearchField
          value={listQuery}
          onChange={setListQuery}
          placeholder="Find list"
          label="Find list"
        />
      </div>

      {!connectorId && !loading ? (
        <EmptyState
          icon={<FolderOpen size={22} />}
          title="No sources available"
          description="Connect a source before organizing its lists."
        />
      ) : loading ? (
        <div className="flex items-center gap-2 py-10 text-sm text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Loading list organization…
        </div>
      ) : (
        <div className="grid min-h-[560px] overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_14px_36px_rgba(0,0,0,0.16)] lg:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="border-b border-[var(--border)] bg-[var(--surface-0)]/45 p-4 lg:border-b-0 lg:border-r">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[var(--text-primary)]">Groups</h3>
              <button
                type="button"
                onClick={() => setCreatingGroup(true)}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-[var(--accent-500)] transition-colors hover:bg-[var(--surface-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
              >
                <Plus size={14} />
                New group
              </button>
            </div>
            <div className="mt-3">
              <SearchField
                value={groupQuery}
                onChange={setGroupQuery}
                placeholder="Find group"
                label="Find group"
                compact
              />
            </div>
            <ScopeNavItem
              icon={<List size={16} />}
              label="All lists"
              count={connectorLists.length}
              selected={selectedGroupId === null}
              onSelect={() => selectGroup(null)}
              className="mt-3"
            />

            {creatingGroup && (
              <div className="mt-3 rounded-xl border border-[var(--accent-500)]/35 bg-[var(--surface-1)] p-3">
                <div className="flex items-center gap-2">
                  <IconPickerButton
                    value={newGroupIcon}
                    onChange={setNewGroupIcon}
                    color={newGroupColor || undefined}
                    onColorChange={setNewGroupColor}
                    size="sm"
                  />
                  <input
                    autoFocus
                    value={newGroupName}
                    onChange={(event) => setNewGroupName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void createGroup();
                      if (event.key === 'Escape') setCreatingGroup(false);
                    }}
                    placeholder="Group name"
                    className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                  />
                  <button
                    type="button"
                    onClick={() => void createGroup()}
                    disabled={saving || !newGroupName.trim()}
                    aria-label="Create group"
                    className="flex size-8 items-center justify-center rounded-lg bg-[var(--accent-500)] text-white disabled:opacity-40"
                  >
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                  </button>
                  <button
                    type="button"
                    onClick={() => setCreatingGroup(false)}
                    aria-label="Cancel new group"
                    className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>
            )}

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderGroups}>
              <SortableContext items={orderedGroupIds} strategy={verticalListSortingStrategy}>
                <div className="mt-3 space-y-1">
                  {visibleGroups.map((group) => (
                    <GroupNavItem
                      key={group.id}
                      group={group}
                      count={connectorLists.filter((list) => list.groupId === group.id).length}
                      selected={selectedGroupId === group.id}
                      sortable={!groupQuery}
                      onSelect={() => selectGroup(group.id)}
                    />
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {connectorGroups.length === 0 && !creatingGroup ? (
              <div className="mt-5 rounded-xl border border-dashed border-[var(--border)] px-4 py-5 text-center">
                <FolderPlus size={20} className="mx-auto text-[var(--text-muted)]" />
                <p className="mt-2 text-sm font-medium text-[var(--text-secondary)]">No groups yet</p>
                <p className="mt-1 text-xs leading-relaxed text-[var(--text-muted)]">
                  Navigation stays flat until you create one.
                </p>
              </div>
            ) : visibleGroups.length === 0 ? (
              <p className="mt-5 text-center text-sm text-[var(--text-muted)]">No groups found.</p>
            ) : null}

            {connectorGroups.length > 0 && (
              <div className="mt-3 border-t border-[var(--border-subtle)] pt-3">
                <ScopeNavItem
                  icon={<FolderOpen size={16} />}
                  label="Not in a group"
                  count={ungroupedCount}
                  selected={selectedGroupId === 'other'}
                  onSelect={() => selectGroup('other')}
                />
              </div>
            )}
          </aside>

          <section className="min-w-0 p-4 sm:p-5" aria-label={scopeTitle || 'All lists'}>
            <div className="flex flex-col gap-3 border-b border-[var(--border-subtle)] pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                {selectedGroupId === null ? (
                  <p className="text-sm text-[var(--text-secondary)]">
                    Showing every list in {connector ? getConnectorDisplayName(connector) : 'this source'}.
                  </p>
                ) : activeGroup ? (
                  <EditableGroupHeading
                    group={activeGroup}
                    onUpdate={onUpdateGroup}
                    onDelete={() => setDeleteGroup(activeGroup)}
                  />
                ) : (
                  <div>
                    <h3 className="text-lg font-semibold text-[var(--text-primary)]">Not in a group</h3>
                    <p className="mt-1 text-xs text-[var(--text-muted)]">
                      Lists outside a group appear after grouped navigation.
                    </p>
                  </div>
                )}
              </div>
            </div>

            {selectedListIds.size > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2 rounded-xl bg-[var(--surface-2)] px-3 py-2">
                <span className="mr-auto text-xs font-medium text-[var(--text-secondary)]">
                  {selectedListIds.size} selected
                </span>
                <GroupPicker
                  groups={connectorGroups}
                  value={null}
                  placeholder="Move selected…"
                  onChange={(value) => void moveLists(
                    [...selectedListIds],
                    value,
                  )}
                  ariaLabel="Move selected lists"
                />
                <button
                  type="button"
                  onClick={() => setSelectedListIds(new Set())}
                  className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-1)]"
                  aria-label="Clear selection"
                >
                  <X size={14} />
                </button>
              </div>
            )}

            <div className="mt-4 flex items-center justify-between gap-3">
              <p className="text-xs tabular-nums text-[var(--text-muted)]" aria-live="polite">
                {visibleLists.length === scopeLists.length
                  ? `${scopeLists.length} ${scopeLists.length === 1 ? 'list' : 'lists'}`
                  : `${visibleLists.length} of ${scopeLists.length} lists`}
              </p>
              {selectedGroupId !== null && !listQuery && visibleLists.length > 1 ? (
                <span className="text-xs text-[var(--text-muted)]">Drag to reorder</span>
              ) : null}
            </div>

            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={reorderLists}>
              <SortableContext items={orderedListIds} strategy={verticalListSortingStrategy}>
                <div className="mt-2 divide-y divide-[var(--border-subtle)]">
                  {displayedLists.map((list) => (
                    <React.Fragment key={list.id}>
                      <ListRow
                        list={list}
                        groups={connectorGroups}
                        selected={selectedListIds.has(list.id)}
                        sortable={selectedGroupId !== null && !listQuery}
                        saving={saving}
                        appearanceOpen={appearanceListId === list.id}
                        onSelect={(selected) => setSelectedListIds((current) => {
                          const next = new Set(current);
                          if (selected) next.add(list.id);
                          else next.delete(list.id);
                          return next;
                        })}
                        onMove={(groupId) => void moveLists([list.id], groupId)}
                        onRename={renameList}
                        onToggleHidden={async () => {
                          try {
                            const response = await fetch(`/api/source-lists/${encodeURIComponent(list.id)}`, {
                              method: 'PATCH',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ hidden: !list.hidden }),
                            });
                            if (!response.ok) throw new Error('Failed to update list visibility');
                            await onRefresh();
                          } catch {
                            toast.error('Failed to update list visibility');
                          }
                        }}
                        onAppearance={onUpdateAppearance
                          ? () => setAppearanceListId((current) => current === list.id ? null : list.id)
                          : undefined}
                      />
                      {appearanceListId === list.id && onUpdateAppearance ? (
                        <div className="mb-3 ml-9 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-4">
                          <div className="mb-4 flex items-start justify-between gap-3">
                            <div>
                              <h4 className="text-sm font-semibold text-[var(--text-primary)]">
                                {list.name} appearance
                              </h4>
                              <p className="mt-1 text-xs text-[var(--text-muted)]">
                                Used when this list is the only active dashboard context.
                              </p>
                            </div>
                            <button
                              type="button"
                              onClick={() => setAppearanceListId(null)}
                              aria-label="Close appearance editor"
                              className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                            >
                              <X size={15} />
                            </button>
                          </div>
                          <ContextAppearancePicker
                            value={list.appearance ?? null}
                            kind="list"
                            fallbackAccent={list.iconColor || '#3b82f6'}
                            inheritLabel="Use global list style"
                            onChange={(appearance) => {
                              void onUpdateAppearance(list.id, appearance)
                                .then(() => toast.success('List appearance updated'))
                                .catch(() => toast.error('Failed to update list appearance'));
                            }}
                          />
                        </div>
                      ) : null}
                    </React.Fragment>
                  ))}
                </div>
              </SortableContext>
            </DndContext>

            {visibleLists.length === 0 && (
              <EmptyState
                icon={<Search size={20} />}
                title={listQuery ? 'No lists found' : 'No lists here'}
                description={listQuery
                  ? 'Try a different list name.'
                  : selectedGroupId === null
                    ? 'Lists appear after this source completes its first sync.'
                    : 'Move a list here or choose another group.'}
              />
            )}
          </section>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(deleteGroup)}
        title="Delete group?"
        message={`Lists in ${deleteGroup?.name ?? 'this group'} will move to Not in a group. The lists themselves will not be deleted.`}
        confirmLabel="Delete group"
        confirmVariant="danger"
        onCancel={() => setDeleteGroup(null)}
        onConfirm={() => {
          if (!deleteGroup) return;
          void onDeleteGroup(deleteGroup.id)
            .then(() => {
              setDeleteGroup(null);
              setSelectedGroupId('other');
              toast.success('Group deleted');
            })
            .catch(() => toast.error('Failed to delete group'));
        }}
      />
      </div>
    </TooltipProvider>
  );
}

function SearchField({
  value,
  onChange,
  placeholder,
  label,
  compact = false,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  label: string;
  compact?: boolean;
}) {
  return (
    <label className={`input-glow flex items-center gap-2 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 ${
      compact ? 'h-9' : 'h-14'
    }`}>
      <Search size={15} className="shrink-0 text-[var(--text-muted)]" />
      <span className="sr-only">{label}</span>
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="min-w-0 flex-1 bg-transparent text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label.toLocaleLowerCase()}`}
          className="flex size-7 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
        >
          <X size={13} />
        </button>
      ) : null}
    </label>
  );
}

function ScopeNavItem({
  icon,
  label,
  count,
  selected,
  onSelect,
  className = '',
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  selected: boolean;
  onSelect: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`${className} flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left text-sm transition-colors ${
        selected
          ? 'bg-[var(--surface-2)] font-medium text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)]'
      }`}
    >
      <span className="flex size-5 shrink-0 items-center justify-center text-[var(--text-muted)]">
        {icon}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
    </button>
  );
}

function GroupPicker({
  groups,
  value,
  placeholder,
  onChange,
  ariaLabel,
  disabled = false,
}: {
  groups: ListGroup[];
  value: string | null;
  placeholder?: string;
  onChange: (groupId: string | null) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const sortedGroups = [...groups]
    .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
    .filter((group) => group.name.toLocaleLowerCase().includes(normalizedQuery));
  const selectedGroup = groups.find((group) => group.id === value);

  function select(groupId: string | null) {
    onChange(groupId);
    setOpen(false);
    setQuery('');
  }

  return (
    <Popover.Root open={open} onOpenChange={(nextOpen) => {
      setOpen(nextOpen);
      if (!nextOpen) setQuery('');
    }}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={ariaLabel}
          aria-expanded={open}
          className="hidden h-8 max-w-44 items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] disabled:opacity-50 sm:flex"
        >
          <span className="truncate">{selectedGroup?.name ?? (value === null && !placeholder ? 'Not in a group' : placeholder)}</span>
          <ChevronDown size={13} className="ml-auto shrink-0 text-[var(--text-muted)]" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 w-64 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-2 shadow-[var(--shadow-lg)]"
        >
          <div className="relative">
            <Search
              aria-hidden="true"
              size={14}
              className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
            />
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find group"
              aria-label="Find destination group"
              className="h-9 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] pl-8 pr-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] focus:border-[var(--accent-500)]"
            />
          </div>
          <div className="mt-2 max-h-56 overflow-y-auto">
            {sortedGroups.map((group) => (
              <button
                key={group.id}
                type="button"
                onClick={() => select(group.id)}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
              >
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
                {value === group.id ? <Check size={14} className="shrink-0 text-[var(--accent-500)]" /> : null}
              </button>
            ))}
            {sortedGroups.length === 0 ? (
              <p className="px-2.5 py-4 text-center text-xs text-[var(--text-muted)]">No groups found.</p>
            ) : null}
          </div>
          <div className="mt-1 border-t border-[var(--border-subtle)] pt-1">
            <button
              type="button"
              onClick={() => select(null)}
              className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <span className="min-w-0 flex-1 truncate">Not in a group</span>
              {value === null && !placeholder ? <Check size={14} className="shrink-0 text-[var(--accent-500)]" /> : null}
            </button>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function GroupNavItem({
  group,
  count,
  selected,
  sortable,
  onSelect,
}: {
  group: ListGroup;
  count: number;
  selected: boolean;
  sortable: boolean;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: group.id,
    disabled: !sortable,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-center rounded-xl transition-colors ${
        selected
          ? 'bg-[var(--accent-500)]/12 text-[var(--text-primary)]'
          : 'text-[var(--text-secondary)] hover:bg-[var(--surface-1)]'
      } ${isDragging ? 'z-10 opacity-70 shadow-lg' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${group.name}`}
        className={`ml-1 flex size-7 items-center justify-center text-[var(--text-muted)] ${
          sortable ? 'cursor-grab opacity-0 group-hover:opacity-100 focus:opacity-100' : 'invisible'
        }`}
      >
        <GripVertical size={14} />
      </button>
      <button type="button" onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-2 py-2.5 pr-3 text-left text-sm">
        {group.icon ? (
          <IconRenderer value={group.icon} size={16} color={group.iconColor || undefined} />
        ) : (
          <FolderOpen size={16} className="text-[var(--text-muted)]" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{group.name}</span>
        <span className="text-xs tabular-nums text-[var(--text-muted)]">{count}</span>
      </button>
    </div>
  );
}

function EditableGroupHeading({
  group,
  onUpdate,
  onDelete,
}: {
  group: ListGroup;
  onUpdate: (id: string, updates: Partial<ListGroup>) => Promise<void>;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(group.name);
  const [icon, setIcon] = useState<string | null>(group.icon);
  const [iconColor, setIconColor] = useState<string | null>(group.iconColor);
  const [saving, setSaving] = useState(false);

  function startEditing() {
    setName(group.name);
    setIcon(group.icon);
    setIconColor(group.iconColor);
    setEditing(true);
  }

  async function save() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      await onUpdate(group.id, {
        name: name.trim(),
        icon,
        iconColor,
      });
      setEditing(false);
      toast.success('Group updated');
    } catch {
      toast.error('Failed to update group');
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex max-w-xl items-center gap-2">
        <IconPickerButton
          value={icon}
          onChange={setIcon}
          color={iconColor || undefined}
          onColorChange={setIconColor}
          size="sm"
        />
        <input
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
            if (event.key === 'Escape') setEditing(false);
          }}
          className="min-w-0 flex-1 border-b border-[var(--accent-500)] bg-transparent py-1 text-lg font-semibold text-[var(--text-primary)] outline-none"
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          aria-label="Save group"
          className="flex size-8 items-center justify-center rounded-lg text-[var(--accent-500)] hover:bg-[var(--surface-2)]"
        >
          {saving ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}
        </button>
        <button
          type="button"
          onClick={() => setEditing(false)}
          aria-label="Cancel group edit"
          className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
        >
          <X size={15} />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-start gap-3">
      <button
        type="button"
        onClick={startEditing}
        className="flex min-w-0 items-center gap-2 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
        title="Edit group name and icon"
      >
        {group.icon ? (
          <IconRenderer value={group.icon} size={20} color={group.iconColor || undefined} />
        ) : (
          <FolderOpen size={20} className="text-[var(--text-muted)]" />
        )}
        <span className="truncate text-lg font-semibold text-[var(--text-primary)] decoration-[var(--text-muted)] underline-offset-4 group-hover:underline">
          {group.name}
        </span>
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete ${group.name}`}
        className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] opacity-0 transition-opacity hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100 focus:opacity-100"
      >
        <Trash2 size={14} />
      </button>
    </div>
  );
}

function ListRow({
  list,
  groups,
  selected,
  sortable,
  saving,
  appearanceOpen,
  onSelect,
  onMove,
  onRename,
  onToggleHidden,
  onAppearance,
}: {
  list: SourceList & { selectedForSync?: boolean };
  groups: ListGroup[];
  selected: boolean;
  sortable: boolean;
  saving: boolean;
  appearanceOpen: boolean;
  onSelect: (selected: boolean) => void;
  onMove: (groupId: string | null) => void;
  onRename: (id: string, name: string, icon?: string, iconColor?: string) => Promise<void>;
  onToggleHidden: () => void;
  onAppearance?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  const [icon, setIcon] = useState<string | null>(list.icon ?? null);
  const [iconColor, setIconColor] = useState<string | null>(list.iconColor ?? null);
  const [renaming, setRenaming] = useState(false);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: list.id,
    disabled: !sortable,
  });

  function startEditing() {
    setName(list.name);
    setIcon(list.icon ?? null);
    setIconColor(list.iconColor ?? null);
    setEditing(true);
  }

  async function saveRename() {
    if (!name.trim()) return;
    setRenaming(true);
    try {
      await onRename(
        list.id,
        name.trim(),
        icon?.trim() || undefined,
        iconColor?.trim() || undefined,
      );
      setEditing(false);
      toast.success('List updated');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update list');
    } finally {
      setRenaming(false);
    }
  }

  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group/row flex min-w-0 items-center gap-2 py-3 ${isDragging ? 'z-10 bg-[var(--surface-1)] opacity-80 shadow-lg' : ''}`}
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-label={`Reorder ${list.name}`}
        className={`flex size-7 shrink-0 items-center justify-center text-[var(--text-muted)] ${
          sortable ? 'cursor-grab opacity-0 group-hover/row:opacity-100 focus:opacity-100' : 'invisible'
        }`}
      >
        <GripVertical size={14} />
      </button>
      <label className="flex size-7 shrink-0 cursor-pointer items-center justify-center">
        <input
          type="checkbox"
          checked={selected}
          onChange={(event) => onSelect(event.target.checked)}
          className="size-4 rounded border-[var(--border)] accent-[var(--accent-500)]"
          aria-label={`Select ${list.name}`}
        />
      </label>

      {editing ? (
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <IconPickerButton
            value={icon}
            onChange={setIcon}
            color={iconColor || undefined}
            onColorChange={setIconColor}
            size="sm"
          />
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void saveRename();
              if (event.key === 'Escape') setEditing(false);
            }}
            className="min-w-0 flex-1 border-b border-[var(--accent-500)] bg-transparent py-1 text-sm font-medium text-[var(--text-primary)] outline-none"
          />
          <button
            type="button"
            onClick={() => void saveRename()}
            disabled={renaming}
            aria-label="Save list"
            className="flex size-8 items-center justify-center rounded-lg text-[var(--accent-500)] hover:bg-[var(--surface-2)]"
          >
            {renaming ? <Loader2 size={14} className="animate-spin" /> : <Check size={15} />}
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            aria-label="Cancel list edit"
            className="flex size-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
          >
            <X size={15} />
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={startEditing}
            title="Edit list name and icon"
            className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-500)]"
          >
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-[var(--text-secondary)]">
              {list.icon ? (
                <IconRenderer value={list.icon} size={17} color={list.iconColor || undefined} />
              ) : (
                <FolderOpen size={16} />
              )}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--text-primary)] decoration-[var(--text-muted)] underline-offset-4 group-hover/row:underline">
                {list.name}
              </span>
              <span className="mt-0.5 flex items-center gap-2 text-xs text-[var(--text-muted)]">
                <span>{list.type}</span>
                <span>{list.taskCount} active</span>
                {list.selectedForSync === false ? (
                  <span className="text-amber-500">Not syncing</span>
                ) : null}
              </span>
            </span>
          </button>
          <GroupPicker
            groups={groups}
            value={list.groupId}
            onChange={onMove}
            disabled={saving}
            ariaLabel={`Move ${list.name}`}
          />
          {onAppearance ? (
            <Tooltip content={appearanceOpen ? 'Close appearance editor' : 'Customize list appearance'}>
              <button
                type="button"
                onClick={onAppearance}
                aria-label={appearanceOpen ? `Close ${list.name} appearance editor` : `Customize ${list.name} appearance`}
                aria-expanded={appearanceOpen}
                className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] ${
                  appearanceOpen
                    ? 'bg-[var(--surface-2)] text-[var(--accent-500)]'
                    : 'text-[var(--text-muted)] opacity-0 group-hover/row:opacity-100 focus:opacity-100'
                }`}
              >
                <Palette size={14} />
              </button>
            </Tooltip>
          ) : null}
          <Tooltip content={list.hidden ? 'Show in navigation' : 'Hide from navigation'}>
            <button
              type="button"
              onClick={onToggleHidden}
              aria-label={list.hidden ? `Show ${list.name} in navigation` : `Hide ${list.name} from navigation`}
              className={`flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] ${
                list.hidden ? 'text-[var(--text-muted)]' : 'text-[var(--text-secondary)]'
              }`}
            >
              {list.hidden ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </Tooltip>
        </>
      )}
    </div>
  );
}

function EmptyState({
  icon,
  title,
  description,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="my-8 rounded-xl border border-dashed border-[var(--border)] px-5 py-10 text-center">
      <span className="mx-auto flex size-10 items-center justify-center rounded-xl bg-[var(--surface-2)] text-[var(--text-muted)]">
        {icon}
      </span>
      <p className="mt-3 text-sm font-medium text-[var(--text-secondary)]">{title}</p>
      <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-[var(--text-muted)]">{description}</p>
    </div>
  );
}

function compareGroupOrder(left: ListGroup, right: ListGroup) {
  return left.sortOrder - right.sortOrder
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}

function compareListOrder(left: SourceList, right: SourceList) {
  return (left.sortOrder ?? 0) - (right.sortOrder ?? 0)
    || left.name.localeCompare(right.name)
    || left.id.localeCompare(right.id);
}
