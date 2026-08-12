'use client';

import { useCallback, useEffect, useState } from 'react';
import { GripVertical, Pin, PinOff, Plus, X } from 'lucide-react';
import {
  DndContext, closestCenter, KeyboardSensor, PointerSensor,
  useSensor, useSensors, type DragEndEvent,
} from '@dnd-kit/core';
import {
  arrayMove, SortableContext, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { toast } from 'sonner';
import {
  KPI_REGISTRY, KPI_PRESETS, MAX_KPI_CARDS,
} from '@/lib/kpi/registry';
import { getStoredConfig, saveConfig, type KpiBarConfig } from '@/components/kpi/KpiBar';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';

// ─── Sortable KPI Item ─────────────────────────────────────────────────────

function SortableKpiItem({ slug, isPinned, onTogglePin, onRemove }: {
  slug: string;
  isPinned: boolean;
  onTogglePin: () => void;
  onRemove: () => void;
}) {
  const def = KPI_REGISTRY[slug];
  const {
    attributes, listeners, setNodeRef, transform, transition, isDragging,
  } = useSortable({ id: slug });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 10 : undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  if (!def) return null;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 px-3 py-2.5 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg group"
    >
      <button {...attributes} {...listeners} className="cursor-grab active:cursor-grabbing text-[var(--text-muted)] hover:text-[var(--text-secondary)]">
        <GripVertical size={16} />
      </button>
      <span className="flex-1 text-sm text-[var(--text-primary)]">{def.label}</span>
      <span className="text-xs text-[var(--text-muted)] capitalize">{def.category.replace('_', ' ')}</span>
      <button
        onClick={onTogglePin}
        className={`p-1 rounded transition-colors ${
          isPinned
            ? 'text-blue-400 hover:text-blue-300'
            : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
        }`}
        title={isPinned ? 'Unpin (allow rotation)' : 'Pin (always show)'}
      >
        {isPinned ? <Pin size={14} /> : <PinOff size={14} />}
      </button>
      <button
        onClick={onRemove}
        className="p-1 rounded text-[var(--text-muted)] hover:text-red-400 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100 transition-opacity"
        title="Remove card"
      >
        <X size={14} />
      </button>
    </div>
  );
}

// ─── Add KPI Popover ────────────────────────────────────────────────────────

