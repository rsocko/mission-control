'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  ChevronRight, ChevronDown, Trash2, Loader2,
  Plus, Eye, EyeOff, FolderTree, GripVertical,
  Save, PenLine, X, Check, ChevronsDownUp, ChevronsUpDown,
} from 'lucide-react';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { settingsLogger } from '@/lib/client-logger';
import {
  isSourceListSelected,
  type ConnectorConfig,
  type SourceList,
  type ListGroup,
} from './types';
import { getConnectorDisplayName } from '@/lib/connectors/display-name';
import { useInlineRename } from '@/lib/hooks/useInlineRename';
import { runSourceListRenameRequest } from '../source-list-renames';

import { IconPickerButton as EmojiPickerButton, IconRenderer } from '@/components/ui/icon-picker';

function ListGroupsSection({
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
}: {
  connectors: ConnectorConfig[];
  sourceLists: SourceList[];
  listGroups: ListGroup[];
  loading: boolean;
  onCreateGroup: (name: string, icon?: string, iconColor?: string) => Promise<void>;
  onUpdateGroup: (id: string, updates: Partial<ListGroup>) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onAssignList: (id: string, groupId: string | null) => Promise<void>;
  onRefresh: () => Promise<void>;
  onRenameList: (sourceListId: string, newName: string) => (() => void);
}) {
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('');
  const [newIconColor, setNewIconColor] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [assigningListId, setAssigningListId] = useState<string | null>(null);
  const [localGroupOrder, setLocalGroupOrder] = useState<string[]>([]);
  const [localUngroupedOrder, setLocalUngroupedOrder] = useState<string[]>([]);
  const [collapseAllVersion, setCollapseAllVersion] = useState<{ version: number; collapsed: boolean }>({ version: 1, collapsed: true });

  const connectorById = new Map(connectors.map((connector) => [connector.id, connector]));
  const connectorNameById = new Map(connectors.map((connector) => [connector.id, getConnectorDisplayName(connector)]));
  const sourceListsWithSelection = sourceLists.map((sourceList) => {
    const connector = connectorById.get(sourceList.connectorInstanceId);
    return {
      ...sourceList,
      selectedForSync: connector ? isSourceListSelected(connector, sourceList) : false,
    };
  });
  const sortedGroups = [...listGroups].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  // Keep local group order in sync with props
  useEffect(() => {
    setLocalGroupOrder(sortedGroups.map((g) => g.id));
  }, [listGroups]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedGroups = localGroupOrder.length > 0
    ? localGroupOrder.map((id) => sortedGroups.find((g) => g.id === id)).filter(Boolean) as ListGroup[]
    : sortedGroups;

  const sortedSourceLists = [...sourceListsWithSelection].sort((a, b) => {
    const connectorNameCompare = (connectorNameById.get(a.connectorInstanceId) || a.connectorInstanceId)
      .localeCompare(connectorNameById.get(b.connectorInstanceId) || b.connectorInstanceId);

    return connectorNameCompare !== 0
      ? connectorNameCompare
      : a.name.localeCompare(b.name);
  });

  // Ungrouped lists sorted by sortOrder then name
  const ungroupedVisible = sourceListsWithSelection
    .filter((sl) => !sl.groupId && !sl.hidden)
    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || a.name.localeCompare(b.name));

  // Keep local ungrouped order in sync
  useEffect(() => {
    setLocalUngroupedOrder(ungroupedVisible.map((sl) => sl.id));
  }, [sourceLists, connectors]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedUngrouped = localUngroupedOrder.length > 0
    ? localUngroupedOrder.map((id) => ungroupedVisible.find((sl) => sl.id === id)).filter(Boolean) as SourceList[]
    : ungroupedVisible;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handleGroupDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localGroupOrder.indexOf(String(active.id));
    const newIndex = localGroupOrder.indexOf(String(over.id));
    const previousOrder = localGroupOrder;
    const newOrder = arrayMove(localGroupOrder, oldIndex, newIndex);
    setLocalGroupOrder(newOrder);

    // Persist to server
    try {
      const res = await fetch('/api/list-groups/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: newOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder');
    } catch {
      setLocalGroupOrder(previousOrder);
      toast.error('Failed to save group order');
    }
  }

  async function handleUngroupedDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localUngroupedOrder.indexOf(String(active.id));
    const newIndex = localUngroupedOrder.indexOf(String(over.id));
    const previousOrder = localUngroupedOrder;
    const newOrder = arrayMove(localUngroupedOrder, oldIndex, newIndex);
    setLocalUngroupedOrder(newOrder);

    try {
      const res = await fetch('/api/source-lists/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: newOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder');
    } catch {
      setLocalUngroupedOrder(previousOrder);
      toast.error('Failed to save list order');
    }
  }

  async function handleCreateGroup() {
    if (!newName.trim()) return;

    setSubmitting(true);
    try {
      await onCreateGroup(newName.trim(), newIcon.trim() || undefined, newIconColor.trim() || undefined);
      setNewName('');
      setNewIcon('');
      setNewIconColor('');
      toast.success('Group created');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to create group');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleAssignList(sourceListId: string, groupId: string | null) {
    setAssigningListId(sourceListId);
    try {
      await onAssignList(sourceListId, groupId);
    } catch (error) {
      settingsLogger.error('Failed to assign source list', { err: error });
    } finally {
      setAssigningListId(null);
    }
  }

  async function handleToggleHidden(sourceListId: string, hidden: boolean) {
    setAssigningListId(sourceListId);
    try {
      await fetch(`/api/source-lists/${encodeURIComponent(sourceListId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden }),
      });
      await onRefresh();
    } catch (error) {
      settingsLogger.error('Failed to toggle list visibility', { err: error });
    } finally {
      setAssigningListId(null);
    }
  }

  async function handleRenameList(sourceListId: string, newName: string, icon?: string, iconColor?: string) {
    // Optimistically update parent state immediately so the name persists
    // across tab switches regardless of network timing or caching.
    // The returned cleanup clears the pending-rename guard so future fetches
    // are no longer overridden.
    const clearPending = onRenameList(sourceListId, newName);

    let res: Response;
    try {
      res = await runSourceListRenameRequest(
        () => fetch('/api/source-lists/rename', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: sourceListId, name: newName, icon, iconColor }),
        }),
        async () => {
          clearPending();
          await onRefresh();
        },
      );
    } catch (error) {
      toast.error('Rename failed. Check your connection and try again.');
      throw error;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      const msg = data.error || 'Rename failed';
      toast.error(msg);
      throw new Error(msg);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-[var(--text-primary)] [text-wrap:balance]">List Groups</h2>
          <p className="mt-1 text-sm text-[var(--text-tertiary)] [text-wrap:pretty]">
            Organize synced source lists into named groups across every connector.
          </p>
        </div>
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
        <div className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)_auto]">
          <EmojiPickerButton value={newIcon} onChange={setNewIcon} color={newIconColor || undefined} onColorChange={setNewIconColor} />
          <input
            type="text"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            placeholder="Create a new list group"
            className="h-10 rounded-xl border border-[var(--border)] bg-[var(--surface-0)] px-3 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow]"
          />
          <motion.button
            type="button"
            onClick={handleCreateGroup}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            disabled={submitting || !newName.trim()}
            className="inline-flex h-10 items-center justify-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white shadow-[0_12px_24px_rgba(37,99,235,0.28)] transition-[background-color,opacity] hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            Create Group
          </motion.button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
          <Loader2 size={16} className="animate-spin" />
          Loading groups...
        </div>
      ) : (
        <>
          {/* Three-column layout: Groups | Ungrouped | All Lists */}
          <div className="grid gap-6 xl:grid-cols-3 lg:grid-cols-2 [&>div]:min-w-0">
            {/* Column 1: Groups (collapsible, draggable) */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                  Groups ({orderedGroups.length})
                </h3>
                {orderedGroups.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setCollapseAllVersion((prev) => ({ version: prev.version + 1, collapsed: !prev.collapsed }))}
                    className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--text-muted)] transition-[background-color,color] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
                    title={collapseAllVersion.collapsed ? 'Expand all groups' : 'Collapse all groups'}
                  >
                    {collapseAllVersion.collapsed ? <ChevronsUpDown size={12} /> : <ChevronsDownUp size={12} />}
                    {collapseAllVersion.collapsed ? 'Expand All' : 'Collapse All'}
                  </button>
                )}
              </div>
              {orderedGroups.length > 0 ? (
                <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
                  <SortableContext items={localGroupOrder} strategy={verticalListSortingStrategy}>
                    <div className="space-y-3">
                      {orderedGroups.map((group) => (
                        <SortableGroupCard
                          key={group.id}
                          group={group}
                          assignedLists={sourceListsWithSelection.filter((sourceList) => sourceList.groupId === group.id)}
                          connectorNameById={connectorNameById}
                          onUpdateGroup={onUpdateGroup}
                          onDeleteGroup={onDeleteGroup}
                          onRenameList={handleRenameList}
                          collapseAllVersion={collapseAllVersion}
                        />
                      ))}
                    </div>
                  </SortableContext>
                </DndContext>
              ) : (
                <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-1)] p-6 text-center">
                  <FolderTree size={24} className="mx-auto text-[var(--text-muted)]" />
                  <p className="mt-2 text-sm text-[var(--text-muted)]">Create your first group above — it helps keep things tidy.</p>
                </div>
              )}
            </div>

            {/* Column 2: Ungrouped lists */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                Ungrouped ({orderedUngrouped.length})
              </h3>
              <div className="rounded-2xl border border-dashed border-[var(--border)] bg-[var(--surface-1)] p-4">
                <div className="space-y-2">
                  {orderedUngrouped.length > 0 ? (
                    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleUngroupedDragEnd}>
                      <SortableContext items={localUngroupedOrder} strategy={verticalListSortingStrategy}>
                        {orderedUngrouped.map((sourceList) => (
                          <SortableUngroupedItem
                            key={sourceList.id}
                            sourceList={sourceList}
                            connectorName={connectorNameById.get(sourceList.connectorInstanceId) || sourceList.connectorInstanceId}
                            sortedGroups={sortedGroups}
                            assigningListId={assigningListId}
                            onAssign={(groupId) => void handleAssignList(sourceList.id, groupId)}
                            onHide={() => void handleToggleHidden(sourceList.id, true)}
                            onRename={(newName, icon, iconColor) => handleRenameList(sourceList.id, newName, icon, iconColor)}
                          />
                        ))}
                      </SortableContext>
                    </DndContext>
                  ) : (
                    <p className="py-4 text-center text-sm text-[var(--text-muted)]">All lists are assigned to groups.</p>
                  )}
                </div>

                {/* Hidden lists disclosure */}
                {sourceListsWithSelection.filter((sl) => sl.hidden).length > 0 && (
                  <details className="mt-4">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-[var(--text-muted)] [&::-webkit-details-marker]:hidden">
                      <EyeOff size={12} />
                      {sourceListsWithSelection.filter((sl) => sl.hidden).length} hidden list{sourceListsWithSelection.filter((sl) => sl.hidden).length === 1 ? '' : 's'}
                    </summary>
                    <div className="mt-2 space-y-1.5">
                      {sourceListsWithSelection
                        .filter((sl) => sl.hidden)
                        .sort((a, b) => a.name.localeCompare(b.name))
                        .map((sourceList) => (
                          <div key={sourceList.id} className="flex items-center justify-between gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-1.5 opacity-50">
                            <div className="flex items-center gap-1.5 min-w-0">
                              {sourceList.icon && (
                                <IconRenderer value={sourceList.icon} size={16} color={sourceList.iconColor || undefined} />
                              )}
                              <p className="truncate text-sm text-[var(--text-muted)]">{sourceList.name}</p>
                              <SourceSyncBadge sourceList={sourceList} />
                            </div>
                            <button
                              type="button"
                              onClick={() => void handleToggleHidden(sourceList.id, false)}
                              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-[background-color,color] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                              title="Show this list"
                            >
                              <Eye size={13} />
                            </button>
                          </div>
                        ))}
                    </div>
                  </details>
                )}
              </div>
            </div>

            {/* Column 3: All Source Lists */}
            <div className="space-y-3 lg:col-span-2 xl:col-span-1">
              <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]">
                All Lists ({sortedSourceLists.length})
              </h3>
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
                <div className="space-y-2 max-h-[600px] overflow-y-auto">
                  {sortedSourceLists.map((sourceList) => (
                    <AllSourceListItem
                      key={sourceList.id}
                      sourceList={sourceList}
                      connectorName={connectorNameById.get(sourceList.connectorInstanceId) || sourceList.connectorInstanceId}
                      sortedGroups={sortedGroups}
                      assigningListId={assigningListId}
                      onAssign={(groupId) => void handleAssignList(sourceList.id, groupId)}
                      onToggleHidden={() => void handleToggleHidden(sourceList.id, !sourceList.hidden)}
                      onRename={(newName, icon, iconColor) => handleRenameList(sourceList.id, newName, icon, iconColor)}
                    />
                  ))}
                  {sortedSourceLists.length === 0 && (
                    <p className="text-sm text-[var(--text-muted)]">Source lists appear after your first sync — run one from a connector above.</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AllSourceListItem({
  sourceList,
  connectorName,
  sortedGroups,
  assigningListId,
  onAssign,
  onToggleHidden,
  onRename,
}: {
  sourceList: SourceList;
  connectorName: string;
  sortedGroups: ListGroup[];
  assigningListId: string | null;
  onAssign: (groupId: string | null) => void;
  onToggleHidden: () => void;
  onRename: (newName: string, icon?: string, iconColor?: string) => Promise<void>;
}) {
  const {
    editing,
    name: editName,
    setName: setEditName,
    icon: editIcon,
    setIcon: setEditIcon,
    iconColor: editIconColor,
    setIconColor: setEditIconColor,
    saving,
    startEditing,
    cancel,
    save: handleSaveRename,
    scheduleBlur: handleBlur,
    setPickerOpen,
  } = useInlineRename({
    name: sourceList.name,
    icon: sourceList.icon,
    iconColor: sourceList.iconColor,
    onSave: onRename,
    onError: (error) => settingsLogger.error('Failed to rename source list', { err: error }),
  });

  return (
    <div className={`group/allitem rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-3 ${sourceList.hidden ? 'opacity-50' : ''}`}>
      <div className="flex flex-col gap-2 min-w-0">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <span onMouseDown={(e) => e.preventDefault()}>
                <EmojiPickerButton
                  value={editIcon}
                  onChange={(icon) => { setEditIcon(icon); }}
                  color={editIconColor || undefined}
                  onColorChange={setEditIconColor}
                  onOpenChange={setPickerOpen}
                />
              </span>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveRename(); if (e.key === 'Escape') cancel(); }}
                onBlur={handleBlur}
                autoFocus
                className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow]"
              />
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void handleSaveRename()} disabled={saving} className="flex h-8 w-8 items-center justify-center rounded-lg text-green-400 hover:bg-green-500/10" title="Save">
                {saving ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}><Loader2 size={13} /></motion.span> : <Check size={13} />}
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancel} className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]" title="Cancel">
                <X size={13} />
              </button>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2">
                {sourceList.icon && (
                  <IconRenderer value={sourceList.icon} size={16} color={sourceList.iconColor || undefined} />
                )}
                <p className="truncate text-sm font-medium text-[var(--text-primary)]">{sourceList.name}</p>
                <SourceSyncBadge sourceList={sourceList} />
                <button
                  type="button"
                  onClick={startEditing}
                  className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-opacity group-hover/allitem:opacity-100 hover:text-[var(--text-secondary)]"
                  title="Rename"
                >
                  <PenLine size={11} />
                </button>
                <span className="rounded-full bg-[var(--accent)]/15 px-2 py-0.5 text-xs uppercase tracking-[0.08em] text-[var(--accent)]">
                  {sourceList.type}
                </span>
                {sourceList.hidden && (
                  <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
                    hidden
                  </span>
                )}
              </div>
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {connectorName}
                {' · '}
                <span className="tabular-nums">{sourceList.taskCount} items</span>
              </p>
            </>
          )}
        </div>
        {!editing && (
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onToggleHidden}
              className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border transition-[background-color,color] ${
                sourceList.hidden
                  ? 'border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]'
              }`}
              title={sourceList.hidden ? 'Show this list' : 'Hide this list'}
            >
              {sourceList.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
            </button>
            {assigningListId === sourceList.id && <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />}
            <Select value={sourceList.groupId || ''} onValueChange={(v) => onAssign(v || null)}>
              <SelectTrigger className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 text-xs text-[var(--text-primary)]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="">No group</SelectItem>
                {sortedGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    <span className="inline-flex items-center gap-1.5">
                      {group.icon && <IconRenderer value={group.icon} size={14} color={group.iconColor || undefined} />}
                      {group.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableUngroupedItem({
  sourceList,
  connectorName,
  sortedGroups,
  assigningListId,
  onAssign,
  onHide,
  onRename,
}: {
  sourceList: SourceList;
  connectorName: string;
  sortedGroups: ListGroup[];
  assigningListId: string | null;
  onAssign: (groupId: string | null) => void;
  onHide: () => void;
  onRename: (newName: string, icon?: string, iconColor?: string) => Promise<void>;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: sourceList.id });
  const {
    editing,
    name: editName,
    setName: setEditName,
    icon: editIcon,
    setIcon: setEditIcon,
    iconColor: editIconColor,
    setIconColor: setEditIconColor,
    saving,
    startEditing,
    cancel,
    save: handleSaveRename,
    scheduleBlur: handleBlur,
    setPickerOpen,
  } = useInlineRename({
    name: sourceList.name,
    icon: sourceList.icon,
    iconColor: sourceList.iconColor,
    onSave: onRename,
    onError: (error) => settingsLogger.error('Failed to rename source list', { err: error }),
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/ungrouped rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-2"
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex h-5 w-5 shrink-0 cursor-grab items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
          title="Drag to reorder"
        >
          <GripVertical size={12} />
        </button>
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex items-center gap-1.5">
              <span onMouseDown={(e) => e.preventDefault()}>
                <EmojiPickerButton
                  value={editIcon}
                  onChange={(icon) => { setEditIcon(icon); }}
                  color={editIconColor || undefined}
                  onColorChange={setEditIconColor}
                  onOpenChange={setPickerOpen}
                />
              </span>
              <input
                type="text"
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveRename(); if (e.key === 'Escape') cancel(); }}
                onBlur={handleBlur}
                autoFocus
                className="h-8 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow]"
              />
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void handleSaveRename()} disabled={saving} className="flex h-7 w-7 items-center justify-center rounded-md text-green-400 transition-[background-color] hover:bg-green-500/10" title="Save">
                {saving ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}><Loader2 size={13} /></motion.span> : <Check size={13} />}
              </button>
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancel} className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-[background-color] hover:bg-[var(--surface-2)]" title="Cancel">
                <X size={13} />
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              {sourceList.icon && (
                <IconRenderer value={sourceList.icon} size={16} color={sourceList.iconColor || undefined} />
              )}
              <p className="truncate text-sm text-[var(--text-primary)]">{sourceList.name}</p>
              <SourceSyncBadge sourceList={sourceList} />
              <button
                type="button"
                onClick={startEditing}
                className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-opacity group-hover/ungrouped:opacity-100 hover:text-[var(--text-secondary)]"
                title="Rename"
              >
                <PenLine size={11} />
              </button>
            </div>
          )}
          {!editing && <p className="text-xs text-[var(--text-muted)]">{connectorName}</p>}
        </div>
        {!editing && (
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={onHide}
              className="flex h-7 w-7 items-center justify-center rounded-md text-[var(--text-muted)] transition-[background-color,color] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
              title="Hide this list"
            >
              <EyeOff size={13} />
            </button>
            {assigningListId === sourceList.id && <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />}
            <Select value="" onValueChange={(v) => onAssign(v || null)}>
              <SelectTrigger className="h-8 min-w-36 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-2 text-xs text-[var(--text-primary)]">
                <SelectValue placeholder="Assign to group…" />
              </SelectTrigger>
              <SelectContent>
                {sortedGroups.map((group) => (
                  <SelectItem key={group.id} value={group.id}>
                    <span className="inline-flex items-center gap-1.5">
                      {group.icon && <IconRenderer value={group.icon} size={14} color={group.iconColor || undefined} />}
                      {group.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  );
}

function SortableGroupCard({
  group,
  assignedLists,
  connectorNameById,
  onUpdateGroup,
  onDeleteGroup,
  onRenameList,
  collapseAllVersion,
}: {
  group: ListGroup;
  assignedLists: SourceList[];
  connectorNameById: Map<string, string>;
  onUpdateGroup: (id: string, updates: Partial<ListGroup>) => Promise<void>;
  onDeleteGroup: (id: string) => Promise<void>;
  onRenameList: (listId: string, newName: string, icon?: string, iconColor?: string) => Promise<void>;
  collapseAllVersion: { version: number; collapsed: boolean };
}) {
  const [name, setName] = useState(group.name);
  const [icon, setIcon] = useState(group.icon || '');
  const [iconColor, setIconColor] = useState(group.iconColor || '');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  const [localListOrder, setLocalListOrder] = useState<string[]>(
    assignedLists.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((l) => l.id)
  );

  // Sync local list order when assignedLists changes
  useEffect(() => {
    setLocalListOrder(
      assignedLists.sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0)).map((l) => l.id)
    );
  }, [assignedLists]);

  // Respond to collapse all / expand all
  useEffect(() => {
    if (collapseAllVersion.version > 0) {
      setCollapsed(collapseAllVersion.collapsed);
    }
  }, [collapseAllVersion]);

  const orderedLists = localListOrder
    .map((id) => assignedLists.find((l) => l.id === id))
    .filter(Boolean) as SourceList[];

  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: group.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  const listSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  async function handleListDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localListOrder.indexOf(String(active.id));
    const newIndex = localListOrder.indexOf(String(over.id));
    const previousOrder = localListOrder;
    const newOrder = arrayMove(localListOrder, oldIndex, newIndex);
    setLocalListOrder(newOrder);

    try {
      const res = await fetch('/api/source-lists/reorder', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds: newOrder }),
      });
      if (!res.ok) throw new Error('Failed to reorder');
    } catch {
      setLocalListOrder(previousOrder);
      toast.error('Failed to save list order');
    }
  }

  async function handleSave() {
    if (!name.trim()) return;

    setSaving(true);
    try {
      await onUpdateGroup(group.id, {
        name: name.trim(),
        icon: icon.trim() || null,
        iconColor: iconColor.trim() || null,
        sortOrder: group.sortOrder,
      });
    } catch (error) {
      settingsLogger.error('Failed to update list group', { err: error });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    setConfirmDialog({
      open: true,
      title: 'Delete group?',
      message: `Delete "${group.name}"? Lists will be unassigned from this group.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog((d) => ({ ...d, open: false }));
        setDeleting(true);
        try {
          await onDeleteGroup(group.id);
        } catch (error) {
          settingsLogger.error('Failed to delete list group', { err: error });
          setDeleting(false);
        }
      },
    });
  }

  return (
    <div ref={setNodeRef} style={style} className="rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[0_12px_32px_rgba(0,0,0,0.18)]">
      {/* Header — always visible */}
      <div className="flex items-center gap-2 px-2 py-3 pr-4">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="flex h-7 w-7 cursor-grab items-center justify-center rounded-md text-[var(--text-muted)] transition-[background-color] hover:bg-[var(--surface-2)] active:cursor-grabbing"
          title="Drag to reorder"
        >
          <GripVertical size={14} />
        </button>
        <button
          type="button"
          onClick={() => setCollapsed(!collapsed)}
          className="flex h-6 w-6 items-center justify-center rounded-md text-[var(--text-muted)] transition-[background-color] hover:bg-[var(--surface-2)]"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {group.icon && <IconRenderer value={group.icon} size={16} color={group.iconColor || undefined} />}
          <h3 className="truncate text-sm font-semibold text-[var(--text-primary)]">{group.name}</h3>
          <span className="rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs font-medium tabular-nums text-[var(--text-muted)]">
            {assignedLists.length}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <motion.button
            type="button"
            onClick={handleDelete}
            whileHover={{ scale: 1.02 }}
            whileTap={{ scale: 0.96 }}
            disabled={deleting}
            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-500/20 bg-red-500/10 text-red-300 transition-[background-color,opacity] hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            title="Delete group"
          >
            {deleting ? <Loader2 size={12} className="animate-spin" /> : <Trash2 size={12} />}
          </motion.button>
        </div>
      </div>

      {/* Collapsible body */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="border-t border-[var(--border)] px-4 pb-4 pt-3">
              {/* Edit fields */}
              <div className="grid gap-2 md:grid-cols-[auto_minmax(0,1fr)_auto]">
                <EmojiPickerButton value={icon} onChange={setIcon} color={iconColor || undefined} onColorChange={setIconColor} />
                <input
                  type="text"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  className="h-9 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-2 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow]"
                />
                <motion.button
                  type="button"
                  onClick={handleSave}
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.96 }}
                  disabled={saving || !name.trim()}
                  className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 text-xs font-medium text-blue-200 transition-[background-color,opacity] hover:bg-blue-500/20 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {saving ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}><Loader2 size={12} /></motion.span> : <Save size={12} />}
                  Save
                </motion.button>
              </div>

              {/* Assigned lists — sortable within group */}
              <div className="mt-3 space-y-1.5">
                {orderedLists.length > 0 ? (
                  <DndContext sensors={listSensors} collisionDetection={closestCenter} onDragEnd={handleListDragEnd}>
                    <SortableContext items={localListOrder} strategy={verticalListSortingStrategy}>
                      {orderedLists.map((sourceList) => (
                        <SortableListItem
                          key={sourceList.id}
                          sourceList={sourceList}
                          connectorName={connectorNameById.get(sourceList.connectorInstanceId) || sourceList.connectorInstanceId}
                          onRename={(newName, icon, iconColor) => onRenameList(sourceList.id, newName, icon, iconColor)}
                        />
                      ))}
                    </SortableContext>
                  </DndContext>
                ) : (
                  <p className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--surface-0)] px-3 py-3 text-center text-xs text-[var(--text-muted)]">
                    Drag lists here to assign them to this group.
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </div>
  );
}

function SortableListItem({ sourceList, connectorName, onRename }: { sourceList: SourceList; connectorName: string; onRename: (newName: string, icon?: string, iconColor?: string) => Promise<void> }) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: sourceList.id });
  const {
    editing,
    name: editName,
    setName: setEditName,
    icon: editIcon,
    setIcon: setEditIcon,
    iconColor: editIconColor,
    setIconColor: setEditIconColor,
    saving,
    startEditing,
    cancel,
    save: handleSaveRename,
    scheduleBlur: handleBlur,
    setPickerOpen,
  } = useInlineRename({
    name: sourceList.name,
    icon: sourceList.icon,
    iconColor: sourceList.iconColor,
    onSave: onRename,
    onError: (error) => settingsLogger.error('Failed to rename source list', { err: error }),
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="group/listitem flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] px-3 py-1.5"
    >
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="flex h-5 w-5 cursor-grab items-center justify-center rounded text-[var(--text-muted)] hover:text-[var(--text-secondary)] active:cursor-grabbing"
        title="Drag to reorder"
      >
        <GripVertical size={12} />
      </button>
      <div className="min-w-0 flex-1">
        {editing ? (
          <div className="flex items-center gap-1.5">
            <span onMouseDown={(e) => e.preventDefault()}>
              <EmojiPickerButton
                value={editIcon}
                onChange={(icon) => { setEditIcon(icon); }}
                color={editIconColor || undefined}
                onColorChange={setEditIconColor}
                onOpenChange={setPickerOpen}
              />
            </span>
            <input
              type="text"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSaveRename(); if (e.key === 'Escape') cancel(); }}
              onBlur={handleBlur}
              autoFocus
              className="h-7 min-w-0 flex-1 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 text-sm text-[var(--text-primary)] outline-none transition-[border-color,box-shadow]"
            />
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => void handleSaveRename()} disabled={saving} className="flex h-6 w-6 items-center justify-center rounded text-green-400 hover:bg-green-500/10" title="Save">
              {saving ? <motion.span animate={{ rotate: 360 }} transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}><Loader2 size={11} /></motion.span> : <Check size={11} />}
            </button>
            <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={cancel} className="flex h-6 w-6 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--surface-2)]" title="Cancel">
              <X size={11} />
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5">
            {sourceList.icon && (
                <IconRenderer value={sourceList.icon} size={16} color={sourceList.iconColor || undefined} />
            )}
            <p className="truncate text-sm text-[var(--text-primary)]">{sourceList.name}</p>
            <SourceSyncBadge sourceList={sourceList} />
            <button
              type="button"
              onClick={startEditing}
              className="flex h-5 w-5 items-center justify-center rounded text-[var(--text-muted)] opacity-0 transition-opacity group-hover/listitem:opacity-100 hover:text-[var(--text-secondary)]"
              title="Rename"
            >
              <PenLine size={10} />
            </button>
          </div>
        )}
        {!editing && <p className="text-xs text-[var(--text-muted)]">{connectorName}</p>}
      </div>
      {!editing && (
        <span className="shrink-0 rounded-full bg-[var(--surface-2)] px-2 py-0.5 text-xs uppercase tracking-[0.08em] text-[var(--text-muted)]">
          {sourceList.type}
        </span>
      )}
    </div>
  );
}

function SourceSyncBadge({ sourceList }: { sourceList: SourceList }) {
  if (sourceList.selectedForSync !== false) return null;
  return (
    <span className="shrink-0 rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-[0.06em] text-amber-400">
      Not syncing
    </span>
  );
}


export { ListGroupsSection, EmojiPickerButton };
