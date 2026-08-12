'use client';

import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { kanbanLogger } from '@/lib/client-logger';
import { DEFAULT_COLUMNS } from '../components';
import type { HubProject, KanbanColumn as KanbanColumnType } from '../components';

export interface KanbanConfirmDialogState {
  open: boolean;
  title: string;
  message: string;
  confirmLabel: string;
  variant: 'danger' | 'warning';
  onConfirm: () => void | Promise<void>;
}

interface UseKanbanColumnsOptions {
  selectedProject: string;
  projects: HubProject[];
  setProjects: React.Dispatch<React.SetStateAction<HubProject[]>>;
  setConfirmDialog: React.Dispatch<React.SetStateAction<KanbanConfirmDialogState>>;
}

export function useKanbanColumns({
  selectedProject,
  projects,
  setProjects,
  setConfirmDialog,
}: UseKanbanColumnsOptions) {
  const [customColumns, setCustomColumns] = useState<KanbanColumnType[] | null>(null);
  const [editingColumns, setEditingColumns] = useState(false);
  const [newColumnName, setNewColumnName] = useState('');
  const [renamingColumn, setRenamingColumn] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');

  useEffect(() => {
    fetch('/api/kanban-settings')
      .then(r => r.json())
      .then(data => {
        if (!data.isDefault) setCustomColumns(data.columns);
      })
      .catch(err => {
        kanbanLogger.error('Failed to fetch kanban settings', { err });
      });
  }, []);

  const globalColumns = useMemo(() => customColumns || DEFAULT_COLUMNS, [customColumns]);
  const project = useMemo(
    () => projects.find(candidate => candidate.id === selectedProject),
    [projects, selectedProject],
  );

  const columns = useMemo<KanbanColumnType[]>(() => {
    if (selectedProject !== 'all' && project?.kanbanColumns?.length) {
      return project.kanbanColumns;
    }
    return globalColumns;
  }, [globalColumns, project, selectedProject]);

  const isProjectView = useMemo(
    () => selectedProject !== 'all' && !!project?.kanbanColumns?.length,
    [project, selectedProject],
  );

  async function persistProjectColumns(nextColumns: KanbanColumnType[]) {
    await fetch('/api/hub-projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: selectedProject, kanbanColumns: nextColumns }),
    });
    setProjects(prev => prev.map(item => (
      item.id === selectedProject ? { ...item, kanbanColumns: nextColumns } : item
    )));
  }

  async function persistGlobalColumns(nextColumns: KanbanColumnType[]) {
    setCustomColumns(nextColumns);
    await fetch('/api/kanban-settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ columns: nextColumns }),
    });
  }

  async function addColumn() {
    if (!newColumnName.trim()) return;
    const id = newColumnName.trim().toLowerCase().replace(/\s+/g, '-');
    const colors = ['#f59e0b', '#ec4899', '#14b8a6', '#8b5cf6', '#f97316'];
    const nextColumn: KanbanColumnType = {
      id,
      name: newColumnName.trim(),
      color: colors[columns.length % colors.length],
      order: columns.length,
      statusMapping: [],
    };

    try {
      if (isProjectView) {
        await persistProjectColumns([
          ...(project?.kanbanColumns || []),
          { ...nextColumn, globalColumnMapping: '' },
        ]);
      } else {
        await persistGlobalColumns([...globalColumns, nextColumn]);
      }
      setNewColumnName('');
    } catch {
      toast.error('Failed to add column');
    }
  }

  function removeColumn(colId: string) {
    if (columns.length <= 1) return;
    const column = columns.find(item => item.id === colId);
    setConfirmDialog({
      open: true,
      title: 'Remove column?',
      message: `This will remove the "${column?.name || 'this column'}" column from the board. Tasks in this column will become unassigned.`,
      confirmLabel: 'Remove',
      variant: 'warning',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, open: false }));
        try {
          if (isProjectView) {
            await persistProjectColumns((project?.kanbanColumns || []).filter(item => item.id !== colId));
          } else {
            await persistGlobalColumns(globalColumns.filter(item => item.id !== colId));
          }
        } catch {
          toast.error('Failed to remove column');
        }
      },
    });
  }

  function resetColumns() {
    setConfirmDialog({
      open: true,
      title: 'Reset columns?',
      message: 'This will reset all columns back to their defaults. Any custom columns will be removed.',
      confirmLabel: 'Reset',
      variant: 'warning',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, open: false }));
        try {
          if (isProjectView) {
            await fetch('/api/hub-projects', {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id: selectedProject, kanbanColumns: [] }),
            });
            setProjects(prev => prev.map(item => (
              item.id === selectedProject ? { ...item, kanbanColumns: [] } : item
            )));
          } else {
            setCustomColumns(null);
            await fetch('/api/kanban-settings', { method: 'DELETE' });
          }
          setEditingColumns(false);
        } catch {
          toast.error('Failed to reset columns');
        }
      },
    });
  }

  async function renameColumn(colId: string) {
    const name = renameValue.trim();
    if (!name) {
      setRenamingColumn(null);
      return;
    }

    try {
      if (isProjectView) {
        await persistProjectColumns((project?.kanbanColumns || []).map(item => (
          item.id === colId ? { ...item, name } : item
        )));
      } else {
        await persistGlobalColumns(globalColumns.map(item => (
          item.id === colId ? { ...item, name } : item
        )));
      }
      setRenamingColumn(null);
    } catch {
      toast.error('Failed to rename column');
    }
  }

  async function reorderColumn(colId: string, direction: 'left' | 'right') {
    const reordered = [...columns];
    const index = reordered.findIndex(item => item.id === colId);
    const targetIndex = direction === 'left' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= reordered.length) return;
    [reordered[index], reordered[targetIndex]] = [reordered[targetIndex], reordered[index]];
    const orderedColumns = reordered.map((item, order) => ({ ...item, order }));

    try {
      if (isProjectView) {
        await persistProjectColumns(orderedColumns.map(item => {
          const existing = (project?.kanbanColumns || []).find(projectColumn => projectColumn.id === item.id);
          return existing ? { ...existing, order: item.order } : item;
        }));
      } else {
        await persistGlobalColumns(orderedColumns);
      }
    } catch {
      toast.error('Failed to reorder columns');
    }
  }

  async function updateColumnMapping(colId: string, mappingValue: string) {
    if (!project) return;
    try {
      await persistProjectColumns(project.kanbanColumns.map(item => (
        item.id === colId ? { ...item, globalColumnMapping: mappingValue } : item
      )));
    } catch {
      toast.error('Failed to update mapping');
    }
  }

  async function updateWipLimit(colId: string, limit: number | undefined) {
    try {
      if (isProjectView) {
        await persistProjectColumns((project?.kanbanColumns || []).map(item => (
          item.id === colId ? { ...item, wipLimit: limit } : item
        )));
      } else {
        await persistGlobalColumns(globalColumns.map(item => (
          item.id === colId ? { ...item, wipLimit: limit } : item
        )));
      }
    } catch {
      toast.error('Failed to update WIP limit');
    }
  }

  return {
    columns,
    globalColumns,
    isProjectView,
    customColumns,
    editingColumns,
    setEditingColumns,
    newColumnName,
    setNewColumnName,
    renamingColumn,
    setRenamingColumn,
    renameValue,
    setRenameValue,
    addColumn,
    removeColumn,
    resetColumns,
    renameColumn,
    reorderColumn,
    updateColumnMapping,
    updateWipLimit,
  };
}