function AddKpiButton({ selectedSlugs, onAdd }: { selectedSlugs: string[]; onAdd: (slug: string) => void }) {
  const [open, setOpen] = useState(false);
  const available = Object.values(KPI_REGISTRY).filter(d => !selectedSlugs.includes(d.slug));

  const categories = {
    task_counts: available.filter(d => d.category === 'task_counts'),
    progress: available.filter(d => d.category === 'progress'),
    integrations: available.filter(d => d.category === 'integrations'),
  };

  if (available.length === 0) return null;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 text-sm text-blue-400 hover:text-blue-300 transition-colors"
      >
        <Plus size={14} /> Add KPI
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 z-50 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg shadow-xl p-3 w-72">
            <p className="text-xs font-semibold text-[var(--text-tertiary)] uppercase mb-2">Add KPI Card</p>
            {categories.task_counts.length > 0 && (
              <>
                <p className="text-xs font-semibold text-[var(--text-muted)] uppercase mt-2 mb-1">Task Counts</p>
                {categories.task_counts.map(def => (
                  <button
                    key={def.slug}
                    onClick={() => { onAdd(def.slug); setOpen(false); }}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-1)] rounded transition-colors"
                  >
                    {def.label}
                  </button>
                ))}
              </>
            )}
            {categories.progress.length > 0 && (
              <>
                <p className="text-xs font-semibold text-[var(--text-muted)] uppercase mt-2 mb-1">Progress & Habits</p>
                {categories.progress.map(def => (
                  <button
                    key={def.slug}
                    onClick={() => { onAdd(def.slug); setOpen(false); }}
                    className="w-full text-left flex items-center gap-2 px-2 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-1)] rounded transition-colors"
                  >
                    {def.label}
                  </button>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// ─── Dashboard KPI Settings Section ─────────────────────────────────────────

export function DashboardKpiSettings() {
  const [config, setConfigState] = useState<KpiBarConfig>(getStoredConfig);
  const [currentPreset, setCurrentPreset] = useState<string>('custom');

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  // Detect current preset
  useEffect(() => {
    for (const [key, preset] of Object.entries(KPI_PRESETS)) {
      if (
        config.cards.length === preset.slugs.length &&
        config.cards.every((s, i) => s === preset.slugs[i])
      ) {
        setCurrentPreset(key);
        return;
      }
    }
    setCurrentPreset('custom');
  }, [config.cards]);

  const updateConfig = useCallback((update: Partial<KpiBarConfig>) => {
    setConfigState(prev => {
      const next = { ...prev, ...update };
      saveConfig(next);
      return next;
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = config.cards.indexOf(active.id as string);
    const newIndex = config.cards.indexOf(over.id as string);
    updateConfig({ cards: arrayMove(config.cards, oldIndex, newIndex) });
  }, [config.cards, updateConfig]);

  const handlePresetChange = useCallback((preset: string) => {
    const presetConfig = KPI_PRESETS[preset];
    if (!presetConfig) return;
    updateConfig({
      cards: presetConfig.slugs,
      visibleSlots: Math.min(presetConfig.slugs.length, MAX_KPI_CARDS),
      pinned: [],
    });
    toast.success(`Switched to "${presetConfig.label}" preset`);
  }, [updateConfig]);

  const togglePin = useCallback((slug: string) => {
    const pinned = config.pinned.includes(slug)
      ? config.pinned.filter(s => s !== slug)
      : [...config.pinned, slug];
    updateConfig({ pinned });
  }, [config.pinned, updateConfig]);

  const removeCard = useCallback((slug: string) => {
    updateConfig({
      cards: config.cards.filter(s => s !== slug),
      pinned: config.pinned.filter(s => s !== slug),
      visibleSlots: Math.max(1, Math.min(config.visibleSlots, config.cards.length - 1)),
    });
  }, [config, updateConfig]);

  const addCard = useCallback((slug: string) => {
    if (config.cards.includes(slug)) return;
    updateConfig({ cards: [...config.cards, slug] });
  }, [config.cards, updateConfig]);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Dashboard KPIs</h2>
        <p className="text-sm text-[var(--text-tertiary)] mt-1">
          Choose which stat cards appear at the top of the dashboard. Drag to reorder. Maximum {MAX_KPI_CARDS} cards.
        </p>
      </div>

      {/* Preset selector */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-[var(--text-secondary)]">Preset:</span>
        <Select value={currentPreset} onValueChange={handlePresetChange}>
          <SelectTrigger className="w-48 bg-[var(--surface-1)] border-[var(--border)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {Object.entries(KPI_PRESETS).map(([key, preset]) => (
              <SelectItem key={key} value={key}>{preset.label}</SelectItem>
            ))}
            <SelectItem value="custom" disabled>Custom</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Visible slots */}
      <div className="flex items-center gap-4">
        <span className="text-sm text-[var(--text-secondary)]">Visible slots:</span>
        <Select value={String(config.visibleSlots)} onValueChange={(v) => updateConfig({ visibleSlots: parseInt(v) })}>
          <SelectTrigger className="w-20 bg-[var(--surface-1)] border-[var(--border)]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[3, 4, 5, 6].map(n => (
              <SelectItem key={n} value={String(n)}>{n}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <span className="text-xs text-[var(--text-muted)]">(max {MAX_KPI_CARDS})</span>
      </div>

      {/* Sortable card list */}
      <div className="space-y-2">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
          <SortableContext items={config.cards} strategy={verticalListSortingStrategy}>
            {config.cards.map(slug => (
              <SortableKpiItem
                key={slug}
                slug={slug}
                isPinned={config.pinned.includes(slug)}
                onTogglePin={() => togglePin(slug)}
                onRemove={() => removeCard(slug)}
              />
            ))}
          </SortableContext>
        </DndContext>
      </div>

      {/* Add / footer */}
      <div className="flex items-center gap-4">
        <AddKpiButton selectedSlugs={config.cards} onAdd={addCard} />
      </div>

      {/* Rotation settings */}
      <div className="border-t border-[var(--border)] pt-4 space-y-3">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Rotation</h3>
        <p className="text-xs text-[var(--text-muted)]">
          When you have more cards than visible slots, they rotate automatically.
        </p>

        <div className="flex items-center gap-4">
          <span className="text-sm text-[var(--text-secondary)]">Speed:</span>
          <Select
            value={String(config.rotationInterval / 1000)}
            onValueChange={(v) => updateConfig({ rotationInterval: parseInt(v) * 1000 })}
          >
            <SelectTrigger className="w-32 bg-[var(--surface-1)] border-[var(--border)]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[5, 8, 12, 15, 20].map(n => (
                <SelectItem key={n} value={String(n)}>{n} seconds</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={config.pauseOnHover}
            onChange={(e) => updateConfig({ pauseOnHover: e.target.checked })}
            className="rounded border-[var(--border)]"
          />
          Pause rotation on hover
        </label>
      </div>

      {/* Auto-surface settings */}
      <div className="border-t border-[var(--border)] pt-4 space-y-3">
        <h3 className="text-sm font-medium text-[var(--text-primary)]">Auto-surface</h3>
        <label className="flex items-start gap-2 text-sm text-[var(--text-secondary)] cursor-pointer">
          <input
            type="checkbox"
            checked={config.autoSurface ?? true}
            onChange={(e) => updateConfig({ autoSurface: e.target.checked })}
            className="rounded border-[var(--border)] mt-0.5"
          />
          <div>
            <span>Auto-surface relevant KPIs</span>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              Shows cards like My Day, Routines, Focus 3, or Streak when they become relevant. You can dismiss them anytime.
            </p>
          </div>
        </label>
      </div>
    </div>
  );
}
