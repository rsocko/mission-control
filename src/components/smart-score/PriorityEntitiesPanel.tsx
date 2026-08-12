'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus, GripVertical, User, Users, Globe, ChartNetwork,
  Trash2, Tag, ListTree,
} from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
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
import type { EntityTier, PriorityEntity } from '@/lib/smart-score';

// ─── Constants ──────────────────────────────────────────────────────────────

const TIER_CONFIG: Record<EntityTier, { label: string; description: string; className: string; borderColor: string }> = {
  critical: {
    label: 'Critical',
    description: 'Mission-critical priorities',
    className: 'bg-red-500/10 text-red-300',
    borderColor: 'border-l-red-400',
  },
  high: {
    label: 'High',
    description: 'High-impact priorities',
    className: 'bg-amber-500/10 text-amber-300',
    borderColor: 'border-l-amber-400',
  },
  medium: {
    label: 'Medium',
    description: 'Important, but not urgent by default',
    className: 'bg-blue-500/10 text-blue-300',
    borderColor: 'border-l-blue-400',
  },
  standard: {
    label: 'Standard',
    description: 'Baseline relevance with a small boost',
    className: 'bg-slate-500/10 text-slate-300',
    borderColor: 'border-l-slate-500',
  },
};

const ENTITY_TYPE_ICONS: Record<string, React.ReactNode> = {
  person: <User className="w-3 h-3" />,
  team: <Users className="w-3 h-3" />,
  project: <ChartNetwork className="w-3 h-3" />,
  domain: <Globe className="w-3 h-3" />,
  tag: <Tag className="w-3 h-3" />,
  source: <ListTree className="w-3 h-3" />,
};

const ENTITY_COLORS = [
  '#60a5fa', '#818cf8', '#f472b6', '#f59e0b', '#10b981', '#22d3ee', '#e879f9', '#cbd5e1',
  '#f87171', '#a78bfa', '#38bdf8', '#34d399', '#fb923c', '#c084fc',
];

type CreatableEntityType = 'person' | 'project' | 'tag' | 'source';
type ReferencedEntityType = Exclude<CreatableEntityType, 'person'>;

interface EntityOption {
  id: string;
  name: string;
  label?: string;
  description?: string | null;
  color?: string | null;
}

type EntityOptions = Record<ReferencedEntityType, EntityOption[]>;

const EMPTY_OPTIONS: EntityOptions = {
  project: [],
  tag: [],
  source: [],
};

async function requestEntities(): Promise<PriorityEntity[]> {
  const res = await fetch('/api/priority-entities');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return data.entities || [];
}

async function requestOptions(): Promise<EntityOptions> {
  const res = await fetch('/api/priority-entities/options');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return {
    project: data.projects || [],
    tag: data.tags || [],
    source: data.sources || [],
  };
}

// ─── Sortable Entity Card ───────────────────────────────────────────────────

