'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useRouter } from 'next/navigation';
import { shouldBlockGlobalShortcut } from '@/lib/keyboard-shortcuts';
import {
  Tree,
  type DragPreviewProps,
  type NodeApi,
  type NodeRendererProps,
} from 'react-arborist';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
  type OnNodeDrag,
} from '@xyflow/react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Flag,
  GripVertical,
  Layers3,
  Lightbulb,
  LoaderCircle,
  Plus,
  Redo2,
  RefreshCw,
  Rocket,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  buildIdeationTree,
  IDEATION_KIND_ORDER,
  isIdeationDescendant,
  type IdeationNode,
  type IdeationNodeKind,
  type IdeationPropertyKey,
  type IdeationTreeNode,
} from '@/lib/graph/ideation-types';
import {
  IDEATION_EXPAND_MIN_PROPOSALS,
  getBoundedIdeationContext,
  getIdeationContextVersion,
  normalizeIdeationLabel,
  type IdeationExpansionProposal,
} from '@/lib/graph/ideation-expand';
import { getIdeationRelationshipTargetLabels } from '@/lib/ideation/property-parser';
import {
  indentOutlineSelection,
  serializeIdeationOutline,
} from '@/lib/ideation/text-outline';
import { useIdeationStore } from '@/lib/stores/ideationStore';
import { InlinePropertyEditor } from './InlinePropertyEditor';
import { IdeationWorkspaceBar } from './IdeationWorkspaceBar';
import '@xyflow/react/dist/style.css';
import styles from './IdeationCanvas.module.css';

const KIND_CONFIG: Record<IdeationNodeKind, {
  label: string;
  color: string;
  icon: typeof Lightbulb;
}> = {
  idea: { label: 'Idea', color: '#facc15', icon: Lightbulb },
  phase: { label: 'Phase', color: '#a78bfa', icon: Flag },
  task: { label: 'Task', color: '#34d399', icon: Check },
};

const KIND_OPTION_LABELS: Record<IdeationNodeKind, string> = {
  idea: 'Idea (untyped)',
  phase: 'Phase',
  task: 'Task',
};

const SHORTCUT_PROPERTIES: Record<string, {
  key: IdeationPropertyKey;
  prefix: string;
  values?: string[];
}> = {
  p: { key: 'priority', prefix: 'priority:: ', values: ['critical', 'high', 'medium', 'low', 'none'] },
  s: { key: 'status', prefix: 'status:: ', values: ['todo', 'in_progress', 'done', 'blocked'] },
  d: { key: 'due', prefix: 'due:: ' },
  l: { key: 'tags', prefix: 'tags:: ' },
  e: { key: 'effort', prefix: 'effort:: ', values: ['1', '2', '3', '4', '5'] },
  a: { key: 'assignee', prefix: 'assignee:: ', values: ['me'] },
};

type IdeationCanvasNode = IdeationNode & {
  proposal?: IdeationExpansionProposal;
  onAcceptProposal?: (proposalId: string) => void;
  onDismissProposal?: (proposalId: string) => void;
  onExpand?: () => void;
};

type TitleSelection = number | 'all';

interface OutlineFocusContextValue {
  focusTitle: (id: string, selection?: TitleSelection) => void;
  registerTitle: (id: string, input: HTMLInputElement | null) => void;
}

const OutlineFocusContext = createContext<OutlineFocusContextValue | null>(null);

function useOutlineFocus() {
  const context = useContext(OutlineFocusContext);
  if (!context) throw new Error('Outline rows must be rendered inside IdeationOutline');
  return context;
}

interface ExpansionState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  parentId: string | null;
  contextVersion: string;
  proposals: IdeationExpansionProposal[];
  error: string | null;
}

const EMPTY_EXPANSION: ExpansionState = {
  status: 'idle',
  parentId: null,
  contextVersion: '',
  proposals: [],
  error: null,
};

const OUTLINE_INDENT = 18;
const OUTLINE_TOGGLE_CENTER = 12;
const OUTLINE_MARKER_CENTER_Y = 18;
const OUTLINE_BORDER_OVERLAP = 1;

function OutlineGuides({
  node,
  active,
}: {
  node: NodeApi<IdeationTreeNode<IdeationCanvasNode>>;
  active: boolean;
}) {
  const continuationLevels: number[] = [];
  let ancestor = node.parent;

  while (ancestor && !ancestor.isRoot) {
    if (ancestor.level > 0 && ancestor.nextSibling) {
      continuationLevels.push(ancestor.level - 1);
    }
    ancestor = ancestor.parent;
  }

  const connectorLeft = (node.level - 1) * OUTLINE_INDENT + OUTLINE_TOGGLE_CENTER;

  return (
    <span
      className={styles.outlineGuides}
      data-active={active || undefined}
      data-outline-guides=""
      aria-hidden="true"
    >
      {continuationLevels.map((level) => (
        <span
          key={level}
          className={cn(styles.outlineGuide, styles.outlineGuideFull)}
          data-guide="continuation"
          style={{ left: level * OUTLINE_INDENT + OUTLINE_TOGGLE_CENTER }}
        />
      ))}
      {node.level > 0 ? (
        <>
          <span
            className={styles.outlineElbow}
            data-guide="elbow"
            style={{
              left: connectorLeft,
              width: OUTLINE_INDENT,
              height: OUTLINE_MARKER_CENTER_Y + OUTLINE_BORDER_OVERLAP,
            }}
          />
          {node.nextSibling ? (
            <span
              className={styles.outlineGuide}
              data-guide="current"
              style={{
                left: connectorLeft,
                top: OUTLINE_MARKER_CENTER_Y,
                bottom: -OUTLINE_BORDER_OVERLAP,
              }}
            />
          ) : null}
        </>
      ) : null}
      {node.isOpen && node.children?.length ? (
        <span
          className={styles.outlineGuide}
          data-guide="children"
          style={{
            left: node.level * OUTLINE_INDENT + OUTLINE_TOGGLE_CENTER,
            top: OUTLINE_MARKER_CENTER_Y,
            bottom: -OUTLINE_BORDER_OVERLAP,
          }}
        />
      ) : null}
    </span>
  );
}

function useElementSize<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [size, setSize] = useState({ width: 320, height: 520 });

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = () => setSize({
      width: Math.max(element.clientWidth, 240),
      height: Math.max(element.clientHeight, 320),
    });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return { ref, ...size };
}

