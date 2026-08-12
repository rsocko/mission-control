'use client';

import { useState, useEffect } from 'react';
import { Folder, Zap, Calendar, AlertTriangle, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CaptureContext {
  projectId?: string;
  energyLevel?: 'high' | 'medium' | 'low';
  dueDate?: 'today' | 'tomorrow' | 'this_week';
  needsTriage: boolean;
}

interface Project {
  id: string;
  name: string;
  color: string;
}

interface ContextChipsProps {
  value: CaptureContext;
  onChange: (ctx: CaptureContext) => void;
  className?: string;
}

const ENERGY_LEVELS = [
  { value: 'high' as const, label: 'High', color: 'text-green-500' },
  { value: 'medium' as const, label: 'Med', color: 'text-yellow-500' },
  { value: 'low' as const, label: 'Low', color: 'text-orange-500' },
];

const DUE_DATES = [
  { value: 'today' as const, label: 'Today' },
  { value: 'tomorrow' as const, label: 'Tomorrow' },
  { value: 'this_week' as const, label: 'This week' },
];

export function ContextChips({ value, onChange, className }: ContextChipsProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showEnergyPicker, setShowEnergyPicker] = useState(false);
  const [showDuePicker, setShowDuePicker] = useState(false);

  useEffect(() => {
    fetch('/api/hub-projects')
      .then(r => r.ok ? r.json() : { projects: [] })
      .then(data => {
        const list = data?.projects ?? data;
        setProjects(Array.isArray(list) ? list : []);
      })
      .catch(() => {});
  }, []);

  const selectedProject = projects.find(p => p.id === value.projectId);

  return (
    <div className={cn('flex flex-wrap gap-2', className)}>
      {/* Project chip */}
      <div className="relative">
        <button
          type="button"
          onClick={() => { setShowProjectPicker(!showProjectPicker); setShowEnergyPicker(false); setShowDuePicker(false); }}
          aria-expanded={showProjectPicker}
          aria-haspopup="listbox"
          className={cn(
          )}
        >
          <Folder size={12} />
          {selectedProject ? selectedProject.name : 'Project'}
          {value.projectId && (
            <X
              size={10}
              className="ml-0.5 hover:text-[var(--error)]"
              onClick={(e) => { e.stopPropagation(); onChange({ ...value, projectId: undefined }); }}
            />
          )}
        </button>
        {showProjectPicker && projects.length > 0 && (
          <div className="absolute top-full mt-1 left-0 z-50 min-w-[160px] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-lg py-1 max-h-[200px] overflow-y-auto">
            {projects.map(p => (
              <button
                key={p.id}
                type="button"
                onClick={() => { onChange({ ...value, projectId: p.id }); setShowProjectPicker(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)] flex items-center gap-2"
              >
                <span className="w-2 h-2 rounded-full" style={{ backgroundColor: p.color }} />
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Energy chip */}
      <div className="relative">
        <button
          type="button"
          onClick={() => { setShowEnergyPicker(!showEnergyPicker); setShowProjectPicker(false); setShowDuePicker(false); }}
          aria-expanded={showEnergyPicker}
          aria-haspopup="listbox"
          className={cn(
          )}
        >
          <Zap size={12} />
          {value.energyLevel ? ENERGY_LEVELS.find(e => e.value === value.energyLevel)?.label : 'Energy'}
          {value.energyLevel && (
            <X
              size={10}
              className="ml-0.5 hover:text-[var(--error)]"
              onClick={(e) => { e.stopPropagation(); onChange({ ...value, energyLevel: undefined }); }}
            />
          )}
        </button>
        {showEnergyPicker && (
          <div className="absolute top-full mt-1 left-0 z-50 min-w-[100px] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-lg py-1">
            {ENERGY_LEVELS.map(e => (
              <button
                key={e.value}
                type="button"
                onClick={() => { onChange({ ...value, energyLevel: e.value }); setShowEnergyPicker(false); }}
                className={cn('w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-2)]', e.color)}
              >
                {e.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Due date chip */}
      <div className="relative">
        <button
          type="button"
          onClick={() => { setShowDuePicker(!showDuePicker); setShowProjectPicker(false); setShowEnergyPicker(false); }}
          aria-expanded={showDuePicker}
          aria-haspopup="listbox"
          className={cn(
          )}
        >
          <Calendar size={12} />
          {value.dueDate ? DUE_DATES.find(d => d.value === value.dueDate)?.label : 'Due'}
          {value.dueDate && (
            <X
              size={10}
              className="ml-0.5 hover:text-[var(--error)]"
              onClick={(e) => { e.stopPropagation(); onChange({ ...value, dueDate: undefined }); }}
            />
          )}
        </button>
        {showDuePicker && (
          <div className="absolute top-full mt-1 left-0 z-50 min-w-[110px] rounded-lg border border-[var(--border)] bg-[var(--surface-1)] shadow-lg py-1">
            {DUE_DATES.map(d => (
              <button
                key={d.value}
                type="button"
                onClick={() => { onChange({ ...value, dueDate: d.value }); setShowDuePicker(false); }}
                className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
              >
                {d.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Needs triage toggle */}
      <button
        type="button"
        onClick={() => onChange({ ...value, needsTriage: !value.needsTriage })}
        className={cn(
          'flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors border',
          value.needsTriage
            ? 'bg-orange-500/10 text-orange-500 border-orange-500/30'
            : 'bg-[var(--surface-2)] text-[var(--text-tertiary)] border-[var(--border)] hover:text-[var(--text-secondary)]'
        )}
        aria-pressed={value.needsTriage}
      >
        <AlertTriangle size={12} />
        Triage
      </button>
    </div>
  );
}