function SortableEntityCard({
  entity,
  onDelete,
}: {
  entity: PriorityEntity;
  onDelete: (id: string) => void;
}) {
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: entity.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative bg-surface-1 border border-slate-700/70 border-l-[3px] rounded-xl p-3.5 min-h-[90px] transition-[border-color,box-shadow] hover:border-blue-400/20 hover:shadow-lg ${TIER_CONFIG[entity.tier]?.borderColor || 'border-l-slate-500'}`}
      {...attributes}
    >
      <button
        {...listeners}
        className="absolute top-2.5 right-2.5 text-slate-600 hover:text-slate-400 cursor-grab active:cursor-grabbing"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>

      <div className="flex items-center justify-between mb-2.5">
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-900/90 border border-slate-700/70 text-xs text-slate-400">
          {ENTITY_TYPE_ICONS[entity.type]}
          <span className="capitalize">{entity.type}</span>
        </span>
        <span className="inline-flex items-center justify-center w-7 h-7 rounded-lg bg-blue-500/15 text-blue-400 text-xs font-bold tabular-nums">
          #{entity.rank}
        </span>
      </div>

      <div className="text-sm font-semibold text-slate-100">{entity.name}</div>
      {entity.referenceStatus === 'missing' && (
        <div className="text-xs text-red-300 mt-1">Referenced item was removed</div>
      )}
      {entity.description && (
        <div className="text-xs text-slate-400 mt-1 line-clamp-2">{entity.description}</div>
      )}

      <div className="flex items-center justify-between mt-3">
        <div className="flex items-center gap-1.5">
          <span
            className="w-3.5 h-3.5 rounded-full border-2 border-white/10"
            style={{ backgroundColor: entity.color }}
          />
        </div>
        <button
          onClick={() => onDelete(entity.id)}
          className="text-slate-600 hover:text-red-400 transition-colors p-1"
          aria-label="Delete entity"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
    </div>
  );
}

// ─── Add Entity Form ────────────────────────────────────────────────────────

function AddEntityForm({
  options,
  onAdd,
  onCancel,
}: {
  options: EntityOptions;
  onAdd: (data: { name: string; type: CreatableEntityType; referenceId?: string; description: string; color: string }) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<CreatableEntityType>('person');
  const [referenceId, setReferenceId] = useState('');
  const [description, setDescription] = useState('');
  const [color, setColor] = useState(ENTITY_COLORS[0]);
  const referencedOptions = type === 'person' ? [] : options[type];
  const canAdd = type === 'person' ? Boolean(name.trim()) : Boolean(referenceId);

  const changeType = (nextType: CreatableEntityType) => {
    setType(nextType);
    setName('');
    setReferenceId('');
    setDescription('');
  };

  const selectReference = (id: string) => {
    setReferenceId(id);
    const option = referencedOptions.find((candidate) => candidate.id === id);
    setName(option?.name || '');
    setDescription(option?.description || '');
    if (option?.color) setColor(option.color);
  };

  return (
    <div className="bg-surface-1 border border-blue-500/20 rounded-xl p-4 space-y-3">
      <div className="flex items-center gap-2">
        {type === 'person' ? (
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Person name..."
            aria-label="Person name"
            className="flex-1 bg-surface-0 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none"
            autoFocus
          />
        ) : (
          <Select value={referenceId} onValueChange={selectReference}>
            <SelectTrigger
              aria-label={`Select ${type}`}
              className="h-9 min-h-0 flex-1"
              autoFocus
            >
              <SelectValue placeholder={`Select ${type}...`} />
            </SelectTrigger>
            <SelectContent>
              {referencedOptions.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.label || option.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Select
          value={type}
          onValueChange={(value) => {
            if (value === 'person' || value === 'project' || value === 'tag' || value === 'source') {
              changeType(value);
            }
          }}
        >
          <SelectTrigger aria-label="Entity type" className="h-9 min-h-0 w-[120px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="person">Person</SelectItem>
            <SelectItem value="project">Project</SelectItem>
            <SelectItem value="tag">Tag</SelectItem>
            <SelectItem value="source">Source</SelectItem>
          </SelectContent>
        </Select>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Short description..."
          className="flex-1 bg-surface-0 border border-slate-700 rounded-lg px-3 py-2 text-xs text-slate-300 placeholder:text-slate-500 focus:outline-none"
        />
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        {ENTITY_COLORS.map((c) => (
          <button
            key={c}
            onClick={() => setColor(c)}
            className={`w-4 h-4 rounded-full border-2 transition-transform ${color === c ? 'border-blue-400 scale-110' : 'border-white/10'}`}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button onClick={onCancel} className="text-xs text-slate-400 hover:text-white px-3 py-1.5 rounded-lg">
          Cancel
        </button>
        <button
          onClick={() => {
            if (canAdd) {
              onAdd({
                name: name.trim(),
                type,
                referenceId: type === 'person' ? undefined : referenceId,
                description,
                color,
              });
            }
          }}
          disabled={!canAdd}
          className="text-xs font-medium bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white px-3 py-1.5 rounded-lg transition-colors"
        >
          Add
        </button>
      </div>
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────

export function PriorityEntitiesPanel() {
  const [entities, setEntities] = useState<PriorityEntity[]>([]);
  const [options, setOptions] = useState<EntityOptions>(EMPTY_OPTIONS);
  const [loading, setLoading] = useState(true);
  const [addingToTier, setAddingToTier] = useState<EntityTier | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const fetchEntities = useCallback(async () => {
    try {
      setEntities(await requestEntities());
    } catch {
      toast.error('Failed to load priority entities');
    }
  }, []);

  useEffect(() => {
    let active = true;
    void requestEntities()
      .then((loadedEntities) => { if (active) setEntities(loadedEntities); })
      .catch(() => { if (active) toast.error('Failed to load priority entities'); })
      .finally(() => { if (active) setLoading(false); });
    void requestOptions()
      .then((loadedOptions) => { if (active) setOptions(loadedOptions); })
      .catch(() => { if (active) toast.error('Failed to load entity options'); });
    return () => { active = false; };
  }, []);

  const handleDragEnd = useCallback(async (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = entities.findIndex((e) => e.id === active.id);
    const newIndex = entities.findIndex((e) => e.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(entities, oldIndex, newIndex).map((e, idx) => ({
      ...e,
      rank: idx + 1,
    }));
    setEntities(reordered);

    // Persist
    try {
      await fetch('/api/priority-entities', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entities: reordered.map((e) => ({ id: e.id, rank: e.rank })) }),
      });
    } catch {
      toast.error('Failed to save reorder');
    }
  }, [entities]);

  const handleAdd = useCallback(async (tier: EntityTier, data: { name: string; type: CreatableEntityType; referenceId?: string; description: string; color: string }) => {
    try {
      const entitiesInTier = entities.filter((e) => e.tier === tier);
      const tierOrder: EntityTier[] = ['critical', 'high', 'medium', 'standard'];
      const tierIndex = tierOrder.indexOf(tier);

      // Place at end of the tier's rank section
      const allBeforeTier = entities.filter((e) => tierOrder.indexOf(e.tier) < tierIndex);
      const rank = allBeforeTier.length + entitiesInTier.length + 1;

      const res = await fetch('/api/priority-entities', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, tier, rank }),
      });

      if (res.ok) {
        toast.success(`Added ${data.name}`);
        setAddingToTier(null);
        fetchEntities();
      }
    } catch {
      toast.error('Failed to add entity');
    }
  }, [entities, fetchEntities]);

  const handleDelete = useCallback(async (id: string) => {
    try {
      await fetch(`/api/priority-entities?id=${id}`, { method: 'DELETE' });
      toast.success('Entity removed');
      fetchEntities();
    } catch {
      toast.error('Failed to remove entity');
    }
  }, [fetchEntities]);

  const tierOrder: EntityTier[] = ['critical', 'high', 'medium', 'standard'];

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-2xl bg-slate-800/50" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-5 pb-5 border-b border-slate-800">
        <div>
          <h2 className="text-2xl font-semibold">Priority Entities</h2>
          <p className="text-sm text-slate-400 mt-2">
            Rank who and what matters. This powers your AI scores.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-slate-900/80 border border-slate-700/70 text-xs text-slate-400 font-medium">
            <span className="text-blue-400">⚡</span> Scoring uses entity tiers
          </span>
        </div>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={entities.map((e) => e.id)} strategy={verticalListSortingStrategy}>
          {tierOrder.map((tier) => {
            const tierEntities = entities.filter((e) => e.tier === tier);
            const config = TIER_CONFIG[tier];

            return (
              <section
                key={tier}
                className="rounded-2xl border border-slate-700/70 bg-slate-900/40 p-4"
              >
                <div className="flex items-center justify-between gap-4 mb-4">
                  <div>
                    <span className={`inline-flex items-center gap-2 px-2.5 py-1 rounded-full text-xs font-bold uppercase tracking-wide ${config.className}`}>
                      {config.label}
                    </span>
                    <p className="text-sm text-slate-400 mt-1.5">{config.description}</p>
                  </div>
                  <span className="px-2.5 py-1 rounded-full bg-slate-900/90 border border-slate-700/70 text-xs text-slate-400 font-semibold tabular-nums">
                    {tierEntities.length} {tierEntities.length === 1 ? 'entity' : 'entities'}
                  </span>
                </div>

                <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
                  {tierEntities.map((entity) => (
                    <SortableEntityCard
                      key={entity.id}
                      entity={entity}
                      onDelete={handleDelete}
                    />
                  ))}

                  {addingToTier === tier ? (
                    <AddEntityForm
                      options={options}
                      onAdd={(data) => handleAdd(tier, data)}
                      onCancel={() => setAddingToTier(null)}
                    />
                  ) : (
                    <button
                      onClick={() => setAddingToTier(tier)}
                      className="flex items-center justify-center min-h-[90px] rounded-xl border border-dashed border-slate-700/70 bg-slate-900/30 text-slate-500 hover:text-blue-400 hover:border-blue-500/30 transition-colors"
                    >
                      <div className="text-center">
                        <Plus className="w-5 h-5 mx-auto mb-1" />
                        <div className="text-xs font-medium">Add entity</div>
                      </div>
                    </button>
                  )}
                </div>
              </section>
            );
          })}
        </SortableContext>
      </DndContext>
    </div>
  );
}