function TypeMenu({
  node,
  children,
}: {
  node: IdeationNode;
  children: React.ReactNode;
}) {
  const updateKind = useIdeationStore((state) => state.updateKind);
  const addNode = useIdeationStore((state) => state.addNode);
  const deleteNode = useIdeationStore((state) => state.deleteNode);

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild>{children}</ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="z-50 min-w-44 rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-xl">
          <ContextMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Node type
          </ContextMenu.Label>
          {IDEATION_KIND_ORDER.map((kind) => {
            const config = KIND_CONFIG[kind];
            return (
              <ContextMenu.Item
                key={kind}
                onSelect={() => updateKind(node.id, kind)}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]"
              >
                <config.icon size={13} style={{ color: config.color }} />
                {KIND_OPTION_LABELS[kind]}
                {node.kind === kind ? <Check size={12} className="ml-auto" /> : null}
              </ContextMenu.Item>
            );
          })}
          <ContextMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          <ContextMenu.Item
            onSelect={() => addNode(node.id)}
            className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--surface-2)]"
          >
            <Plus size={13} /> Add child
          </ContextMenu.Item>
          {node.parentId ? (
            <ContextMenu.Item
              onSelect={() => deleteNode(node.id)}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-xs text-red-400 outline-none data-[highlighted]:bg-red-500/10"
            >
              <Trash2 size={13} /> Delete branch
            </ContextMenu.Item>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

function OutlineRow({ node, style, dragHandle, tree }: NodeRendererProps<IdeationTreeNode<IdeationCanvasNode>>) {
  const allNodes = useIdeationStore((state) => state.nodes);
  const applyTitleInput = useIdeationStore((state) => state.applyTitleInput);
  const addNode = useIdeationStore((state) => state.addNode);
  const indentNode = useIdeationStore((state) => state.indentNode);
  const moveNode = useIdeationStore((state) => state.moveNode);
  const outdentNode = useIdeationStore((state) => state.outdentNode);
  const deleteNode = useIdeationStore((state) => state.deleteNode);
  const selectNode = useIdeationStore((state) => state.selectNode);
  const setProperty = useIdeationStore((state) => state.setProperty);
  const updateKind = useIdeationStore((state) => state.updateKind);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const [propertyDraft, setPropertyDraft] = useState('');
  const [propertyOpen, setPropertyOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashMenuId = useId();
  const propertyPopoverRef = useRef<HTMLDivElement>(null);
  const propertyToggleRef = useRef<HTMLButtonElement>(null);
  const { focusTitle, registerTitle } = useOutlineFocus();
  const dragRoot = tree.dragNodes[0] ?? null;
  const isDraggedRoot = node.isDragging;
  const isDraggedDescendant = Boolean(
    dragRoot
    && dragRoot.id !== node.id
    && dragRoot.isAncestorOf(node)
    && !node.data.proposal,
  );
  const config = KIND_CONFIG[node.data.kind];
  const Icon = config.icon;
  const selectedNode = tree.selectedNodes?.[0];
  const isOnSelectedPath = selectedNode ? node.isAncestorOf(selectedNode) : false;
  const hasChildren = node.data.children.length > 0;
  const propertyCount = Object.keys(node.data.properties).length;
  const displayedTitle = titleDraft ?? node.data.label;
  const slashActions = [
    { label: 'Clear node type', run: () => updateKind(node.id, 'idea') },
    { label: 'Convert to phase', run: () => updateKind(node.id, 'phase') },
    { label: 'Convert to task', run: () => updateKind(node.id, 'task') },
    { label: 'Add child', run: () => addNode(node.id, node.data.kind) },
    ...(node.data.onExpand ? [{ label: 'AI expand', run: node.data.onExpand }] : []),
  ];

  useEffect(() => {
    if (!propertyOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof globalThis.Node
        && !propertyPopoverRef.current?.contains(event.target)
        && !propertyToggleRef.current?.contains(event.target)
      ) {
        setPropertyOpen(false);
      }
    };
    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, [propertyOpen]);

  const commitTitle = () => {
    if (!displayedTitle.trim()) {
      setTitleDraft(null);
      return false;
    }
    if (displayedTitle !== node.data.label) {
      applyTitleInput(node.id, displayedTitle);
    }
    setTitleDraft(null);
    return true;
  };

  const runSlashAction = (index: number) => {
    slashActions[index]?.run();
    setSlashOpen(false);
    setTitleDraft(null);
  };

  const adjacentEditableNode = (direction: -1 | 1) => {
    let candidate = direction === -1 ? node.prev : node.next;
    while (candidate?.data.proposal) {
      candidate = direction === -1 ? candidate.prev : candidate.next;
    }
    return candidate;
  };

  const moveTitleFocus = (direction: -1 | 1, column: number) => {
    const target = adjacentEditableNode(direction);
    if (!target) return;
    commitTitle();
    target.tree.scrollTo(target.id);
    focusTitle(target.id, column);
  };

  const createNodeAndFocus = (parentId: string, kind: IdeationNodeKind, index?: number) => {
    commitTitle();
    const id = addNode(parentId, kind, 'Untitled', index);
    focusTitle(id, 'all');
  };

  if (node.data.proposal) {
    return (
      <div
        style={style}
        className={cn(
          styles.outlineRow,
          'relative flex h-full flex-col justify-start rounded-lg border border-dashed border-violet-400/60 bg-violet-500/10 px-2 py-1 text-violet-100',
        )}
        data-outline-node-id={node.id}
        role="group"
        aria-label={`AI suggestion: ${node.data.label}`}
      >
        <OutlineGuides node={node} active={isOnSelectedPath} />
        <div className="flex h-7 w-full items-center gap-2">
          <span className="flex h-7 w-6 shrink-0 items-center justify-center text-violet-300">
            <span className={styles.outlineNodeDot} data-outline-marker="dot" />
          </span>
          <Sparkles size={13} className="shrink-0 text-violet-300" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{node.data.label}</span>
          <button
            ref={propertyToggleRef}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              node.data.onAcceptProposal?.(node.data.proposal?.id ?? '');
            }}
            className="rounded p-1 text-emerald-300 hover:bg-emerald-500/15"
            aria-label={`Accept suggestion ${node.data.label} in outline`}
          >
            <Check size={13} />
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              node.data.onDismissProposal?.(node.data.proposal?.id ?? '');
            }}
            className="rounded p-1 text-[var(--text-tertiary)] hover:bg-white/10 hover:text-white"
            aria-label={`Dismiss suggestion ${node.data.label} in outline`}
          >
            <X size={13} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <TypeMenu node={node.data}>
      <div
        ref={dragHandle}
        style={style}
        className={cn(
          styles.outlineRow,
          'group relative flex h-full flex-col justify-start rounded-lg border px-1.5 py-1 transition-colors',
          isDraggedRoot
            ? 'border-[var(--accent-400)] bg-[var(--accent-500)]/15 ring-1 ring-[var(--accent-400)]/30'
            : isDraggedDescendant
              ? 'border-[var(--accent-500)]/25 bg-[var(--accent-500)]/[0.06]'
              : node.isSelected
            ? 'border-[var(--accent-500)]/50 bg-[var(--accent-500)]/10'
            : 'border-transparent hover:border-[var(--border)] hover:bg-[var(--surface-2)]',
        )}
        data-outline-node-id={node.id}
        data-drag-state={isDraggedRoot ? 'root' : isDraggedDescendant ? 'descendant' : undefined}
        onClick={() => selectNode(node.id)}
      >
        <OutlineGuides node={node} active={isOnSelectedPath} />
        {isDraggedDescendant ? (
          <span
            className="pointer-events-none absolute inset-y-2 left-0 w-0.5 rounded-full bg-[var(--accent-400)]/60"
            aria-hidden="true"
          />
        ) : null}
        <div className="flex w-full items-center gap-1">
        {hasChildren ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              node.toggle();
            }}
            className={cn(
              styles.outlineToggle,
              'relative flex h-7 w-6 items-center justify-center text-[var(--text-tertiary)]',
            )}
            aria-label={`${node.isOpen ? 'Collapse' : 'Expand'} ${node.data.label}`}
          >
            <span className={styles.outlineNodeDot} data-outline-marker="dot" />
            <span className={styles.outlineChevron} data-outline-marker="chevron">
              {node.isOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </span>
          </button>
        ) : (
          <span className="relative flex h-7 w-6 items-center justify-center text-[var(--text-tertiary)]">
            <GripVertical
              size={12}
              className={cn(styles.outlineLeafGrip, 'absolute opacity-0 group-hover:opacity-100')}
            />
            <span className={styles.outlineNodeDot} data-outline-marker="dot" />
          </span>
        )}
        <span
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
          style={{ color: config.color, backgroundColor: `${config.color}18` }}
          title={config.label}
        >
          <Icon size={13} />
        </span>
        <input
          ref={(input) => registerTitle(node.id, input)}
          value={displayedTitle}
          onFocus={() => selectNode(node.id)}
          onBlur={() => {
            if (!slashOpen) commitTitle();
          }}
          onChange={(event) => {
            const next = event.target.value;
            setTitleDraft(next);
            setSlashOpen(next === '/');
            if (next === '/') setSlashIndex(0);
          }}
          onKeyDown={(event) => {
            if (slashOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault();
              const direction = event.key === 'ArrowDown' ? 1 : -1;
              setSlashIndex((index) => (
                (index + direction + slashActions.length) % slashActions.length
              ));
              return;
            }
            if (slashOpen && (event.key === 'Enter' || event.key === 'Tab')) {
              event.preventDefault();
              runSlashAction(slashIndex);
              return;
            }
            if (
              (event.key === 'ArrowDown' || event.key === 'ArrowUp')
              && (event.ctrlKey || event.metaKey)
            ) {
              event.preventDefault();
              const siblings = allNodes
                .filter((candidate) => candidate.parentId === node.data.parentId)
                .sort((a, b) => a.sortOrder - b.sortOrder);
              const currentIndex = siblings.findIndex((candidate) => candidate.id === node.id);
              const nextIndex = currentIndex + (event.key === 'ArrowDown' ? 1 : -1);
              if (currentIndex >= 0 && nextIndex >= 0 && nextIndex < siblings.length) {
                commitTitle();
                moveNode(node.id, node.data.parentId, nextIndex);
                focusTitle(node.id, event.currentTarget.selectionStart ?? displayedTitle.length);
              }
            } else if (
              (event.key === 'ArrowDown' || event.key === 'ArrowUp')
              && !event.altKey
              && !event.shiftKey
            ) {
              event.preventDefault();
              moveTitleFocus(
                event.key === 'ArrowDown' ? 1 : -1,
                event.currentTarget.selectionStart ?? displayedTitle.length,
              );
            } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              node.open();
              const childCount = allNodes.filter((candidate) => candidate.parentId === node.id).length;
              createNodeAndFocus(node.id, node.data.kind, childCount);
            } else if (event.key === 'Enter') {
              event.preventDefault();
              if (node.data.parentId === null) {
                node.open();
                const childCount = allNodes.filter((candidate) => candidate.parentId === node.id).length;
                createNodeAndFocus(node.id, 'idea', childCount);
              } else {
                createNodeAndFocus(node.data.parentId, node.data.kind, node.data.sortOrder + 1);
              }
            } else if (event.key === 'Tab') {
              event.preventDefault();
              commitTitle();
              if (event.shiftKey) outdentNode(node.id);
              else indentNode(node.id);
            } else if (
              (event.key === 'Backspace' || event.key === 'Delete')
              && event.currentTarget.value === ''
              && node.data.parentId
              && node.data.children.length === 0
            ) {
              event.preventDefault();
              const previous = adjacentEditableNode(-1);
              deleteNode(node.id);
              if (previous) focusTitle(previous.id);
            } else if (event.key === '/' && event.currentTarget.value === '') {
              setSlashOpen(true);
              setSlashIndex(0);
            } else if (event.key === 'Escape') {
              if (slashOpen) {
                event.preventDefault();
                setSlashOpen(false);
                setTitleDraft(null);
              } else {
                event.currentTarget.blur();
              }
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs font-medium text-[var(--text-primary)] outline-none"
          data-ideation-node-id={node.id}
          aria-label={`${config.label} title`}
          aria-keyshortcuts="ArrowUp ArrowDown Enter Control+Enter Meta+Enter Tab Shift+Tab Control+ArrowUp Control+ArrowDown Meta+ArrowUp Meta+ArrowDown"
          aria-haspopup="menu"
          aria-controls={slashOpen ? slashMenuId : undefined}
          aria-activedescendant={slashOpen ? `${slashMenuId}-item-${slashIndex}` : undefined}
        />
        {propertyCount ? (
          <span className="rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[9px] text-[var(--text-tertiary)]">
            {propertyCount}
          </span>
        ) : null}
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setPropertyDraft('');
            setPropertyOpen((open) => !open);
          }}
          className="rounded p-1 text-[var(--text-tertiary)] opacity-60 hover:bg-white/10 hover:text-white group-hover:opacity-100"
          aria-label={`Add property to ${node.data.label}`}
          title="Add property (P priority, S status, A assignee, D due, L tags, E effort)"
        >
          <Plus size={12} />
        </button>
        </div>
        {propertyCount ? (
          <div className="flex w-full gap-1 overflow-hidden pl-14" aria-label={`${node.data.label} properties`}>
            {Object.values(node.data.properties).filter(Boolean).slice(0, 4).map((property) => (
              <span key={property.key} className="truncate rounded-full bg-[var(--surface-3)] px-1.5 py-0.5 text-[9px] text-[var(--text-tertiary)]">
                {property.key}: {Array.isArray(property.value) ? property.value.join(', ') : String(property.value)}
              </span>
            ))}
          </div>
        ) : (
          <span className="w-full pl-14 text-[9px] text-[var(--text-tertiary)] opacity-0 group-hover:opacity-70">
            + property · / commands · Esc then P/S/A/D/L/E
          </span>
        )}
        {slashOpen ? (
          <div id={slashMenuId} role="menu" aria-label="Ideation commands" className="absolute left-14 top-9 z-30 w-48 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-1 shadow-xl">
            {slashActions.map((action, index) => (
              <button
                key={action.label}
                id={`${slashMenuId}-item-${index}`}
                type="button"
                role="menuitem"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => runSlashAction(index)}
                className={cn(
                  'block w-full rounded-md px-2 py-1.5 text-left text-xs text-[var(--text-secondary)]',
                  index === slashIndex && 'bg-[var(--accent-muted)] text-[var(--text-primary)]',
                )}
              >
                {action.label}
              </button>
            ))}
          </div>
        ) : null}
        {propertyOpen ? (
          <div
            ref={propertyPopoverRef}
            className="absolute left-14 top-9 z-40 w-80 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-2 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
            onBlur={(event) => {
              if (event.relatedTarget instanceof globalThis.Node && event.currentTarget.contains(event.relatedTarget)) {
                return;
              }
              setPropertyOpen(false);
              setPropertyDraft('');
            }}
          >
            <InlinePropertyEditor
              draft={propertyDraft}
              draftKey={propertyOpen ? 1 : 0}
              nodeLabels={getIdeationRelationshipTargetLabels(allNodes, node.id)}
              autoFocus
              onCancel={() => setPropertyOpen(false)}
              onSubmit={(property) => {
                setProperty(node.id, property);
                setPropertyOpen(false);
                setPropertyDraft('');
              }}
            />
          </div>
        ) : null}
      </div>
    </TypeMenu>
  );
}

