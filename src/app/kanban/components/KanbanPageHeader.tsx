'use client';

import Link from 'next/link';
import { ChartNetwork } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SourcesDropdown } from './SourcesDropdown';
import type { KanbanProjectViewModel, SourceItem } from './types';

interface KanbanPageHeaderProps {
  availableSources: SourceItem[];
  selectedSources: string[];
  showSourceDropdown: boolean;
  selectedProject: string;
  projects: KanbanProjectViewModel[];
  bulkMode: boolean;
  onToggleSourceDropdown: () => void;
  onCloseSourceDropdown: () => void;
  onToggleSource: (id: string) => void;
  onClearSources: () => void;
  onProjectChange: (projectId: string) => void;
  onEnterBulkMode: () => void;
}

export function KanbanPageHeader({
  availableSources,
  selectedSources,
  showSourceDropdown,
  selectedProject,
  projects,
  bulkMode,
  onToggleSourceDropdown,
  onCloseSourceDropdown,
  onToggleSource,
  onClearSources,
  onProjectChange,
  onEnterBulkMode,
}: KanbanPageHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl font-semibold text-[var(--text-primary)]">Kanban Board</h2>
        <SourcesDropdown
          sources={availableSources}
          selectedSources={selectedSources}
          showDropdown={showSourceDropdown}
          onToggleDropdown={onToggleSourceDropdown}
          onCloseDropdown={onCloseSourceDropdown}
          onToggleSource={onToggleSource}
          onClear={onClearSources}
        />
        <Select value={selectedProject} onValueChange={onProjectChange}>
          <SelectTrigger className="text-sm border border-[var(--border)] rounded-md px-3 py-1.5 text-[var(--text-secondary)] bg-transparent w-auto">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Projects</SelectItem>
            {projects.map(project => (
              <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedProject !== 'all' && (
          <Link
            href={`/projects/${selectedProject}`}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-[var(--accent-400)] hover:text-[var(--accent-300)] transition-colors duration-150"
          >
            <ChartNetwork size={14} />
            View Project
          </Link>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
        {!bulkMode && (
          <button
            onClick={onEnterBulkMode}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors px-2 py-1"
          >
            Select
          </button>
        )}
        <span>Drag cards to move between columns</span>
      </div>
    </div>
  );
}
