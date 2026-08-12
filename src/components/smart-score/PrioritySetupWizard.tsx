'use client';

import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Star, ArrowRight, ArrowLeft, Check, GripVertical,
  GitBranch, CheckSquare, Calendar, Mail, X, Sparkles,
} from 'lucide-react';
import {
  DndContext, closestCenter, PointerSensor, useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { uiLogger } from '@/lib/client-logger';
import { Modal } from '@/components/ui/Modal';

// ─── Types ──────────────────────────────────────────────────────────────────

interface WizardSource {
  id: string;
  connectorType: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  rank: number;
}

interface WizardEntity {
  id: string;
  name: string;
  type: 'person' | 'project' | 'tag' | 'source';
  referenceId?: string;
  description: string;
  tier: 'critical' | 'high' | 'medium' | 'standard';
  rank: number;
}

interface WizardEntityOption {
  id: string;
  name: string;
  label?: string;
  description?: string | null;
}

// ─── Sortable Row ───────────────────────────────────────────────────────────

function SortableRow({
  id,
  rank,
  label,
  children,
  trailing,
}: {
  id: string;
  rank: number;
  label: string;
  children: React.ReactNode;
  trailing: React.ReactNode;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.6 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`grid grid-cols-[40px_44px_minmax(0,1fr)] items-center gap-2 rounded-2xl border border-slate-700/70 bg-slate-900/70 px-3 py-3 transition-[border-color,box-shadow,transform] sm:grid-cols-[40px_52px_minmax(0,1fr)_auto] sm:gap-3 sm:px-4 ${isDragging ? 'border-blue-500/50 shadow-lg' : 'hover:border-blue-400/20 hover:-translate-y-0.5'}`}
      {...attributes}
    >
      <button
        {...listeners}
        className="flex min-h-10 min-w-10 cursor-grab items-center justify-center rounded-lg text-slate-600 hover:bg-slate-800 hover:text-slate-300 active:cursor-grabbing"
        aria-label={`Reorder ${label}`}
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <span className="inline-flex min-w-[44px] items-center justify-center rounded-xl bg-blue-500/15 px-2 py-1.5 text-xs font-bold tabular-nums text-blue-400 sm:px-2.5">
        #{rank}
      </span>
      <div className="min-w-0">{children}</div>
      <div className="col-start-3 row-start-2 mt-1 min-w-0 sm:col-start-auto sm:row-start-auto sm:mt-0">
        {trailing}
      </div>
    </div>
  );
}

// ─── Step Components ────────────────────────────────────────────────────────