function OutlineDragPreview({ id, offset, isDragging }: DragPreviewProps) {
  const nodes = useIdeationStore((state) => state.nodes);
  const dragged = nodes.find((node) => node.id === id);
  if (!isDragging || !offset || !dragged) return null;

  const childrenByParent = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const siblings = childrenByParent.get(node.parentId);
    if (siblings) siblings.push(node.id);
    else childrenByParent.set(node.parentId, [node.id]);
  }
  const pending = [...(childrenByParent.get(dragged.id) ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const descendantId = pending.pop();
    if (!descendantId || visited.has(descendantId)) continue;
    visited.add(descendantId);
    pending.push(...(childrenByParent.get(descendantId) ?? []));
  }
  const descendantCount = visited.size;
  const totalCount = descendantCount + 1;
  const config = KIND_CONFIG[dragged.kind];
  const Icon = config.icon;

  return (
    <div className="pointer-events-none fixed inset-0 z-[100]" aria-hidden="true">
      <div
        className="relative w-72"
        style={{ transform: `translate3d(${offset.x}px, ${offset.y}px, 0)` }}
      >
        {descendantCount ? (
          <>
            <span className="absolute inset-x-3 top-2 h-full rounded-xl border border-[var(--accent-500)]/15 bg-[var(--surface-2)]/70" />
            <span className="absolute inset-x-1.5 top-1 h-full rounded-xl border border-[var(--accent-500)]/20 bg-[var(--surface-2)]/90" />
          </>
        ) : null}
        <div className="relative flex items-center gap-2 rounded-xl border border-[var(--accent-400)]/70 bg-[var(--surface-1)] px-3 py-2.5 shadow-2xl ring-2 ring-[var(--accent-400)]/20">
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
            style={{ color: config.color, backgroundColor: `${config.color}18` }}
          >
            <Icon size={14} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">
              {dragged.label}
            </span>
            <span className="block text-[10px] text-[var(--text-tertiary)]">
              {descendantCount
                ? `${descendantCount} descendant${descendantCount === 1 ? '' : 's'} included`
                : config.label}
            </span>
          </span>
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[var(--accent-500)]/15 px-2 py-1 text-[10px] font-semibold text-[var(--accent-300)]">
            <Layers3 size={11} />
            Moving {totalCount} {totalCount === 1 ? 'node' : 'nodes'}
          </span>
        </div>
      </div>
    </div>
  );
}

