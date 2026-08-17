'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDashboardViewStore } from '@/lib/stores/dashboardViewStore';
import { useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';

export interface DashboardTaskDestination {
  id: string;
  label: string;
  connectorType: string;
  account: 'personal' | 'work' | null;
  color: string;
}

type ConfirmDialog = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void;
};
type SaveTemplateTask = { id: string; title: string; subtasks?: string[] } | null;

export function useDashboardUiState() {
  const viewStore = useDashboardViewStore();
  const { setCollapsedListGroups: persistCollapsedListGroups, setCollapsedSections: persistCollapsedSections } = viewStore;
  const { sidebarExpanded, setSidebarExpanded, sidebarMode, setSidebarMode } = useSidebarExpanded();
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [listSearch, setListSearch] = useState('');
  const [collapsedListGroups, setCollapsedListGroups] = useState<Set<string>>(
    new Set(viewStore.collapsedListGroups),
  );
  const [confirmDialog, setConfirmDialog] = useState<ConfirmDialog>({
    open: false,
    title: '',
    message: '',
    confirmLabel: '',
    variant: 'danger',
    onConfirm: () => {},
  });
  const [saveTemplateTask, setSaveTemplateTask] = useState<SaveTemplateTask>(null);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set(viewStore.collapsedSections),
  );
  const [expandedSourceLists, setExpandedSourceLists] = useState<Set<string>>(new Set());
  const [tagSearch, setTagSearch] = useState('');
  const [tagsExpanded, setTagsExpanded] = useState(false);
  const [detailMode, setDetailMode] = useState<'panel' | 'dialog' | 'workspace'>('panel');
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [addTaskInitialDest, setAddTaskInitialDest] = useState<DashboardTaskDestination | null>(null);
  const [addTaskInitialListId, setAddTaskInitialListId] = useState<string>();
  const listRef = useRef<HTMLDivElement | null>(null);
  const lastClickedIndexRef = useRef<number | null>(null);

  useEffect(() => {
    persistCollapsedListGroups([...collapsedListGroups]);
  }, [collapsedListGroups, persistCollapsedListGroups]);

  useEffect(() => {
    persistCollapsedSections([...collapsedSections]);
  }, [collapsedSections, persistCollapsedSections]);

  const toggleSection = useCallback((section: string) => {
    setCollapsedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }, []);

  const state = useMemo(() => ({
    bulkMode,
    bulkSelected,
    collapsedGroups,
    selectedTaskId,
    sidebarExpanded,
    sidebarMode,
    listSearch,
    collapsedListGroups,
    confirmDialog,
    saveTemplateTask,
    collapsedSections,
    expandedSourceLists,
    tagSearch,
    tagsExpanded,
    detailMode,
    showAddTaskModal,
    addTaskInitialDest,
    addTaskInitialListId,
  }), [
    addTaskInitialDest,
    addTaskInitialListId,
    bulkMode,
    bulkSelected,
    collapsedGroups,
    collapsedListGroups,
    collapsedSections,
    confirmDialog,
    detailMode,
    expandedSourceLists,
    listSearch,
    saveTemplateTask,
    selectedTaskId,
    showAddTaskModal,
    sidebarExpanded,
    sidebarMode,
    tagSearch,
    tagsExpanded,
  ]);

  const actions = useMemo(() => ({
    setBulkMode,
    setBulkSelected,
    setCollapsedGroups,
    setSelectedTaskId,
    setSidebarExpanded,
    setSidebarMode,
    setListSearch,
    setCollapsedListGroups,
    setConfirmDialog,
    setSaveTemplateTask,
    setExpandedSourceLists,
    setTagSearch,
    setTagsExpanded,
    setDetailMode,
    setShowAddTaskModal,
    setAddTaskInitialDest,
    setAddTaskInitialListId,
    toggleSection,
  }), [setSidebarExpanded, setSidebarMode, toggleSection]);

  return { state, actions, listRef, lastClickedIndexRef };
}