function StepSources({
  sources,
  setSources,
}: {
  sources: WizardSource[];
  setSources: (s: WizardSource[]) => void;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sources.findIndex((s) => s.id === active.id);
    const newIdx = sources.findIndex((s) => s.id === over.id);
    const reordered = arrayMove(sources, oldIdx, newIdx).map((s, i) => ({ ...s, rank: i + 1 }));
    setSources(reordered);
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">What matters most?</h3>
        <p className="text-sm text-slate-400 mt-2 max-w-[60ch]">
          Drag your connected sources in order of importance. The AI scoring engine uses this to prioritize tasks from each system.
        </p>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sources.map((s) => s.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2.5">
            {sources.map((source) => (
              <SortableRow
                key={source.id}
                id={source.id}
                rank={source.rank}
                label={source.name}
                trailing={(
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/70 bg-slate-900/80 px-2.5 py-1 text-xs font-medium text-slate-400 sm:whitespace-nowrap">
                    {source.rank === 1 ? 'Strongest signal' : source.rank === 2 ? 'Daily execution' : source.rank === 3 ? 'Time anchors' : 'Context'}
                  </span>
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <span className="w-9 h-9 rounded-xl flex items-center justify-center text-lg bg-slate-800/80">
                    {source.icon}
                  </span>
                  <div className="min-w-0">
                    <div className="text-sm font-semibold">{source.name}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{source.description}</div>
                  </div>
                </div>
              </SortableRow>
            ))}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  );
}

function StepProjects({
  projects,
  setProjects,
  availableProjects,
}: {
  projects: WizardEntity[];
  setProjects: (p: WizardEntity[]) => void;
  availableProjects: Array<{ id: string; name: string; description?: string | null }>;
}) {
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = projects.findIndex((p) => p.id === active.id);
    const newIdx = projects.findIndex((p) => p.id === over.id);
    const reordered = arrayMove(projects, oldIdx, newIdx).map((p, i) => ({
      ...p,
      rank: i + 1,
      tier: i < 2 ? 'critical' as const : i < 4 ? 'high' as const : 'medium' as const,
    }));
    setProjects(reordered);
  };

  const addProject = () => {
    const selectedProject = availableProjects.find((project) => project.id === selectedProjectId);
    if (!selectedProject) return;
    const tier = projects.length < 2 ? 'critical' as const : projects.length < 4 ? 'high' as const : 'medium' as const;
    setProjects([...projects, {
      id: selectedProject.id,
      name: selectedProject.name,
      type: 'project',
      referenceId: selectedProject.id,
      description: selectedProject.description || '',
      tier,
      rank: projects.length + 1,
    }]);
    setSelectedProjectId('');
  };
  const unselectedProjects = availableProjects.filter(
    (candidate) => !projects.some((project) => project.referenceId === candidate.id),
  );

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">Rank your active projects</h3>
        <p className="text-sm text-slate-400 mt-2 max-w-[60ch]">
          The top positions become Critical and High scoring tiers. Drag to reorder.
        </p>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={projects.map((p) => p.id)} strategy={verticalListSortingStrategy}>
          <div className="space-y-2.5">
            {projects.map((project) => (
              <SortableRow
                key={project.id}
                id={project.id}
                rank={project.rank}
                label={project.name}
                trailing={(
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-wide ${project.tier === 'critical' ? 'bg-red-500/10 text-red-300' : project.tier === 'high' ? 'bg-amber-500/10 text-amber-300' : 'bg-blue-500/10 text-blue-300'}`}>
                    {project.tier}
                  </span>
                )}
              >
                <div className="min-w-0">
                  <div className="text-sm font-semibold">{project.name}</div>
                </div>
              </SortableRow>
            ))}
          </div>
        </SortableContext>
      </DndContext>
      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Select value={selectedProjectId} onValueChange={setSelectedProjectId}>
          <SelectTrigger aria-label="Select project" className="flex-1">
            <SelectValue placeholder="Select a project..." />
          </SelectTrigger>
          <SelectContent>
            {unselectedProjects.map((project) => (
              <SelectItem key={project.id} value={project.id}>
                {project.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={addProject}
          disabled={!selectedProjectId}
          className="min-h-11 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 sm:w-auto"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function StepPeople({
  people,
  setPeople,
}: {
  people: WizardEntity[];
  setPeople: (p: WizardEntity[]) => void;
}) {
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');

  const addPerson = () => {
    if (!newName.trim()) return;
    const tier = people.length < 2 ? 'critical' as const : people.length < 4 ? 'high' as const : 'medium' as const;
    setPeople([...people, {
      id: `person-${Date.now()}`,
      name: newName.trim(),
      type: 'person',
      description: newDesc.trim(),
      tier,
      rank: people.length + 1,
    }]);
    setNewName('');
    setNewDesc('');
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">Key people</h3>
        <p className="text-sm text-slate-400 mt-2 max-w-[60ch]">
          Who is the work for or about? Add people whose related tasks should surface first.
        </p>
      </div>
      <div className="space-y-2.5">
        {people.map((person, idx) => (
          <div key={person.id} className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-slate-900/70 border border-slate-700/70">
            <span className="inline-flex items-center justify-center min-w-[44px] px-2.5 py-1.5 rounded-xl bg-blue-500/15 text-blue-400 text-xs font-bold tabular-nums">
              #{idx + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold">{person.name}</div>
              {person.description && <div className="text-xs text-slate-400 mt-0.5">{person.description}</div>}
            </div>
            <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${person.tier === 'critical' ? 'bg-red-500/10 text-red-300' : person.tier === 'high' ? 'bg-amber-500/10 text-amber-300' : 'bg-blue-500/10 text-blue-300'}`}>
              {person.tier}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 p-4 rounded-2xl bg-slate-900/50 border border-slate-700/60 space-y-2.5">
        <input
          type="text"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          placeholder="Person name..."
          className="w-full bg-surface-0 border border-slate-700 rounded-xl px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
        />
        <input
          type="text"
          value={newDesc}
          onChange={(e) => setNewDesc(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addPerson()}
          placeholder="Role or context (optional)..."
          className="w-full bg-surface-0 border border-slate-700 rounded-xl px-3 py-2 text-xs text-slate-300 placeholder:text-slate-500 focus:border-blue-500 focus:outline-none"
        />
        <button
          onClick={addPerson}
          disabled={!newName.trim()}
          className="w-full px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-sm font-medium text-white transition-colors"
        >
          Add person
        </button>
      </div>
    </div>
  );
}

function StepTagsAndSources({
  entities,
  setEntities,
  availableTags,
  availableSources,
}: {
  entities: WizardEntity[];
  setEntities: (entities: WizardEntity[]) => void;
  availableTags: WizardEntityOption[];
  availableSources: WizardEntityOption[];
}) {
  const [type, setType] = useState<'tag' | 'source'>('tag');
  const [referenceId, setReferenceId] = useState('');
  const options = type === 'tag' ? availableTags : availableSources;
  const availableOptions = options.filter(
    (option) => !entities.some((entity) => entity.type === type && entity.referenceId === option.id),
  );

  const addEntity = () => {
    const selected = options.find((option) => option.id === referenceId);
    if (!selected) return;
    const tier = entities.length < 2 ? 'critical' as const : entities.length < 4 ? 'high' as const : 'medium' as const;
    setEntities([...entities, {
      id: `${type}:${selected.id}`,
      name: selected.name,
      type,
      referenceId: selected.id,
      description: selected.description || '',
      tier,
      rank: entities.length + 1,
    }]);
    setReferenceId('');
  };

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">Priority tags and sources</h3>
        <p className="text-sm text-slate-400 mt-2 max-w-[60ch]">
          Add tags or source lists that should raise the score of linked tasks.
        </p>
      </div>
      <div className="space-y-2.5">
        {entities.map((entity) => (
          <div key={entity.id} className="flex items-center gap-3 px-4 py-3 rounded-2xl bg-slate-900/70 border border-slate-700/70">
            <span className="text-xs font-bold uppercase text-blue-300">{entity.type}</span>
            <span className="text-sm font-semibold flex-1">{entity.name}</span>
            <span className={`text-xs font-bold uppercase ${entity.tier === 'critical' ? 'text-red-300' : entity.tier === 'high' ? 'text-amber-300' : 'text-blue-300'}`}>
              {entity.tier}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[auto_1fr_auto]">
        <Select
          value={type}
          onValueChange={(value) => {
            if (value === 'tag' || value === 'source') {
              setType(value);
              setReferenceId('');
            }
          }}
        >
          <SelectTrigger aria-label="Priority entity type" className="w-full sm:w-[110px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="tag">Tag</SelectItem>
            <SelectItem value="source">Source</SelectItem>
          </SelectContent>
        </Select>
        <Select value={referenceId} onValueChange={setReferenceId}>
          <SelectTrigger aria-label={`Select ${type}`}>
            <SelectValue placeholder={`Select ${type}...`} />
          </SelectTrigger>
          <SelectContent>
            {availableOptions.map((option) => (
              <SelectItem key={option.id} value={option.id}>
                {option.label || option.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <button
          onClick={addEntity}
          disabled={!referenceId}
          className="min-h-11 w-full rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-500 disabled:opacity-40 sm:w-auto"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function StepReview({
  sources,
  projects,
  contextEntities,
  people,
}: {
  sources: WizardSource[];
  projects: WizardEntity[];
  contextEntities: WizardEntity[];
  people: WizardEntity[];
}) {
  const allEntities = [...projects, ...contextEntities, ...people].sort((a, b) => {
    const tierOrder = { critical: 0, high: 1, medium: 2, standard: 3 };
    return tierOrder[a.tier] - tierOrder[b.tier] || a.rank - b.rank;
  });

  return (
    <div>
      <div className="mb-4">
        <h3 className="text-xl font-semibold">Review your setup</h3>
        <p className="text-sm text-slate-400 mt-2">
          Here&apos;s what the scoring engine will use. You can always adjust later in Settings → Priority Entities.
        </p>
      </div>

      <div className="space-y-4">
        <div className="p-4 rounded-2xl bg-gradient-to-b from-blue-900/20 to-slate-900/60 border border-blue-500/15">
          <div className="text-xs font-bold uppercase tracking-widest text-blue-400 mb-2">Source Rankings</div>
          <div className="space-y-1">
            {sources.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-slate-500 w-5 font-medium">#{s.rank}</span>
                <span className="text-slate-200">{s.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="p-4 rounded-2xl bg-slate-900/50 border border-slate-700/60">
          <div className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-2">
            Priority Entities ({allEntities.length})
          </div>
          <div className="space-y-1.5">
            {allEntities.map((entity, idx) => (
              <div key={entity.id} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-slate-500 w-5 font-medium">#{idx + 1}</span>
                <span className="text-slate-200">{entity.name}</span>
                <span className={`ml-auto text-xs font-bold uppercase ${entity.tier === 'critical' ? 'text-red-300' : entity.tier === 'high' ? 'text-amber-300' : 'text-blue-300'}`}>
                  {entity.tier}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Main Wizard ────────────────────────────────────────────────────────────

interface PrioritySetupWizardProps {
  onComplete: () => void;
  onDismiss: () => void;
}

export function PrioritySetupWizard({ onComplete, onDismiss }: PrioritySetupWizardProps) {
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const prefersReducedMotion = useReducedMotion();

  // Wizard state
  const [sources, setSources] = useState<WizardSource[]>([
    { id: 'github', connectorType: 'github-issues', name: 'GitHub Issues', description: 'Code and engineering work', icon: <GitBranch className="w-4 h-4 text-purple-300" />, rank: 1 },
    { id: 'ms-todo', connectorType: 'microsoft-todo', name: 'Microsoft Todo', description: 'Personal tasks and lists', icon: <CheckSquare className="w-4 h-4 text-blue-300" />, rank: 2 },
    { id: 'calendar', connectorType: 'outlook-calendar', name: 'Outlook Calendar', description: 'Meetings and events', icon: <Calendar className="w-4 h-4 text-amber-300" />, rank: 3 },
    { id: 'email', connectorType: 'outlook-email', name: 'Outlook Email', description: 'Messages and follow-ups', icon: <Mail className="w-4 h-4 text-emerald-300" />, rank: 4 },
  ]);

  const [projects, setProjects] = useState<WizardEntity[]>([]);
  const [contextEntities, setContextEntities] = useState<WizardEntity[]>([]);
  const [people, setPeople] = useState<WizardEntity[]>([]);
  const [availableProjects, setAvailableProjects] = useState<Array<{ id: string; name: string; description?: string | null }>>([]);
  const [availableTags, setAvailableTags] = useState<WizardEntityOption[]>([]);
  const [availableSources, setAvailableSources] = useState<WizardEntityOption[]>([]);

  useEffect(() => {
    fetch('/api/priority-entities/options')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data) => {
        setAvailableProjects(data.projects || []);
        setAvailableTags(data.tags || []);
        setAvailableSources(data.sources || []);
      })
      .catch((err) => { uiLogger.warn('Failed to load priority entity options', { err }); });
  }, []);

  const STEPS = [
    { num: 1, label: 'Systems' },
    { num: 2, label: 'Projects' },
    { num: 3, label: 'Tags & Sources' },
    { num: 4, label: 'People' },
    { num: 5, label: 'Review' },
  ];

  const canProceed = () => {
    if (step === 1) return sources.length > 0;
    if (step === 2) return true; // projects optional
    if (step === 3) return true; // tags and sources optional
    if (step === 4) return true; // people optional
    return true;
  };

  const handleFinish = async () => {
    setSaving(true);
    try {
      // Save source rankings
      const sourceRankingsResponse = await fetch('/api/source-rankings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rankings: sources.map((s) => ({
            id: s.id,
            connectorType: s.connectorType,
            name: s.name,
            rank: s.rank,
          })),
        }),
      });
      if (!sourceRankingsResponse.ok) {
        throw new Error('Failed to save source rankings');
      }

      // Save priority entities
      const allEntities = [
        ...projects.map((p, idx) => ({ ...p, rank: idx + 1 })),
        ...contextEntities.map((entity, idx) => ({ ...entity, rank: projects.length + idx + 1 })),
        ...people.map((p, idx) => ({ ...p, rank: projects.length + contextEntities.length + idx + 1 })),
      ];

      for (const entity of allEntities) {
        const entityResponse = await fetch('/api/priority-entities', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: entity.name,
            type: entity.type,
            referenceId: entity.referenceId,
            description: entity.description,
            tier: entity.tier,
            rank: entity.rank,
            color: entity.type === 'person'
              ? '#60a5fa'
              : entity.type === 'project'
                ? '#a78bfa'
                : entity.type === 'tag'
                  ? '#10b981'
                  : '#38bdf8',
          }),
        });
        if (!entityResponse.ok) {
          throw new Error(`Failed to save priority entity: ${entity.name}`);
        }
      }

      // Mark wizard as completed in smartScoreSettings table
      await fetch('/api/smart-score/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: 'priority_wizard_completed', value: 'true' }),
      }).catch((err) => { uiLogger.warn('Failed to persist wizard completion to API', { err }); }); // Non-critical — localStorage is the primary guard

      toast.success('Priority scoring is live!');
      onComplete();
    } catch {
      toast.error('Failed to save setup');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      isOpen
      onClose={onDismiss}
      ariaLabel="Priority Entities"
      showClose={false}
      closeOnBackdropClick={false}
      overlayClassName="items-center p-3 pt-3 sm:p-7 sm:pt-7"
      className="max-h-[calc(100dvh-1.5rem)] w-full max-w-[620px] overflow-hidden bg-gradient-to-b from-slate-800/98 to-slate-900/98 sm:max-h-[calc(100dvh-3.5rem)]"
    >
        <div className="flex min-h-0 flex-1 flex-col p-4 sm:p-6 md:p-7">
          {/* Header */}
          <div className="flex shrink-0 items-start justify-between gap-4">
            <div>
              <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full text-xs font-semibold text-blue-400 bg-blue-900/20 border border-blue-500/15">
                <Star className="w-3.5 h-3.5" /> First-launch setup
              </span>
              <h2 className="mt-4 text-2xl font-semibold">
                Priority Entities
              </h2>
              <p className="mt-2 max-w-[58ch] text-sm text-slate-400">
                Get to your first trustworthy score by ranking the systems, projects, tags, sources, and people that move your day.
              </p>
            </div>
            <button
              onClick={onDismiss}
              className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-slate-500 transition-colors hover:bg-slate-700/60 hover:text-white"
              aria-label="Dismiss priority setup"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Stepper */}
          <div className="mt-4 shrink-0 border-b border-slate-700/70 pb-4 sm:mt-6">
            <p className="mb-2 text-xs font-medium text-slate-400 sm:hidden">
              Step {step} of {STEPS.length}: {STEPS[step - 1].label}
            </p>
            <div className="grid grid-cols-5 gap-1.5 sm:gap-2.5">
              {STEPS.map((s) => (
                <button
                  key={s.num}
                  onClick={() => setStep(s.num)}
                  disabled={s.num > step}
                  aria-current={s.num === step ? 'step' : undefined}
                  aria-label={`Step ${s.num}: ${s.label}`}
                  className={`flex min-h-10 min-w-0 items-center justify-center gap-1 rounded-full px-1 text-xs font-bold transition-[background-color,color] sm:gap-2 sm:px-3 ${
                    s.num === step ? 'bg-blue-600 text-white' :
                    s.num < step ? 'text-emerald-300' :
                    'text-slate-500'
                  }`}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-xs ${
                    s.num < step ? 'bg-emerald-500/15 text-emerald-400' :
                    s.num === step ? '' :
                    'border border-slate-600 text-slate-600'
                  }`}>
                    {s.num < step ? <Check className="w-3 h-3" /> : s.num}
                  </span>
                  <span className="hidden min-w-0 truncate sm:inline">{s.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Step Content */}
          <div className="mt-4 min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1 sm:mt-6 sm:min-h-[340px]">
            <AnimatePresence mode="wait">
              <motion.div
                key={step}
                initial={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, x: -16 }}
                transition={{ duration: 0.2 }}
              >
                {step === 1 && <StepSources sources={sources} setSources={setSources} />}
                {step === 2 && <StepProjects projects={projects} setProjects={setProjects} availableProjects={availableProjects} />}
                {step === 3 && (
                  <StepTagsAndSources
                    entities={contextEntities}
                    setEntities={setContextEntities}
                    availableTags={availableTags}
                    availableSources={availableSources}
                  />
                )}
                {step === 4 && <StepPeople people={people} setPeople={setPeople} />}
                {step === 5 && (
                  <StepReview
                    sources={sources}
                    projects={projects}
                    contextEntities={contextEntities}
                    people={people}
                  />
                )}
              </motion.div>
            </AnimatePresence>
          </div>

          {/* Footer */}
          <div className="mt-4 flex shrink-0 items-center justify-between gap-3 border-t border-slate-700/70 pt-4 sm:mt-6 sm:gap-4">
            <button
              onClick={onDismiss}
              className="min-h-11 rounded-lg px-3 py-2 text-sm font-medium text-slate-400 transition-colors hover:bg-slate-700/50 hover:text-white"
            >
              Skip for now
            </button>
            <div className="flex items-center gap-3">
              {step > 1 && (
                <button
                  onClick={() => setStep(step - 1)}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl border border-slate-700 bg-slate-900/60 px-3 py-2.5 text-sm font-semibold text-slate-200 transition-colors hover:border-blue-500/30 sm:px-4"
                >
                  <ArrowLeft className="w-4 h-4" /> Back
                </button>
              )}
              {step < 5 ? (
                <button
                  onClick={() => setStep(step + 1)}
                  disabled={!canProceed()}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:opacity-40"
                >
                  Next <ArrowRight className="w-4 h-4" />
                </button>
              ) : (
                <button
                  onClick={handleFinish}
                  disabled={saving}
                  className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-blue-600/20 transition-colors hover:bg-blue-500 disabled:opacity-40"
                >
                  {saving ? 'Saving...' : <><Sparkles className="w-4 h-4" /> Launch scoring</>}
                </button>
              )}
            </div>
          </div>
        </div>
    </Modal>
  );
}