function IdeationOutline({ nodes }: { nodes: IdeationCanvasNode[] }) {
  const selectedNodeId = useIdeationStore((state) => state.selectedNodeId);
  const moveNode = useIdeationStore((state) => state.moveNode);
  const selectNode = useIdeationStore((state) => state.selectNode);
  const tree = useMemo(() => buildIdeationTree(nodes), [nodes]);
  const { ref: containerRef, width, height } = useElementSize<HTMLDivElement>();
  const titleInputs = useRef(new Map<string, HTMLInputElement>());
  const pendingFocus = useRef<{ id: string; selection?: TitleSelection } | null>(null);
  const treeFocusedNodeId = useRef<string | null>(selectedNodeId);

  const applyPendingFocus = useCallback((input: HTMLInputElement) => {
    const request = pendingFocus.current;
    if (!request) return;
    input.focus();
    if (request.selection === 'all') {
      input.select();
    } else {
      const position = Math.min(request.selection ?? input.value.length, input.value.length);
      input.setSelectionRange(position, position);
    }
    pendingFocus.current = null;
  }, []);

  const registerTitle = useCallback((id: string, input: HTMLInputElement | null) => {
    if (!input) {
      titleInputs.current.delete(id);
      return;
    }
    titleInputs.current.set(id, input);
    if (pendingFocus.current?.id === id) applyPendingFocus(input);
  }, [applyPendingFocus]);

  const focusTitle = useCallback((id: string, selection?: TitleSelection) => {
    pendingFocus.current = { id, selection };
    selectNode(id);
    const input = titleInputs.current.get(id);
    if (input) applyPendingFocus(input);
  }, [applyPendingFocus, selectNode]);

  const focusContext = useMemo(
    () => ({ focusTitle, registerTitle }),
    [focusTitle, registerTitle],
  );

  return (
    <div
      ref={containerRef}
      className="h-full min-h-0 overflow-hidden p-2"
      onKeyDownCapture={(event) => {
        const target = event.target;
        if (
          (event.key !== 'Enter' && event.key !== 'F2')
          || (target instanceof HTMLElement
            && target.closest(
              'input, textarea, select, button, a[href], [role="button"], [contenteditable="true"]',
            ))
        ) {
          return;
        }
        const id = treeFocusedNodeId.current ?? selectedNodeId;
        const focusedNode = nodes.find((node) => node.id === id);
        if (!focusedNode || focusedNode.proposal) return;
        event.preventDefault();
        event.stopPropagation();
        focusTitle(focusedNode.id);
      }}
    >
      <OutlineFocusContext.Provider value={focusContext}>
        <Tree<IdeationTreeNode<IdeationCanvasNode>>
          data={tree}
          width={width}
          height={height}
          rowHeight={58}
          indent={OUTLINE_INDENT}
          selection={selectedNodeId ?? undefined}
          selectionFollowsFocus
          openByDefault
          disableMultiSelection
          disableSelect={(node) => Boolean(node.proposal)}
          disableDrag={(node) => node.parentId === null || Boolean(node.proposal)}
          disableDrop={({ parentNode }) => Boolean(parentNode.data.proposal)}
          renderDragPreview={OutlineDragPreview}
          onActivate={(node) => {
            if (!node.data.proposal) focusTitle(node.id);
          }}
          onFocus={(node) => {
            treeFocusedNodeId.current = node.id;
          }}
          onSelect={(selected) => selectNode(selected[0]?.id ?? null)}
          onMove={({ dragIds, parentId, index }) => {
            const id = dragIds[0];
            if (id) moveNode(id, parentId, index);
          }}
          aria-label="Ideation outline"
        >
          {OutlineRow}
        </Tree>
      </OutlineFocusContext.Provider>
    </div>
  );
}

