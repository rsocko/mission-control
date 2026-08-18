'use client';

import { Suspense, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Trash2 } from 'lucide-react';
import { BulkActionBar, BulkDispositionButtons, BulkPriorityDropdown, BulkStatusDropdown, executeBulkOperation, useBulkSelection } from '@/components/bulk-actions';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { BoardControls, DEFAULT_COLUMNS, KanbanBoard, KanbanPageHeader, TaskDetailPanel } from './components';
import type {
  KanbanColumnViewModel as KanbanColumnType,
  KanbanTaskViewModel,
  SwimlaneMode,
} from './components';
import { useKanbanColumns, useKanbanSources, useKanbanTasks, type KanbanConfirmDialogState } from './hooks';
import {
  selectedTaskFieldBlockedReason,
  selectedTaskRemovalBlockedReason,
} from '@/lib/tasks/client-edit-policy';
import { useHistoryParamSelection } from '@/lib/hooks/useHistoryParamSelection';

const INITIAL_CONFIRM_DIALOG: KanbanConfirmDialogState = {
  open: false,
  title: '',
  message: '',
  confirmLabel: '',
  variant: 'danger',
  onConfirm: () => {},
};

export default function KanbanPage() {
  return (
    <Suspense>
      <KanbanPageInner />
    </Suspense>
  );
}

