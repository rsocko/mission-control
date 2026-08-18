import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import {
  IDEATION_KIND_ORDER,
  type IdeationNodeKind,
  type IdeationPropertyKey,
} from '@/lib/graph/ideation-types';
import { getIdeationRelationshipTargetLabels } from '@/lib/ideation/property-parser';
import { useIdeationStore } from '@/lib/stores/ideationStore';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { InlinePropertyEditor } from './InlinePropertyEditor';
import {
  IDEATION_KIND_OPTION_LABELS,
  IDEATION_SHORTCUT_PROPERTIES,
} from './ideation-config';

export function IdeationPropertyPanel() {
  const nodes = useIdeationStore((state) => state.nodes);
  const selectedNodeId = useIdeationStore((state) => state.selectedNodeId);
  const updateLabel = useIdeationStore((state) => state.updateLabel);
  const updateKind = useIdeationStore((state) => state.updateKind);
  const setProperty = useIdeationStore((state) => state.setProperty);
  const removeProperty = useIdeationStore((state) => state.removeProperty);
  const selectNode = useIdeationStore((state) => state.selectNode);
  const [draft, setDraft] = useState('');
  const [draftKey, setDraftKey] = useState(0);
  const [shortcut, setShortcut] = useState<IdeationPropertyKey | null>(null);
  const selected = nodes.find((node) => node.id === selectedNodeId) ?? null;

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (shouldBlockGlobalShortcut(event)) return;
      const target = event.target;
      if (
        !selected
        || (target instanceof HTMLElement
          && target.matches('input, textarea, select, [contenteditable="true"]'))
      ) return;
      const config = IDEATION_SHORTCUT_PROPERTIES[event.key.toLowerCase()];
      if (!config) return;
      event.preventDefault();
      event.stopPropagation();
      setShortcut(config.key);
      setDraft(config.prefix);
      setDraftKey((key) => key + 1);
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [selected]);

  if (!selected) {
    return (
      <aside className="hidden w-72 shrink-0 items-center justify-center border-l border-[var(--border)] bg-[var(--surface-1)] p-6 text-center text-xs text-[var(--text-tertiary)] xl:flex">
        Select a node to edit properties. Shortcuts: P priority, S status, A assignee, D due, L tags, E effort.
      </aside>
    );
  }

  const shortcutConfig = Object.values(IDEATION_SHORTCUT_PROPERTIES)
    .find((config) => config.key === shortcut);
  const chooseShortcutValue = (value: string) => {
    setDraft(`${shortcutConfig?.prefix ?? ''}${value}`);
    setDraftKey((key) => key + 1);
  };

  return (
    <aside className="absolute inset-y-0 right-0 z-20 w-72 overflow-y-auto border-l border-[var(--border)] bg-[var(--surface-1)] p-4 shadow-2xl xl:static xl:z-auto xl:shadow-none">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-secondary)]">Node properties</h2>
        <button type="button" onClick={() => selectNode(null)} aria-label="Close properties" className="rounded-md p-1 text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]">
          <X size={14} />
        </button>
      </div>
      <div className="space-y-4">
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase text-[var(--text-tertiary)]">Title</span>
          <input
            value={selected.label}
            onChange={(event) => updateLabel(selected.id, event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-[10px] font-medium uppercase text-[var(--text-tertiary)]">Type</span>
          <Select
            value={selected.kind}
            onValueChange={(value) => updateKind(selected.id, value as IdeationNodeKind)}
          >
            <SelectTrigger aria-label="Node type" className="h-9 min-h-0 w-full text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {IDEATION_KIND_ORDER.map((kind) => (
                <SelectItem key={kind} value={kind}>{IDEATION_KIND_OPTION_LABELS[kind]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {shortcutConfig?.values?.length ? (
          <div className="rounded-lg border border-[var(--accent-500)]/30 bg-[var(--accent-500)]/5 p-2">
            <p className="mb-2 text-[10px] font-semibold uppercase text-[var(--accent-300)]">
              {shortcutConfig.key} shortcut
            </p>
            <div className="flex flex-wrap gap-1">
              {shortcutConfig.values.map((value) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => chooseShortcutValue(value)}
                  className="rounded-md border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:border-[var(--accent-500)]"
                >
                  {value.replaceAll('_', ' ')}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <InlinePropertyEditor
          key={`${selected.id}:${draftKey}`}
          draft={draft}
          draftKey={draftKey}
          nodeLabels={getIdeationRelationshipTargetLabels(nodes, selected.id)}
          onSubmit={(property) => {
            setProperty(selected.id, property);
            setShortcut(null);
            setDraft('');
          }}
        />
        <div className="space-y-2">
          {Object.values(selected.properties).filter(Boolean).map((property) => (
            <div key={property.key} className="flex items-start gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-2">
              <div className="min-w-0 flex-1">
                <p className="text-[10px] font-semibold uppercase text-[var(--text-tertiary)]">{property.key}</p>
                <p className="truncate text-xs text-[var(--text-secondary)]">
                  {Array.isArray(property.value) ? property.value.join(', ') : String(property.value)}
                </p>
              </div>
              <button type="button" onClick={() => removeProperty(selected.id, property.key)} aria-label={`Remove ${property.key}`} className="text-[var(--text-tertiary)] hover:text-red-400">
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}