function TextIdeationOutline({ nodes }: { nodes: IdeationNode[] }) {
  const applyTextOutline = useIdeationStore((state) => state.applyTextOutline);
  const serialized = useMemo(() => serializeIdeationOutline(nodes), [nodes]);
  const [draft, setDraft] = useState(serialized);
  const [dirty, setDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const commit = useCallback(() => {
    if (!dirty) return;
    applyTextOutline(draft);
    setDirty(false);
  }, [applyTextOutline, dirty, draft]);

  useEffect(() => {
    if (!dirty && document.activeElement !== textareaRef.current) setDraft(serialized);
  }, [dirty, serialized]);

  useEffect(() => {
    if (!dirty || draft.split(/\r?\n/).some((line) => !line.trim())) return;
    const timeout = window.setTimeout(commit, 400);
    return () => window.clearTimeout(timeout);
  }, [commit, dirty, draft]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          setDirty(true);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Tab') return;
          event.preventDefault();
          const edit = indentOutlineSelection(
            event.currentTarget.value,
            event.currentTarget.selectionStart,
            event.currentTarget.selectionEnd,
            event.shiftKey,
          );
          setDraft(edit.value);
          setDirty(true);
          window.requestAnimationFrame(() => {
            textareaRef.current?.setSelectionRange(edit.selectionStart, edit.selectionEnd);
          });
        }}
        aria-label="Text outline"
        aria-keyshortcuts="Tab Shift+Tab Escape"
        spellCheck
        className="min-h-0 flex-1 resize-none rounded-lg border border-[var(--border)] bg-[var(--surface-0)] p-3 font-mono text-xs leading-6 text-[var(--text-primary)] outline-none focus:border-[var(--accent-500)]"
      />
      <p className="px-1 text-[10px] leading-4 text-[var(--text-tertiary)]">
        One node per line. Tab and Shift+Tab change depth; Escape exits the editor. Optional
        [phase] or [task] prefixes set type; #tag and !high set attributes. Complete lines
        sync automatically; drafts with blank lines sync on blur.
      </p>
    </div>
  );
}

interface MindMapNodeData extends Record<string, unknown> {
  node: IdeationCanvasNode;
  onSelect: (id: string) => void;
}

type MindMapNode = Node<MindMapNodeData, 'ideation'>;

function MindMapCard({ data, selected }: NodeProps<MindMapNode>) {
  const config = KIND_CONFIG[data.node.kind];
  const Icon = config.icon;
  if (data.node.proposal) {
    return (
      <div
        className="w-48 rounded-xl border border-dashed border-violet-400/70 bg-violet-500/10 px-3 py-2.5 text-left shadow-lg"
        role="group"
        aria-label={`AI suggestion: ${data.node.label}`}
      >
        <Handle type="target" position={Position.Left} isConnectable={false} className="!border-0 !bg-violet-400" />
        <span className="flex items-start gap-2">
          <Sparkles size={14} className="mt-0.5 shrink-0 text-violet-300" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-semibold text-violet-100">{data.node.label}</span>
            <span className="mt-1 block text-[10px] leading-4 text-violet-200/70">{data.node.proposal.rationale}</span>
          </span>
        </span>
        <span className="mt-2 flex justify-end gap-1">
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.node.onAcceptProposal?.(data.node.proposal?.id ?? '');
            }}
            className="rounded-md px-2 py-1 text-[10px] font-medium text-emerald-300 hover:bg-emerald-500/15"
            aria-label={`Accept suggestion ${data.node.label} in mind map`}
          >
            Accept
          </button>
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              data.node.onDismissProposal?.(data.node.proposal?.id ?? '');
            }}
            className="rounded-md px-2 py-1 text-[10px] text-violet-200/70 hover:bg-white/10"
            aria-label={`Dismiss suggestion ${data.node.label} in mind map`}
          >
            Dismiss
          </button>
        </span>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => data.onSelect(data.node.id)}
      className={cn(
        'w-44 rounded-xl border bg-[var(--surface-1)] px-3 py-2.5 text-left shadow-lg transition',
        selected ? 'border-[var(--accent-400)] ring-2 ring-[var(--accent-400)]/20' : 'border-[var(--border)]',
      )}
    >
      <Handle type="target" position={Position.Left} isConnectable={false} className="!border-0 !bg-[var(--border-strong)]" />
      <span className="flex items-center gap-2">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg" style={{ color: config.color, background: `${config.color}18` }}>
          <Icon size={14} />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-xs font-semibold text-[var(--text-primary)]">{data.node.label}</span>
          <span className="text-[10px] text-[var(--text-tertiary)]">{config.label}</span>
        </span>
      </span>
      <Handle type="source" position={Position.Right} isConnectable={false} className="!border-0 !bg-[var(--border-strong)]" />
    </button>
  );
}