function KanbanPageInner() {
  const searchParams = useSearchParams();
  const [selectedProject, setSelectedProject] = useState(searchParams.get('projectId') || 'all');
  const [dragging, setDragging] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(true);
  const [showDueDates, setShowDueDates] = useState(true);
  const [quickAddColumn, setQuickAddColumn] = useState<string | null>(null);
  const [quickAddTitle, setQuickAddTitle] = useState('');
  const [expandedColumns, setExpandedColumns] = useState<Set<string>>(new Set());
  const [selectedTaskId, setSelectedTaskId] = useHistoryParamSelection('taskId');
  const [searchQuery, setSearchQuery] = useState('');
  const [swimlaneMode, setSwimlaneMode] = useState<SwimlaneMode>('none');
  const [confirmDialog, setConfirmDialog] = useState(INITIAL_CONFIRM_DIALOG);
  const bulk = useBulkSelection();

  let resolvedColumns: KanbanColumnType[] = DEFAULT_COLUMNS;
  let resolvedProjectView = false;

  const sources = useKanbanSources();
  const tasksState = useKanbanTasks({
    selectedProject,
    selectedSources: sources.selectedSources,
    columns: () => resolvedColumns,
    isProjectView: () => resolvedProjectView,
  });
  const columnsState = useKanbanColumns({
    selectedProject,
    projects: tasksState.projects,
    setProjects: tasksState.setProjects,
    setConfirmDialog,
  });

  resolvedColumns = columnsState.columns;
  resolvedProjectView = columnsState.isProjectView;
  const selectedTask = tasksState.tasks.find((task) => task.id === selectedTaskId) ?? null;
  const selectedBulkTasks = tasksState.tasks.filter((task) => bulk.bulkSelected.has(task.id));
  const selectedBulkPolicies = selectedBulkTasks.map((task) => task.editPolicy);
  const bulkStatusBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'status');
  const bulkColumnBlockedReason = selectedTaskFieldBlockedReason(
    selectedBulkPolicies,
    'kanbanPlacement',
  );
  const bulkPriorityBlockedReason = selectedTaskFieldBlockedReason(selectedBulkPolicies, 'priority');
  const bulkRemovalBlockedReason = selectedTaskRemovalBlockedReason(selectedBulkPolicies);

  const unmappedColumns = columnsState.isProjectView
    ? columnsState.columns.filter(column => !column.globalColumnMapping || !columnsState.globalColumns.find(globalColumn => globalColumn.id === column.globalColumnMapping))
    : [];

  async function handleQuickAdd(columnId: string) {
    if (!quickAddTitle.trim()) return setQuickAddColumn(null);
    const created = await tasksState.quickAddTask(columnId, quickAddTitle);
    if (created) {
      setQuickAddTitle('');
      setQuickAddColumn(null);
    }
  }

  function handleDrop(columnId: string) {
    if (columnId) {
      tasksState.handleDrop(columnId, dragging, () => setDragging(null));
    } else {
      setDragging(null);
    }
  }

  function handleTaskUpdate(taskId: string, fields: Partial<KanbanTaskViewModel>) {
    tasksState.setTasks(prev => prev.map(task => task.id === taskId ? { ...task, ...fields } : task));
  }

  function handleToggleSource(sourceId: string) {
    sources.setSelectedSources(prev => (
      prev.includes(sourceId) ? prev.filter(item => item !== sourceId) : [...prev, sourceId]
    ));
  }

  function handleDeleteSelected() {
    const count = bulk.bulkSelected.size;
    setConfirmDialog({
      open: true,
      title: `Delete ${count} task${count > 1 ? 's' : ''}?`,
      message: 'Each selected task will be removed locally, dismissed locally, closed, or deleted at its source according to its task policy.',
      confirmLabel: 'Remove tasks',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog(prev => ({ ...prev, open: false }));
        const ids = Array.from(bulk.bulkSelected);
        const { failed } = await executeBulkOperation(
          ids,
          id => fetch(`/api/tasks/${id}`, { method: 'DELETE' }),
          `${ids.length} task${ids.length > 1 ? 's' : ''} deleted`,
        );
        if (failed.length > 0) {
          bulk.setBulkSelected(new Set(failed));
        } else {
          bulk.clearSelection();
        }
        await tasksState.fetchData();
      },
    });
  }

  return (
    <div className="h-full overflow-x-auto p-6">
      <KanbanPageHeader
        availableSources={sources.availableSources}
        selectedSources={sources.selectedSources}
        showSourceDropdown={sources.showSourceDropdown}
        selectedProject={selectedProject}
        projects={tasksState.projects}
        bulkMode={bulk.bulkMode}
        onToggleSourceDropdown={() => sources.setShowSourceDropdown(!sources.showSourceDropdown)}
        onCloseSourceDropdown={() => sources.setShowSourceDropdown(false)}
        onToggleSource={handleToggleSource}
        onClearSources={() => sources.setSelectedSources([])}
        onProjectChange={setSelectedProject}
        onEnterBulkMode={bulk.enterBulkMode}
      />

      {bulk.bulkMode && (
        <div className="mb-3">
          <BulkActionBar selectedCount={bulk.bulkSelected.size} onCancel={bulk.clearSelection}>
            {columnsState.columns.length > 0 && (
              <Select
                value=""
                disabled={Boolean(bulkColumnBlockedReason)}
                onValueChange={async targetColumn => {
                  const ids = Array.from(bulk.bulkSelected);
                  const target = columnsState.columns.find(column => column.id === targetColumn);
                  const { failed } = await executeBulkOperation(
                    ids,
                    id => tasksState.moveTask(id, targetColumn) as Promise<void>,
                    `Moved ${ids.length} task${ids.length > 1 ? 's' : ''} to ${target?.name || 'column'}`,
                  );
                  if (failed.length > 0) {
                    bulk.setBulkSelected(new Set(failed));
                  } else {
                    bulk.clearSelection();
                  }
                }}
              >
                <SelectTrigger
                  variant="inline"
                  aria-label="Move selected tasks to column"
                  title={bulkColumnBlockedReason}
                  className="border-purple-800/40 bg-purple-900/30 text-purple-300 hover:bg-purple-900/50"
                >
                  <SelectValue placeholder="Move to column" />
                </SelectTrigger>
                <SelectContent>
                {columnsState.columns.map(column => (
                    <SelectItem key={column.id} value={column.id}>{column.name}</SelectItem>
                ))}
                </SelectContent>
              </Select>
            )}
            <BulkPriorityDropdown
              disabled={Boolean(bulkPriorityBlockedReason)}
              disabledReason={bulkPriorityBlockedReason}
              onSetPriority={async priority => {
                const ids = Array.from(bulk.bulkSelected);
                const { failed } = await executeBulkOperation(
                  ids,
                  id => fetch(`/api/tasks/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ priority }),
                  }),
                  `Priority set on ${ids.length} task${ids.length > 1 ? 's' : ''}`,
                );
                if (failed.length > 0) {
                  bulk.setBulkSelected(new Set(failed));
                } else {
                  bulk.clearSelection();
                }
                await tasksState.fetchData();
              }}
            />
            <BulkStatusDropdown
              disabled={Boolean(bulkStatusBlockedReason)}
              disabledReason={bulkStatusBlockedReason}
              onSetStatus={async status => {
                const ids = Array.from(bulk.bulkSelected);
                const { failed } = await executeBulkOperation(
                  ids,
                  id => fetch(`/api/tasks/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status }),
                  }),
                  `Status set on ${ids.length} task${ids.length > 1 ? 's' : ''}`,
                );
                if (failed.length > 0) {
                  bulk.setBulkSelected(new Set(failed));
                } else {
                  bulk.clearSelection();
                }
                await tasksState.fetchData();
              }}
            />
            <BulkDispositionButtons
              tasks={selectedBulkTasks}
              onSetDisposition={async (localDisposition) => {
                const ids = Array.from(bulk.bulkSelected);
                const { failed } = await executeBulkOperation(
                  ids,
                  (id) => fetch(`/api/tasks/${id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ localDisposition }),
                  }),
                  localDisposition === 'handled'
                    ? `Marked ${ids.length} task${ids.length > 1 ? 's' : ''} handled in Mission Control`
                    : `Dismissed ${ids.length} task${ids.length > 1 ? 's' : ''} in Mission Control`,
                );
                if (failed.length > 0) bulk.setBulkSelected(new Set(failed));
                else bulk.clearSelection();
                await tasksState.fetchData();
              }}
            />
            <button
              onClick={handleDeleteSelected}
              disabled={Boolean(bulkRemovalBlockedReason)}
              title={bulkRemovalBlockedReason}
              className="text-xs px-2 py-1 bg-red-900/30 text-red-300 border border-red-800/40 rounded-[var(--radius-sm)] hover:bg-red-900/50 transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Trash2 size={12} className="inline" /> Delete
            </button>
          </BulkActionBar>
        </div>
      )}

      <BoardControls
        isProjectView={columnsState.isProjectView}
        projectName={tasksState.projects.find(project => project.id === selectedProject)?.name}
        hasCustomColumns={!!columnsState.customColumns}
        editingColumns={columnsState.editingColumns}
        showSources={showSources}
        showDueDates={showDueDates}
        newColumnName={columnsState.newColumnName}
        searchQuery={searchQuery}
        swimlaneMode={swimlaneMode}
        scoreSortEnabled={tasksState.scoreSortEnabled}
        onToggleEdit={() => columnsState.setEditingColumns(!columnsState.editingColumns)}
        onResetColumns={columnsState.resetColumns}
        onShowSourcesChange={setShowSources}
        onShowDueDatesChange={setShowDueDates}
        onNewColumnNameChange={columnsState.setNewColumnName}
        onAddColumn={columnsState.addColumn}
        onSearchChange={setSearchQuery}
        onSwimlaneChange={setSwimlaneMode}
        onScoreSortChange={tasksState.setScoreSortEnabled}
      />

      <KanbanBoard
        loading={tasksState.loading}
        tasks={tasksState.tasks}
        columns={columnsState.columns}
        globalColumns={columnsState.globalColumns}
        unmappedColumns={unmappedColumns}
        isProjectView={columnsState.isProjectView}
        editingColumns={columnsState.editingColumns}
        renamingColumn={columnsState.renamingColumn}
        renameValue={columnsState.renameValue}
        quickAddColumn={quickAddColumn}
        quickAddTitle={quickAddTitle}
        expandedColumns={expandedColumns}
        showSources={showSources}
        showDueDates={showDueDates}
        searchQuery={searchQuery}
        swimlaneMode={swimlaneMode}
        showScores={tasksState.scoreSortEnabled}
        dragging={dragging}
        bulk={{
          bulkMode: bulk.bulkMode,
          bulkSelected: bulk.bulkSelected,
          toggleItem: bulk.toggleItem,
        }}
        getTasksForColumn={tasksState.getTasksForColumn}
        getSwimlaneGroups={tasksState.getSwimlaneGroups}
        getTasksForSwimlane={tasksState.getTasksForSwimlane}
        taskMatchesSearch={tasksState.taskMatchesSearch}
        onFixMappings={() => columnsState.setEditingColumns(true)}
        onDragStart={setDragging}
        onDrop={handleDrop}
        onTaskClick={(task) => setSelectedTaskId((current) => current === task.id ? null : task.id)}
        onStartRename={(id, name) => {
          columnsState.setRenamingColumn(id);
          columnsState.setRenameValue(name);
        }}
        onRenameChange={columnsState.setRenameValue}
        onConfirmRename={columnsState.renameColumn}
        onCancelRename={() => columnsState.setRenamingColumn(null)}
        onReorder={columnsState.reorderColumn}
        onRemoveColumn={columnsState.removeColumn}
        onToggleQuickAdd={columnId => {
          setQuickAddColumn(quickAddColumn === columnId ? null : columnId);
          setQuickAddTitle('');
        }}
        onWipLimitChange={columnsState.updateWipLimit}
        onUpdateColumnMapping={columnsState.updateColumnMapping}
        onExpandColumn={columnId => setExpandedColumns(prev => new Set([...prev, columnId]))}
        onCollapseColumn={columnId => setExpandedColumns(prev => {
          const next = new Set(prev);
          next.delete(columnId);
          return next;
        })}
        onQuickAddChange={setQuickAddTitle}
        onQuickAddSubmit={handleQuickAdd}
        onQuickAddCancel={() => {
          setQuickAddColumn(null);
          setQuickAddTitle('');
        }}
        onSnoozeTask={tasksState.snoozeTask}
      />

      <TaskDetailPanel
        task={selectedTask}
        onClose={() => setSelectedTaskId(null)}
        onTaskUpdate={handleTaskUpdate}
        onRefresh={tasksState.fetchData}
      />

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog(prev => ({ ...prev, open: false }))}
      />
    </div>
  );
}