const mindMapNodeTypes = { ideation: MindMapCard };

export function layoutMindMap(nodes: IdeationCanvasNode[], onSelect: (id: string) => void): {
  nodes: MindMapNode[];
  edges: Edge[];
} {
  const ordered = [...nodes].sort((a, b) => a.sortOrder - b.sortOrder);
  const byParent = new Map<string | null, IdeationCanvasNode[]>();
  for (const node of ordered) {
    byParent.set(node.parentId, [...(byParent.get(node.parentId) ?? []), node]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  let leafIndex = 0;
  const place = (node: IdeationCanvasNode, depth: number): number => {
    const children = byParent.get(node.id) ?? [];
    const childYs = children.map((child) => place(child, depth + 1));
    const y = childYs.length
      ? (Math.min(...childYs) + Math.max(...childYs)) / 2
      : leafIndex++ * 104;
    positions.set(node.id, { x: depth * 250 + 30, y: y + 30 });
    return y;
  };
  for (const root of byParent.get(null) ?? []) place(root, 0);

  return {
    nodes: ordered.map((node) => ({
      id: node.id,
      type: 'ideation',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { node, onSelect },
      selected: false,
      draggable: !node.proposal,
      selectable: !node.proposal,
    })),
    edges: ordered.flatMap((node) => node.parentId ? [{
      id: `hierarchy:${node.parentId}:${node.id}`,
      source: node.parentId,
      target: node.id,
      type: 'smoothstep',
      animated: !node.proposal && node.kind === 'idea',
      style: node.proposal
        ? { stroke: '#a78bfa', strokeOpacity: 0.7, strokeDasharray: '5 5' }
        : { stroke: KIND_CONFIG[node.kind].color, strokeOpacity: 0.5 },
    }] : []),
  };
}

function IdeationMindMap({ sourceNodes }: { sourceNodes: IdeationCanvasNode[] }) {
  const selectedNodeId = useIdeationStore((state) => state.selectedNodeId);
  const selectNode = useIdeationStore((state) => state.selectNode);
  const moveNode = useIdeationStore((state) => state.moveNode);
  const graph = useMemo(() => layoutMindMap(sourceNodes, selectNode), [sourceNodes, selectNode]);

  const onNodeDragStop = useCallback<OnNodeDrag<MindMapNode>>((_event, dragged) => {
    let closest: MindMapNode | null = null;
    let closestDistance = 140;
    if (dragged.data.node.proposal) return;
    for (const candidate of graph.nodes) {
      if (
        candidate.id === dragged.id
        || candidate.data.node.proposal
        || isIdeationDescendant(sourceNodes, candidate.id, dragged.id)
      ) continue;
      const distance = Math.hypot(
        candidate.position.x - dragged.position.x,
        candidate.position.y - dragged.position.y,
      );
      if (distance < closestDistance) {
        closest = candidate;
        closestDistance = distance;
      }
    }
    if (closest) {
      const childCount = sourceNodes.filter((node) => node.parentId === closest?.id).length;
      moveNode(dragged.id, closest.id, childCount);
    }
  }, [graph.nodes, moveNode, sourceNodes]);

  return (
    <ReactFlow
      className={styles.canvas}
      nodes={graph.nodes.map((node) => ({ ...node, selected: node.id === selectedNodeId }))}
      edges={graph.edges}
      nodeTypes={mindMapNodeTypes}
      onNodeClick={(_event, node) => {
        if (!node.data.node.proposal) selectNode(node.id);
      }}
      onNodeDragStop={onNodeDragStop}
      fitView
      fitViewOptions={{ padding: 0.2 }}
      minZoom={0.2}
      maxZoom={2}
      colorMode="dark"
      deleteKeyCode={null}
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={24} size={1} color="var(--border)" />
      <Controls position="bottom-left" showInteractive={false} />
    </ReactFlow>
  );
}

function PropertyPanel() {
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
      const config = SHORTCUT_PROPERTIES[event.key.toLowerCase()];
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

  const shortcutConfig = Object.values(SHORTCUT_PROPERTIES).find((config) => config.key === shortcut);
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
                <SelectItem key={kind} value={kind}>{KIND_OPTION_LABELS[kind]}</SelectItem>
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

function ConvertDialog({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const nodes = useIdeationStore((state) => state.nodes);
  const flushWorkspace = useIdeationStore((state) => state.flushWorkspace);
  const root = nodes.find((node) => node.parentId === null);
  const [name, setName] = useState(root?.label ?? 'New Project');
  const [color, setColor] = useState('#6366f1');
  const [converting, setConverting] = useState(false);

  const phaseCount = nodes.filter((node) => node.kind === 'phase').length;
  const taskCount = nodes.filter((node) => node.kind === 'task').length;

  const convert = async () => {
    setConverting(true);
    try {
      if (flushWorkspace && !await flushWorkspace()) {
        throw new Error('Resolve the workspace save issue before converting.');
      }
      const workspace = useIdeationStore.getState();
      const response = await fetch('/api/ideation/convert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name,
          color,
          nodes,
          sourceWorkspace: workspace.workspaceId && workspace.workspaceRevision
            ? { id: workspace.workspaceId, revision: workspace.workspaceRevision }
            : undefined,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? 'Conversion failed');
      toast.success('Project created from ideation');
      router.push(`/projects/${result.projectId}`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Conversion failed');
    } finally {
      setConverting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/65 p-4" role="presentation" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="convert-title"
        className="w-full max-w-md rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/15 text-emerald-400"><Rocket size={18} /></span>
          <div>
            <h2 id="convert-title" className="font-semibold text-[var(--text-primary)]">Convert to project</h2>
            <p className="mt-1 text-xs text-[var(--text-tertiary)]">
              Creates {phaseCount} phase{phaseCount === 1 ? '' : 's'} and {taskCount} task{taskCount === 1 ? '' : 's'} in one transaction.
            </p>
          </div>
        </div>
        <div className="mt-5 space-y-4">
          <label className="block space-y-1">
            <span className="text-xs text-[var(--text-secondary)]">Project name</span>
            <input value={name} onChange={(event) => setName(event.target.value)} className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]" />
          </label>
          <label className="flex items-center justify-between rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2">
            <span className="text-xs text-[var(--text-secondary)]">Project color</span>
            <input type="color" value={color} onChange={(event) => setColor(event.target.value)} className="h-7 w-10 bg-transparent" />
          </label>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={convert} disabled={!name.trim() || converting}>
            {converting ? <LoaderCircle className="animate-spin" /> : <Rocket />}
            Create project
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function IdeationCanvas() {
  const nodes = useIdeationStore((state) => state.nodes);
  const selectedNodeId = useIdeationStore((state) => state.selectedNodeId);
  const addNode = useIdeationStore((state) => state.addNode);
  const acceptProposals = useIdeationStore((state) => state.acceptProposals);
  const undo = useIdeationStore((state) => state.undo);
  const past = useIdeationStore((state) => state.past);
  const [convertOpen, setConvertOpen] = useState(false);
  const [outlineMode, setOutlineMode] = useState<'visual' | 'text'>('visual');
  const [expansion, setExpansion] = useState<ExpansionState>(EMPTY_EXPANSION);
  const requestRef = useRef<{ controller: AbortController; id: number } | null>(null);
  const requestIdRef = useRef(0);
  const root = nodes.find((node) => node.parentId === null);
  const selected = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const currentContextVersion = selected
    ? getIdeationContextVersion(nodes, selected.id)
    : '';

  const clearExpansion = useCallback(() => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
    requestIdRef.current += 1;
    setExpansion(EMPTY_EXPANSION);
  }, []);

  const expandSelected = useCallback(async () => {
    if (!selected) return;

    requestRef.current?.controller.abort();
    const controller = new AbortController();
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    requestRef.current = { controller, id: requestId };
    const contextVersion = getIdeationContextVersion(nodes, selected.id);
    const expansionRequest = {
      selectedNode: {
        id: selected.id,
        label: selected.label.slice(0, 160),
        kind: selected.kind,
        parentId: selected.parentId,
      },
      contextNodes: getBoundedIdeationContext(nodes, selected.id).map((node) => ({
        ...node,
        label: node.label.slice(0, 160),
      })),
      contextVersion,
    };
    setExpansion({
      status: 'loading',
      parentId: selected.id,
      contextVersion,
      proposals: [],
      error: null,
    });

    try {
      const response = await fetch('/api/ideation/expand', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(expansionRequest),
        signal: controller.signal,
      });
      const result = await response.json().catch(() => ({})) as {
        error?: string;
        proposals?: IdeationExpansionProposal[];
        contextVersion?: string;
        selectedNodeId?: string;
      };
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'AI Expand is unavailable while API-key protection is enabled.'
            : result.error ?? 'AI expansion failed',
        );
      }
      if (
        requestIdRef.current !== requestId
        || result.contextVersion !== contextVersion
        || result.selectedNodeId !== selected.id
      ) return;

      const latest = useIdeationStore.getState();
      if (
        latest.selectedNodeId !== selected.id
        || getIdeationContextVersion(latest.nodes, selected.id) !== contextVersion
      ) return;
      if (!result.proposals?.length) throw new Error('AI returned no suggestions');
      const childLabels = new Set(
        latest.nodes
          .filter((node) => node.parentId === selected.id)
          .map((node) => normalizeIdeationLabel(node.label)),
      );
      const proposals = result.proposals.filter(
        (proposal) => !childLabels.has(normalizeIdeationLabel(proposal.label)),
      );
      if (proposals.length < IDEATION_EXPAND_MIN_PROPOSALS) {
        throw new Error('AI returned too many duplicate suggestions. Retry to generate a fresh set.');
      }

      setExpansion({
        status: 'ready',
        parentId: selected.id,
        contextVersion,
        proposals,
        error: null,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestIdRef.current !== requestId) return;
      setExpansion({
        status: 'error',
        parentId: selected.id,
        contextVersion,
        proposals: [],
        error: error instanceof Error ? error.message : 'AI expansion failed',
      });
    } finally {
      if (requestRef.current?.id === requestId) requestRef.current = null;
    }
  }, [nodes, selected]);

  const acceptOne = useCallback((proposalId: string) => {
    if (
      expansion.status !== 'ready'
      || !expansion.parentId
      || expansion.contextVersion !== currentContextVersion
    ) return;
    const proposal = expansion.proposals.find((candidate) => candidate.id === proposalId);
    if (!proposal) return;
    const accepted = acceptProposals(expansion.parentId, [{ label: proposal.label }]);
    if (!accepted.length) {
      setExpansion((state) => {
        const proposals = state.proposals.filter((candidate) => candidate.id !== proposalId);
        return proposals.length ? {
          ...state,
          proposals,
          error: 'That suggestion already exists and was dismissed.',
        } : {
          ...EMPTY_EXPANSION,
          status: 'error',
          parentId: state.parentId,
          contextVersion: state.contextVersion,
          error: 'That suggestion already exists and was dismissed.',
        };
      });
      return;
    }
    const remaining = expansion.proposals.filter((candidate) => candidate.id !== proposalId);
    const latest = useIdeationStore.getState();
    setExpansion(remaining.length ? {
      ...expansion,
      contextVersion: getIdeationContextVersion(latest.nodes, expansion.parentId),
      proposals: remaining,
    } : EMPTY_EXPANSION);
  }, [acceptProposals, currentContextVersion, expansion]);

  const acceptAll = useCallback(() => {
    if (
      expansion.status !== 'ready'
      || !expansion.parentId
      || expansion.contextVersion !== currentContextVersion
    ) return;
    const existingLabels = new Set(
      useIdeationStore.getState().nodes
        .filter((node) => node.parentId === expansion.parentId)
        .map((node) => normalizeIdeationLabel(node.label)),
    );
    const accepted = acceptProposals(
      expansion.parentId,
      expansion.proposals.map((proposal) => ({ label: proposal.label })),
    );
    if (accepted.length !== expansion.proposals.length) {
      const rejected = expansion.proposals.filter(
        (proposal) => existingLabels.has(normalizeIdeationLabel(proposal.label)),
      );
      toast.error(`${rejected.length || expansion.proposals.length - accepted.length} suggestion(s) already existed and were skipped.`);
      setExpansion(EMPTY_EXPANSION);
      return;
    }
    setExpansion(EMPTY_EXPANSION);
  }, [acceptProposals, currentContextVersion, expansion]);

  const dismissOne = useCallback((proposalId: string) => {
    setExpansion((state) => {
      const proposals = state.proposals.filter((proposal) => proposal.id !== proposalId);
      return proposals.length ? { ...state, proposals } : EMPTY_EXPANSION;
    });
  }, []);

  const canvasNodes = useMemo<IdeationCanvasNode[]>(() => {
    const interactiveNodes = nodes.map((node) => ({
      ...node,
      onExpand: node.id === selectedNodeId ? expandSelected : undefined,
    }));
    if (expansion.status !== 'ready' || !expansion.parentId) return interactiveNodes;
    const siblingCount = nodes.filter((node) => node.parentId === expansion.parentId).length;
    return [
      ...interactiveNodes,
      ...expansion.proposals.map((proposal, index): IdeationCanvasNode => ({
        id: `ai:${proposal.id}`,
        label: proposal.label,
        kind: 'idea',
        parentId: expansion.parentId,
        sortOrder: siblingCount + index,
        properties: {},
        proposal,
        onAcceptProposal: acceptOne,
        onDismissProposal: dismissOne,
      })),
    ];
  }, [acceptOne, dismissOne, expandSelected, expansion, nodes, selectedNodeId]);

  useEffect(() => {
    document.body.dataset.ideationActive = 'true';
    return () => {
      delete document.body.dataset.ideationActive;
    };
  }, []);

  useEffect(() => {
    if (
      expansion.status !== 'idle'
      && expansion.contextVersion
      && expansion.contextVersion !== currentContextVersion
    ) {
      const timeout = window.setTimeout(clearExpansion, 0);
      return () => window.clearTimeout(timeout);
    }
  }, [clearExpansion, currentContextVersion, expansion.contextVersion, expansion.status]);

  useEffect(() => () => {
    requestRef.current?.controller.abort();
    requestRef.current = null;
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditableTarget = target instanceof HTMLElement && (
        target.matches('input, textarea, select')
        || target.isContentEditable
        || Boolean(target.closest('[contenteditable="true"]'))
      );
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
        if (event.defaultPrevented || isEditableTarget) return;
        event.preventDefault();
        undo();
      } else if (event.key === 'Escape' && expansion.status !== 'idle') {
        event.preventDefault();
        clearExpansion();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [clearExpansion, expansion.status, undo]);

  return (
    <div className="flex h-full min-h-[620px] flex-col overflow-hidden bg-[var(--surface-0)]">
      <header className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-1)] px-4 py-2.5">
        <span className="flex items-center gap-2 text-sm font-semibold text-[var(--text-primary)]">
          <Lightbulb size={16} className="text-amber-300" />
          {root?.label || 'New Project Ideation'}
        </span>
        <IdeationWorkspaceBar />
        <span className="mx-1 hidden h-4 w-px bg-[var(--border)] sm:block" />
        <Button size="sm" variant="secondary" onClick={() => addNode(selectedNodeId ?? root?.id ?? null)}>
          <Plus /> Add node
        </Button>
        <Button size="sm" variant="ghost" onClick={undo} disabled={!past.length} title="Undo (Ctrl+Z)">
          <Redo2 className="-scale-x-100" /> Undo
        </Button>
        {expansion.status === 'loading' ? (
          <Button size="sm" variant="secondary" onClick={clearExpansion}>
            <LoaderCircle className="animate-spin" /> Cancel expansion
          </Button>
        ) : (
          <Button size="sm" variant="secondary" onClick={expandSelected} disabled={!selected}>
            {expansion.status === 'error' ? <RefreshCw /> : <Sparkles />}
            {expansion.status === 'error' ? 'Retry AI Expand' : 'AI Expand'}
          </Button>
        )}
        {expansion.status === 'ready' ? (
          <>
            <Button size="sm" onClick={acceptAll}>
              <Check /> Accept all ({expansion.proposals.length})
            </Button>
            <Button size="sm" variant="ghost" onClick={clearExpansion}>
              <X /> Dismiss all
            </Button>
          </>
        ) : null}
        <span className="sr-only" aria-live="polite">
          {expansion.status === 'loading' ? `Expanding ${selected?.label ?? 'selected node'}` : null}
          {expansion.status === 'ready' ? `${expansion.proposals.length} AI suggestions ready` : null}
        </span>
        {expansion.error ? (
          <span role="alert" className="max-w-64 truncate text-xs text-red-400" title={expansion.error ?? undefined}>
            {expansion.error}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-[10px] text-[var(--text-tertiary)] lg:block">
            Drag in either panel to restructure. Right-click to promote.
          </span>
          <Button size="sm" onClick={() => setConvertOpen(true)} disabled={!root?.label.trim()}>
            <Rocket /> Convert to Project
          </Button>
        </div>
      </header>
      <div className="relative grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[340px_minmax(0,1fr)] xl:grid-cols-[340px_minmax(0,1fr)_18rem]">
        <section className="hidden min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface-1)] md:flex" aria-label="Outline panel">
          <div className="flex items-start justify-between gap-2 border-b border-[var(--border)] px-3 py-2 text-[10px] text-[var(--text-tertiary)]">
            <div>
              <div className="font-semibold uppercase tracking-wide">Outline</div>
              <div className="mt-1 font-normal">
                {outlineMode === 'visual'
                  ? '↑↓ move · Enter edit/add · Tab indent · Ctrl/Cmd+↑↓ reorder'
                  : 'Plain text · one indented line per node'}
              </div>
            </div>
            <div role="group" aria-label="Outline editing mode" className="flex rounded-md border border-[var(--border)] p-0.5">
              {(['visual', 'text'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={outlineMode === mode}
                  onClick={() => setOutlineMode(mode)}
                  className="rounded px-2 py-1 capitalize aria-pressed:bg-[var(--accent-muted)] aria-pressed:text-[var(--accent-300)]"
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>
          <div className="min-h-0 flex-1">
            {outlineMode === 'visual'
              ? <IdeationOutline nodes={canvasNodes} />
              : <TextIdeationOutline nodes={nodes} />}
          </div>
        </section>
        <section className="relative min-h-[500px]" aria-label="Mind map panel">
          <ReactFlowProvider><IdeationMindMap sourceNodes={canvasNodes} /></ReactFlowProvider>
        </section>
        <PropertyPanel />
      </div>
      {convertOpen ? <ConvertDialog onClose={() => setConvertOpen(false)} /> : null}
    </div>
  );
}
