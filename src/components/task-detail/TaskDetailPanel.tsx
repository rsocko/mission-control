'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import Image from 'next/image';
import { toast } from 'sonner';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Archive, X, Calendar, Tag, Flag, FileText, Loader2, ListChecks, Circle, CheckCircle2, Plus, Repeat, Clock, Maximize2, Minimize2, Pencil, Search, Sparkles, AlertCircle, Sun, ChevronDown, FastForward, ExternalLink, Gauge, FolderOpen, ArrowLeftRight, Bell, Ban, Copy, Columns3, Trash2, MoreHorizontal, Check, ImageOff } from 'lucide-react';
import dynamic from 'next/dynamic';
import { SubtaskSection } from './SubtaskSection';
import { TaskRelationshipsSection } from './TaskRelationshipsSection';
import { TaskAttachmentSection, useImagePasteHandler } from './TaskAttachmentSection';
import { LinkedSourcesSection } from './LinkedSourcesSection';
import { MoveToListDropdown } from './MoveToListDropdown';
import { TaskMoveDialog } from './TaskMoveDialog';
import { EffortSelect } from '@/components/EffortBadge';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { EFFORT_TO_DURATION, durationToEffort } from '@/lib/constants/task-formatting';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
}

const RAW_IMAGE_TAG_PATTERN = /^\s*<img\b(?:(?:"[^"]*"|'[^']*'|[^'">])*)\/?>\s*$/i;

function remarkOnlyEmbeddedImages() {
  return (tree: MarkdownNode) => {
    const visit = (node: MarkdownNode) => {
      node.children?.forEach((child) => {
        if (child.type === 'html' && !RAW_IMAGE_TAG_PATTERN.test(child.value ?? '')) {
          child.type = 'text';
        } else {
          visit(child);
        }
      });
    };

    visit(tree);
  };
}

const MarkdownSourceUrlContext = createContext<string | null>(null);

function EmbeddedMarkdownImage({
  src,
  alt,
  onError,
  ...imageProps
}: ImgHTMLAttributes<HTMLImageElement>) {
  const sourceUrl = useContext(MarkdownSourceUrlContext);
  const [failedSrc, setFailedSrc] = useState<ImgHTMLAttributes<HTMLImageElement>['src'] | null>(null);
  const failed = src != null && failedSrc === src;
  const isPrivateGitHubAttachment = typeof src === 'string'
    && src.startsWith('https://github.com/user-attachments/assets/');

  if (failed) {
    return (
      <span className="not-prose my-2 flex flex-col gap-3 rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-1)] p-4 text-[var(--text-secondary)]">
        <span className="flex items-start gap-3">
          <ImageOff className="mt-0.5 shrink-0 text-[var(--text-muted)]" size={18} aria-hidden="true" />
          <span>
            <span className="block text-sm font-medium text-[var(--text-primary)]">Image unavailable</span>
            <span className="mt-1 block text-xs text-[var(--text-muted)]">
              {isPrivateGitHubAttachment
                ? 'Private GitHub attachment could not be loaded.'
                : `${alt || 'The embedded image'} could not be loaded.`}
            </span>
          </span>
        </span>
        {sourceUrl && (
          <a
            href={sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit items-center gap-1.5 text-xs font-medium text-blue-400 hover:underline"
          >
            {isPrivateGitHubAttachment ? 'Open task in GitHub' : 'Open source task'}
            <ExternalLink size={12} aria-hidden="true" />
          </a>
        )}
      </span>
    );
  }

  return (
    // Markdown images can point to arbitrary remote hosts, so Next Image cannot safely optimize them.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      {...imageProps}
      src={src}
      alt={alt ?? ''}
      onError={(event) => {
        onError?.(event);
        setFailedSrc(src ?? null);
      }}
    />
  );
}

const LazyInteractiveMarkdown = dynamic(
  async () => {
    const [
      { default: ReactMarkdown },
      { default: rehypeRaw },
      { default: rehypeSanitize },
      { default: remarkBreaks },
      { default: remarkGfm },
    ] = await Promise.all([
      import('react-markdown'),
      import('rehype-raw'),
      import('rehype-sanitize'),
      import('remark-breaks'),
      import('remark-gfm'),
    ]);
    return function InteractiveMarkdown(props: {
      children: string;
      onCheckboxToggle?: (index: number, checked: boolean) => void;
      sourceUrl?: string | null;
    }) {
      let checkboxIndex = -1;
      return (
        <MarkdownSourceUrlContext.Provider value={props.sourceUrl ?? null}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm, remarkBreaks, remarkOnlyEmbeddedImages]}
            rehypePlugins={[rehypeRaw, rehypeSanitize]}
            components={{
              a: ({ node, href, ...anchorProps }) => {
                void node;
                const isExternal = /^https?:\/\//i.test(href ?? '');
                return (
                  <a
                    {...anchorProps}
                    href={href}
                    rel={isExternal ? 'noopener noreferrer' : undefined}
                    target={isExternal ? '_blank' : undefined}
                  />
                );
              },
              img: EmbeddedMarkdownImage,
              input: (inputProps) => {
                if (inputProps.type === 'checkbox') {
                  checkboxIndex++;
                  const idx = checkboxIndex;
                  return (
                    <input
                      type="checkbox"
                      checked={!!inputProps.checked}
                      onChange={(e) => {
                        e.stopPropagation();
                        props.onCheckboxToggle?.(idx, e.target.checked);
                      }}
                      className="cursor-pointer mr-1"
                    />
                  );
                }
                return <input {...inputProps} />;
              },
            }}
          >
            {props.children}
          </ReactMarkdown>
        </MarkdownSourceUrlContext.Provider>
      );
    };
  },
  { ssr: false, loading: () => <div className="animate-pulse h-4 bg-[var(--surface-1)] rounded w-3/4" /> }
);
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { MarkdownEditor } from '@/components/ui/MarkdownEditor';
import { DatePicker } from '@/components/ui/date-picker';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { MICRO_STATUS_CONFIG } from '@/types';
import type {
  LocalDisposition,
  MicroStatus,
  TaskEditPolicy,
  TaskField,
  TaskSourceModel,
} from '@/types';
import {
  canEditTaskField,
  canRemoveTask,
  canSetTaskLocalDisposition,
  TASK_DISPOSITION_OPTIONS,
  taskDispositionBlockedReason,
  taskFieldBlockedReason,
  taskFieldSaveLabel,
  taskRemovalConfirmation,
  taskRemovalLabel,
} from '@/lib/tasks/client-edit-policy';
import { getTaskDisplayId } from '@/lib/utils/task-display-id';
import { getDeepLinkInfo } from '@/lib/utils/deep-links';
import { getLocalToday } from '@/lib/utils/client-date';
import { getNextRecurringDate } from '@/lib/utils/recurrence';
import RecurrencePicker, { getRecurrenceDisplayLabel } from '@/components/ui/RecurrencePicker';
import { ReminderPicker } from '@/components/ui/ReminderPicker';
import { taskLogger } from '@/lib/client-logger';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { cn } from '@/lib/utils';
import { DuplicateTaskPreview } from './DuplicateTaskPreview';
import type { DuplicateCandidate } from './DuplicateTaskPreview';
import {
  executeProjectHierarchyCommand,
  loadProjectHierarchy,
  ProjectHierarchyClientError,
} from '@/lib/projects/hierarchy-client';
import type { ProjectHierarchySnapshot } from '@/lib/projects/hierarchy-types';
import { formatTaskDetailUpdatedAt } from '@/lib/utils/task-detail-date';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';

const CONNECTOR_ICON_PATHS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
};

const PRIORITY_COLORS: Record<string, string> = {
  critical: 'text-rose-400',
  high: 'text-orange-400',
  medium: 'text-amber-300',
  low: 'text-sky-400',
  none: 'text-[var(--text-muted)]',
};

const DURATION_OPTIONS = [
  { value: 'none', label: 'No duration' },
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '120', label: '2 hours' },
  { value: '240', label: '4 hours' },
  { value: '480', label: '1 day' },
  { value: '2400', label: '1 week' },
] as const;

// Connectors that support recurrence
const RECURRENCE_CONNECTORS = ['microsoft-todo', 'outlook-calendar'];

interface TaskTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

interface TagConnectorCaps {
  tagWriteBack: boolean;
  tagCreationMode: 'freeform' | 'predefined';
  tagScope: 'global' | 'per-list';
}

interface Subtask {
  id: string;
  title: string;
  status: string;
}

interface TaskDetail {
  id: string;
  title: string;
  description: string | null;
  status: string;
  microStatus: string | null;
  statusReason: string | null;
  priority: string;
  dueDate: string | null;
  connectorType: string;
  connectorInstanceId: string;
  sourceListId: string | null;
  sourceListName: string | null;
  sourceId: string | null;
  sourceUrl: string | null;
  assignee: string | null;
  createdAt: string;
  updatedAt: string;
  tagIds: string[];
  projectIds: string[];
  subtasks: Subtask[];
  metadata: string | null;
  estimatedDuration?: number | null;
  recurrence?: string | null;
  effort?: number | null;
  reminderAt?: string | null;
  isInMyDay?: boolean;
  localDisposition: LocalDisposition;
  taskSourceModel: TaskSourceModel;
  editPolicy: TaskEditPolicy;
}

interface SourceList {
  id: string;
  sourceId: string;
  connectorInstanceId: string;
  name: string;
  taskCount: number;
  groupId: string | null;
}

export interface TaskFieldUpdate {
  [key: string]: string | number | null | undefined;
}

interface HubProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  hidden?: boolean;
}

function taskPhaseInProject(
  hierarchy: ProjectHierarchySnapshot | null | undefined,
  taskId: string,
) {
  if (!hierarchy) return null;
  return hierarchy.phases.find((phase) => (
    hierarchy.phaseItemsByPhase[phase.id]?.some((item) => item.taskId === taskId)
  )) ?? null;
}

function formatShortDate(value: string): string {
  return new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}

export type TaskDetailMode = 'panel' | 'dialog' | 'workspace' | 'mobile';

export interface TaskNotesOpenRequest {
  requestId: number;
  taskId: string;
  mode: 'read' | 'edit';
}

interface TaskDetailPanelProps {
  taskId: string;
  onClose: () => void;
  onUpdate?: (fields?: TaskFieldUpdate) => void;
  onSubtaskCountChange?: (done: number, total: number) => void;
  availableTags?: TaskTag[];
  mode?: TaskDetailMode;
  onModeChange?: (mode: Exclude<TaskDetailMode, 'mobile'>) => void;
  isInMyDay?: boolean;
  onToggleMyDay?: () => void | Promise<void>;
  sourceLists?: SourceList[];
  onMoveToList?: (targetListId: string) => void;
  /** Let a host preserve its completion workflow, such as Today undo and events. */
  onComplete?: () => void | Promise<void>;
  /** Let a host preserve its deletion confirmation and undo workflow. */
  onDelete?: () => void | Promise<void>;
  autoOpenMoveDialog?: boolean;
  /** Called when the move dialog auto-opened via autoOpenMoveDialog is dismissed */
  onMoveDialogDismissed?: () => void;
  /** Disable the panel's own entrance animation when a parent transition owns it. */
  animatePanel?: boolean;
  /** Render dialog mode outside an ancestor that creates a containing block. */
  portalDialog?: boolean;
  /** Override the minimum resizable width when a host surface requires more coverage. */
  minPanelWidth?: number;
  /** Move keyboard focus into the panel when it opens. */
  focusPanelOnMount?: boolean;
  /** Open the existing expanded Notes dialog after the requested task loads. */
  notesOpenRequest?: TaskNotesOpenRequest | null;
}

export function TaskDetailPanel({ taskId, onClose, onUpdate, onSubtaskCountChange, availableTags = [], mode = 'panel', onModeChange, isInMyDay, onToggleMyDay, sourceLists = [], onMoveToList, onComplete, onDelete, autoOpenMoveDialog = false, onMoveDialogDismissed, animatePanel = true, portalDialog = false, minPanelWidth = 280, focusPanelOnMount = false, notesOpenRequest = null }: TaskDetailPanelProps) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingDesc, setEditingDesc] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [expandedNotesEditing, setExpandedNotesEditing] = useState(false);
  const [titleValue, setTitleValue] = useState('');
  const [descValue, setDescValue] = useState('');
  const [showMicroStatusPicker, setShowMicroStatusPicker] = useState(false);
  const [microStatusSuggestion, setMicroStatusSuggestion] = useState<{ status: string; reason: string } | null>(null);
  const [showCloseReasonPicker, setShowCloseReasonPicker] = useState(false);
  const [pendingStatus, setPendingStatus] = useState<string | null>(null);
  const [potentialDuplicates, setPotentialDuplicates] = useState<DuplicateCandidate[]>([]);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  // Tag editing state
  const [showTagPicker, setShowTagPicker] = useState(false);
  const [pickerTags, setPickerTags] = useState<TaskTag[]>([]);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [connectorCaps, setConnectorCaps] = useState<TagConnectorCaps | null>(null);
  const [supportsAttachments, setSupportsAttachments] = useState(false);
  const [supportsSubtasks, setSupportsSubtasks] = useState(false);
  const [recurrenceFocused, setRecurrenceFocused] = useState(false);
  const [skippingToCurrent, setSkippingToCurrent] = useState(false);
  const [updatingDisposition, setUpdatingDisposition] = useState(false);
  const [updatingMyDay, setUpdatingMyDay] = useState(false);
  const tagPickerRef = useRef<HTMLDivElement>(null);
  // Extra tags fetched via picker (not in parent's availableTags list)
  const [extraTags, setExtraTags] = useState<TaskTag[]>([]);
  const [hubProjects, setHubProjects] = useState<HubProject[]>([]);
  const [projectHierarchies, setProjectHierarchies] = useState<Record<string, ProjectHierarchySnapshot | null>>({});
  const [updatingProjectPhaseIds, setUpdatingProjectPhaseIds] = useState<Set<string>>(new Set());
  // Cross-source move dialog
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [portalRoot, setPortalRoot] = useState<HTMLElement | null>(null);
  const [writableConnectors, setWritableConnectors] = useState<Array<{ id: string; type: string; name: string }>>([]);
  const [panelWidth, setPanelWidth] = useState(() => {
    if (typeof window !== 'undefined') {
      const stored = localStorage.getItem('mission-control:detail-panel-width');
      const storedWidth = stored ? Number.parseInt(stored, 10) : Number.NaN;
      return Number.isFinite(storedWidth)
        ? Math.max(minPanelWidth, Math.min(600, storedWidth))
        : Math.max(minPanelWidth, 430);
    }
    return Math.max(minPanelWidth, 430);
  });
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const recurrenceSectionRef = useRef<HTMLElement>(null);
  const recurrenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const subtasksSectionRef = useRef<HTMLElement>(null);
  const subtasksHeadingRef = useRef<HTMLHeadingElement>(null);
  const modalDialogRef = useRef<HTMLDivElement>(null);
  const notesDialogRef = useRef<HTMLElement>(null);
  const notesExpandButtonRef = useRef<HTMLButtonElement>(null);
  const expandedDescRef = useRef<HTMLTextAreaElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  const handledNotesRequestRef = useRef<number | null>(null);
  const recurrenceFocusTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skipToCurrentInFlightRef = useRef(false);
  const canEdit = (field: TaskField) => canEditTaskField(task?.editPolicy, field);
  const blockedReason = (field: TaskField) => taskFieldBlockedReason(task?.editPolicy, field);
  const canEditTitle = canEdit('title');
  const canEditDescription = canEdit('description');
  const canEditStatus = canEdit('status');
  const canEditPriority = canEdit('priority');
  const canEditDueDate = canEdit('dueDate');
  const canEditEffort = canEdit('effort');
  const canEditDuration = canEdit('estimatedDuration');
  const canEditEffortAndDuration = canEditEffort && canEditDuration;
  const effortDurationBlockedReason = !canEditEffort
    ? blockedReason('effort')
    : !canEditDuration
      ? blockedReason('estimatedDuration')
      : undefined;
  const canEditMicroStatus = canEdit('microStatus');
  const canEditTags = canEdit('tags');
  const canEditProjects = canEdit('projects');
  const canEditPhases = canEdit('phases');
  const canEditReminder = canEdit('reminderAt');
  const canEditRecurrence = canEdit('recurrence');
  const canEditDependencies = canEdit('dependencies');
  const canDeleteTask = canRemoveTask(task?.editPolicy);
  const effectiveIsInMyDay = isInMyDay ?? task?.isInMyDay ?? false;
  const dispositionOptions = task
    ? TASK_DISPOSITION_OPTIONS.filter((option) => (
        option.value !== task.localDisposition
        && canSetTaskLocalDisposition(task.editPolicy, task.localDisposition, option.value)
      ))
    : [];
  const canManageSourceOperation = Boolean(
    task?.editPolicy.connectorEnabled
    || task?.editPolicy.sourceModel === 'mc-owned'
    || task?.editPolicy.sourceModel === 'ingested',
  );
  const canManageAttachments = supportsAttachments && canManageSourceOperation;
  const canManageSubtasks = supportsSubtasks && canEditDependencies;
  const ensureFieldsEditable = useCallback((...fields: TaskField[]) => {
    const blockedField = fields.find((field) => !canEditTaskField(task?.editPolicy, field));
    if (!blockedField) return true;
    toast.error(taskFieldBlockedReason(task?.editPolicy, blockedField));
    return false;
  }, [task?.editPolicy]);

  const closeExpandedNotes = useCallback(() => {
    setDescValue(task?.description || '');
    setEditingDesc(false);
    setExpandedNotesEditing(false);
    setNotesExpanded(false);
  }, [task?.description]);

  useEffect(() => {
    setPortalRoot(document.body);
  }, []);

  useEffect(() => () => {
    if (recurrenceFocusTimeoutRef.current) clearTimeout(recurrenceFocusTimeoutRef.current);
  }, []);

  useEffect(() => {
    if (!focusPanelOnMount || mode !== 'panel') return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus({ preventScroll: true });
    return () => previousFocus?.focus({ preventScroll: true });
  }, [focusPanelOnMount, mode]);

  // Fetch full task details
  useEffect(() => {
    setLoading(true);
    setEditingTitle(false);
    setEditingDesc(false);
    setNotesExpanded(false);
    setExpandedNotesEditing(false);
    setShowTagPicker(false);
    setExtraTags([]);
    setConnectorCaps(null);
    setPotentialDuplicates([]);
    setShowCloseReasonPicker(false);
    setPendingStatus(null);
    fetch(`/api/tasks/${taskId}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.task) {
          setTask(data.task);
          setTitleValue(data.task.title);
          setDescValue(data.task.description || '');
        }
      })
      .catch((err) => { taskLogger.error('Failed to fetch task details', { err, taskId }); })
      .finally(() => setLoading(false));
  }, [taskId]);

  useEffect(() => {
    if (!task || !notesOpenRequest) return;
    if (task.id !== notesOpenRequest.taskId) return;
    if (handledNotesRequestRef.current === notesOpenRequest.requestId) return;
    handledNotesRequestRef.current = notesOpenRequest.requestId;
    setDescValue(task.description || '');
    setExpandedNotesEditing(notesOpenRequest.mode === 'edit' && canEditDescription);
    setNotesExpanded(true);
  }, [canEditDescription, notesOpenRequest, task]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (e.defaultPrevented) return;
      if (
        document.activeElement instanceof HTMLElement
        && document.activeElement.closest('[data-task-relationship-editor]')
      ) return;
      if (notesExpanded) {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeExpandedNotes();
        return;
      }
      if (
        editingDesc
        && e.target instanceof HTMLElement
        && e.target.closest('[data-markdown-editor]')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setDescValue(task?.description || '');
        setEditingDesc(false);
        return;
      }
      if (mode === 'panel' && panelRef.current?.offsetParent === null) return;
      onClose();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [closeExpandedNotes, editingDesc, mode, notesExpanded, onClose, task?.description]);

  useEffect(() => {
    if (!notesExpanded) return;
    const dialog = notesDialogRef.current;
    const overlay = dialog?.parentElement;
    const backgroundElements = Array.from(document.body.children)
      .filter((element): element is HTMLElement => element instanceof HTMLElement && element !== overlay);
    const previousInert = backgroundElements.map((element) => element.inert);
    const returnFocus = notesExpandButtonRef.current;
    backgroundElements.forEach((element) => { element.inert = true; });
    const focusable = () => Array.from(dialog?.querySelectorAll<HTMLElement>(
      'button:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ) ?? []);
    const frame = requestAnimationFrame(() => {
      (dialog?.querySelector<HTMLElement>('[data-notes-autofocus]') ?? focusable()[0])?.focus();
    });
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog?.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', trapFocus);
      backgroundElements.forEach((element, index) => { element.inert = previousInert[index]; });
      returnFocus?.focus();
    };
  }, [notesExpanded]);

  useEffect(() => {
    if ((mode !== 'dialog' && mode !== 'workspace') || !task) return;
    const dialog = modalDialogRef.current;
    if (!dialog) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const overlay = dialog.parentElement;
    const containingBodyChild = Array.from(document.body.children).find((element) => element.contains(dialog));
    const backgroundElements = [
      ...Array.from(document.body.children).filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== containingBodyChild,
      ),
      ...Array.from(overlay?.parentElement?.children ?? []).filter(
        (element): element is HTMLElement => element instanceof HTMLElement && element !== overlay,
      ),
    ];
    const uniqueBackgroundElements = [...new Set(backgroundElements)];
    const previousInert = uniqueBackgroundElements.map((element) => element.inert);
    uniqueBackgroundElements.forEach((element) => { element.inert = true; });
    const focusable = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    ));
    const frame = requestAnimationFrame(() => (focusable()[0] ?? dialog).focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', trapFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', trapFocus);
      uniqueBackgroundElements.forEach((element, index) => { element.inert = previousInert[index]; });
      previousFocus?.focus();
    };
  }, [mode, task?.id]);

  // Auto-detect potential duplicates for open tasks
  useEffect(() => {
    if (!task || (task.status !== 'todo' && task.status !== 'in_progress')) return;
    fetch(`/api/tasks/detect-duplicates?taskId=${task.id}`)
      .then((r) => r.json())
      .then((data: { duplicates?: DuplicateCandidate[] }) => {
        if (data.duplicates?.length) {
          setPotentialDuplicates(data.duplicates);
        }
      })
      .catch(() => { /* non-critical, ignore */ });
  }, [task?.id, task?.status]);

  // Fetch connector capabilities for tag editing when task loads
  useEffect(() => {
    if (!task?.connectorInstanceId) {
      setConnectorCaps(null);
      setSupportsAttachments(false);
      setSupportsSubtasks(false);
      return;
    }
    // Local tasks always support attachments
    const isLocal = task.connectorType === 'local' || Boolean(task.sourceId?.startsWith('local:'));
    setConnectorCaps(null);
    setSupportsAttachments(isLocal);
    setSupportsSubtasks(isLocal);
    const controller = new AbortController();
    fetch('/api/features', { signal: controller.signal })
      .then(r => r.json())
      .then((data: { taskDestinations?: Array<{ id: string; capabilities: Record<string, unknown> }> }) => {
        const dest = data.taskDestinations?.find(d => d.id === task.connectorInstanceId);
        if (dest?.capabilities) {
          setConnectorCaps({
            tagWriteBack: !!(dest.capabilities.tagWriteBack),
            tagCreationMode: (dest.capabilities.tagCreationMode as 'freeform' | 'predefined') || 'freeform',
            tagScope: (dest.capabilities.tagScope as 'global' | 'per-list') || 'global',
          });
          setSupportsAttachments(isLocal || !!(dest.capabilities.attachments));
          setSupportsSubtasks(isLocal || !!(dest.capabilities.subtasks));
        } else {
          setConnectorCaps(null);
          if (!isLocal) {
            setSupportsAttachments(false);
            setSupportsSubtasks(false);
          }
        }
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setConnectorCaps(null);
        if (!isLocal) {
          setSupportsAttachments(false);
          setSupportsSubtasks(false);
        }
      });
    return () => controller.abort();
  }, [task?.connectorInstanceId, task?.connectorType, task?.sourceId]);

  // Fetch hub projects for project assignment
  useEffect(() => {
    fetch('/api/hub-projects?includeHidden=true')
      .then(r => r.json())
      .then(data => setHubProjects(data.projects || []))
      .catch(() => setHubProjects([]));
  }, []);

  useEffect(() => {
    const projectIds = task?.projectIds ?? [];
    if (!task || projectIds.length === 0) {
      setProjectHierarchies({});
      return;
    }

    let cancelled = false;
    setProjectHierarchies({});
    projectIds.forEach((projectId) => {
      void loadProjectHierarchy(projectId).then((hierarchy) => {
        if (cancelled) return;
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: hierarchy }));
      }).catch((error) => {
        taskLogger.error('Failed to load project phases', { err: error, projectId, taskId });
        if (cancelled) return;
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: null }));
      });
    });
    return () => { cancelled = true; };
  }, [task?.id, task?.projectIds, taskId]);

  // Fetch writable connectors for cross-source move dialog
  useEffect(() => {
    fetch('/api/connectors')
      .then(r => r.json())
      .then((data: { connectors?: Array<{ id: string; type: string; name: string; capabilities: Record<string, unknown> }> }) => {
        const writable = (data.connectors || []).filter(
          (c) => c.capabilities?.taskCreate,
        );
        setWritableConnectors(writable.map(c => ({ id: c.id, type: c.type, name: c.name })));
      })
      .catch(() => setWritableConnectors([]));
  }, [task?.connectorInstanceId]);

  // Auto-open move dialog when requested via prop (e.g. from context menu "Move to another source…")
  useEffect(() => {
    if (autoOpenMoveDialog && writableConnectors.length > 0 && !showMoveDialog) {
      setShowMoveDialog(true);
    }
  }, [autoOpenMoveDialog, writableConnectors.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close tag picker on click outside
  useEffect(() => {
    if (!showTagPicker) return;
    const handler = (e: MouseEvent) => {
      if (tagPickerRef.current && !tagPickerRef.current.contains(e.target as Node)) {
        setShowTagPicker(false);
        setTagInput('');
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showTagPicker]);

  const saveField = useCallback(async (field: TaskField, value: string | number | null | undefined) => {
    if (!ensureFieldsEditable(field)) return false;
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: value }),
      });
      if (!response.ok) throw new Error(`Failed to save ${field}`);
      onUpdate?.({ [field]: value });
      return true;
    } catch {
      toast.error(`Failed to save ${field === 'description' ? 'notes' : field}`);
      return false;
    }
  }, [ensureFieldsEditable, taskId, onUpdate]);

  const handleTitleBlur = async () => {
    if (titleValue.trim() && titleValue !== task?.title) {
      const saved = await saveField('title', titleValue.trim());
      if (!saved) return false;
      setTask((prev) => prev ? { ...prev, title: titleValue.trim() } : prev);
    }
    setEditingTitle(false);
    return true;
  };

  const handleDescBlur = async () => {
    if (descValue !== (task?.description || '')) {
      const saved = await saveField('description', descValue || null);
      if (!saved) return false;
      setTask((prev) => prev ? { ...prev, description: descValue || null } : prev);
    }
    setEditingDesc(false);
    return true;
  };

  const handleCheckboxToggle = useCallback(async (index: number, checked: boolean) => {
    if (!task?.description) return;
    const taskListRegex = /^([\s]*-\s+\[)([ xX])(\]\s+.+)$/gm;
    let cbIndex = -1;
    const newDesc = task.description.replace(taskListRegex, (match, prefix, state, suffix) => {
      cbIndex++;
      if (cbIndex === index) {
        return `${prefix}${checked ? 'x' : ' '}${suffix}`;
      }
      return match;
    });
    const saved = await saveField('description', newDesc);
    if (!saved) return;
    setDescValue(newDesc);
    setTask((prev) => prev ? { ...prev, description: newDesc } : prev);
  }, [task?.description, saveField]);

  const openTagPicker = useCallback(async () => {
    setShowTagPicker(true);
    setTagInput('');
    setPickerLoading(true);
    try {
      const params = new URLSearchParams();
      if (connectorCaps?.tagScope === 'per-list' && task?.sourceListId) {
        params.set('listId', task.sourceListId);
      }
      // When the source doesn't support tag write-back, only show tags from that source
      if (connectorCaps && !connectorCaps.tagWriteBack && task?.connectorType) {
        params.set('source', task.connectorType);
      }
      const url = params.toString() ? `/api/tags?${params.toString()}` : '/api/tags';
      const res = await fetch(url);
      const data = await res.json();
      setPickerTags(data.tags || []);
      // Merge any new tags into extraTags so display is consistent
      setExtraTags(prev => {
        const existing = new Set(prev.map(t => t.id));
        const incoming = (data.tags || []).filter((t: TaskTag) => !existing.has(t.id));
        return [...prev, ...incoming];
      });
    } catch {
      setPickerTags([]);
    } finally {
      setPickerLoading(false);
    }
  }, [connectorCaps?.tagScope, connectorCaps?.tagWriteBack, task?.sourceListId, task?.connectorType]);

  const handleAddTag = useCallback(async (tagName: string) => {
    if (!tagName.trim() || !ensureFieldsEditable('tags')) return;
    const res = await fetch(`/api/tasks/${taskId}/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tags: [tagName.trim()] }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      toast.error(err.error || 'Failed to add tag');
      return;
    }
    const data = await res.json();
    if (data.rejectedTags?.length && !data.addedTagIds?.length) {
      toast.error(`Label "${data.rejectedTags[0]}" doesn't exist in this source. Please create it there first.`);
      return;
    }
    if (data.addedTagIds?.length) {
      // Find the tag in pickerTags or available tags to get its full details
      const allKnown = [...pickerTags, ...availableTags, ...extraTags];
      const addedTag = allKnown.find(t => data.addedTagIds.includes(t.id));
      setTask(prev => prev ? { ...prev, tagIds: [...(prev.tagIds || []), ...data.addedTagIds] } : prev);
      if (addedTag) {
        setExtraTags(prev => prev.some(t => t.id === addedTag.id) ? prev : [...prev, addedTag]);
      } else {
        // Tag was newly created (freeform); refresh picker to get it
        const params = new URLSearchParams();
        if (connectorCaps?.tagScope === 'per-list' && task?.sourceListId) {
          params.set('listId', task.sourceListId);
        }
        if (connectorCaps && !connectorCaps.tagWriteBack && task?.connectorType) {
          params.set('source', task.connectorType);
        }
        const url = params.toString() ? `/api/tags?${params.toString()}` : '/api/tags';
        fetch(url)
          .then(r => r.json())
          .then(d => {
            const newTag = (d.tags || []).find((t: TaskTag) => data.addedTagIds.includes(t.id));
            if (newTag) setExtraTags(prev => prev.some(t => t.id === newTag.id) ? prev : [...prev, newTag]);
          })
          .catch((err) => { taskLogger.error('Failed to refresh tags after creation', { err }); });
      }
      onUpdate?.();
    }
    setTagInput('');
  }, [taskId, pickerTags, availableTags, extraTags, connectorCaps?.tagScope, connectorCaps?.tagWriteBack, task?.sourceListId, task?.connectorType, onUpdate, ensureFieldsEditable]);

  const handleRemoveTag = useCallback(async (tagId: string) => {
    if (!ensureFieldsEditable('tags')) return;
    setTask(prev => prev ? { ...prev, tagIds: (prev.tagIds || []).filter(id => id !== tagId) } : prev);
    const res = await fetch(`/api/tasks/${taskId}/tags`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tagId }),
    });
    if (!res.ok) {
      // Revert optimistic update
      setTask(prev => prev ? { ...prev, tagIds: [...(prev.tagIds || []), tagId] } : prev);
      toast.error('Failed to remove tag');
      return;
    }
    onUpdate?.();
  }, [ensureFieldsEditable, taskId, onUpdate]);

  const handleStatusChange = useCallback(async (status: string) => {
    // Handle "Close as Not Planned" / "Close as Duplicate" from dropdown
    if (status.startsWith('cancelled:')) {
      if (!ensureFieldsEditable('status', 'statusReason')) return;
      const reason = status.slice('cancelled:'.length) as 'not_planned' | 'duplicate';
      const updates = { status: 'cancelled', statusReason: reason };
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });
      if (!response.ok) {
        toast.error('Failed to update task status');
        return;
      }
      if (!ensureFieldsEditable('status')) return;
      setTask((prev) => prev ? { ...prev, status: 'cancelled', statusReason: reason } : prev);
      onUpdate?.({ status: 'cancelled', statusReason: reason });
      return;
    }
    // For GitHub tasks being cancelled (plain), offer close reason selection
    if (status === 'cancelled' && task?.connectorType === 'github-issues') {
      setPendingStatus(status);
      setShowCloseReasonPicker(true);
      return;
    }
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    if (!response.ok) {
      toast.error('Failed to update task status');
      return;
    }
    setTask((prev) => prev ? { ...prev, status, statusReason: null } : prev);
    onUpdate?.({ status });
  }, [ensureFieldsEditable, taskId, onUpdate, task?.connectorType]);

  const handleComplete = useCallback(() => {
    if (onComplete) {
      void onComplete();
      return;
    }
    void handleStatusChange('done');
  }, [handleStatusChange, onComplete]);

  const handleToggleMyDay = useCallback(async () => {
    if (updatingMyDay) return;
    setUpdatingMyDay(true);
    try {
      if (onToggleMyDay) {
        await onToggleMyDay();
        return;
      }

      const response = effectiveIsInMyDay
        ? await fetch(`/api/my-day?${new URLSearchParams({ taskId, date: getLocalToday() })}`, {
            method: 'DELETE',
          })
        : await fetch('/api/my-day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId, date: getLocalToday() }),
          });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to update My Day');
      }

      const nextIsInMyDay = !effectiveIsInMyDay;
      setTask((current) => (
        current?.id === taskId ? { ...current, isInMyDay: nextIsInMyDay } : current
      ));
      onUpdate?.();
      if (nextIsInMyDay) {
        window.dispatchEvent(new CustomEvent('mission-control:my-day-item-added', {
          detail: { taskId, title: task?.title },
        }));
      }
      if (data.writeBack?.attempted && !data.writeBack?.success) {
        toast.warning(`${nextIsInMyDay ? 'Added to' : 'Removed from'} My Day locally, but failed to sync to Microsoft To Do`);
      } else {
        toast.success(nextIsInMyDay ? 'Added to My Day' : 'Removed from My Day');
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to update My Day');
    } finally {
      setUpdatingMyDay(false);
    }
  }, [effectiveIsInMyDay, onToggleMyDay, onUpdate, task?.title, taskId, updatingMyDay]);

  const handleDelete = useCallback(() => {
    if (!task || !canDeleteTask) return;
    if (onDelete) {
      void onDelete();
      return;
    }
    const confirmation = taskRemovalConfirmation(task.editPolicy, task.title);
    setConfirmDialog({
      open: true,
      ...confirmation,
      variant: 'danger',
      onConfirm: () => {
        setConfirmDialog((dialog) => ({ ...dialog, open: false }));
        void (async () => {
          try {
            const response = await fetch(`/api/tasks/${task.id}`, { method: 'DELETE' });
            if (!response.ok) throw new Error('Failed to delete task');
            toast.success('Task deleted');
            onUpdate?.();
            onClose();
          } catch {
            toast.error('Failed to delete task');
          }
        })();
      },
    });
  }, [canDeleteTask, onClose, onDelete, onUpdate, task]);

  const handleCloseWithReason = useCallback(async (reason: 'not_planned' | 'duplicate') => {
    if (!ensureFieldsEditable('status', 'statusReason')) return;
    const status = pendingStatus || 'cancelled';
    const updates = { status, statusReason: reason };
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      toast.error('Failed to update task status');
      return;
    }
    setTask((prev) => prev ? { ...prev, status, statusReason: reason } : prev);
    setShowCloseReasonPicker(false);
    setPendingStatus(null);
    onUpdate?.({ status, statusReason: reason });
  }, [ensureFieldsEditable, taskId, onUpdate, pendingStatus]);

  const handlePriorityChange = async (priority: string) => {
    if (!(await saveField('priority', priority))) return;
    setTask((prev) => prev ? { ...prev, priority } : prev);
  };

  const handleLocalDispositionChange = async (localDisposition: LocalDisposition) => {
    if (!task || !canSetTaskLocalDisposition(
      task.editPolicy,
      task.localDisposition,
      localDisposition,
    )) {
      toast.error(task
        ? taskDispositionBlockedReason(task.editPolicy, task.localDisposition, localDisposition)
        : 'Task disposition is unavailable');
      return;
    }

    const previousDisposition = task.localDisposition;
    setUpdatingDisposition(true);
    setTask((current) => current ? { ...current, localDisposition } : current);
    try {
      const response = await fetch(`/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ localDisposition }),
      });
      const data = await response.json() as {
        fields?: { localDisposition?: { persisted?: boolean } };
        error?: string;
      };
      if (!response.ok || data.fields?.localDisposition?.persisted !== true) {
        throw new Error(data.error || 'Mission Control state was not saved');
      }
      toast.success(localDisposition === 'handled'
        ? 'Marked handled in Mission Control'
        : localDisposition === 'dismissed'
          ? 'Dismissed in Mission Control'
          : 'Restored in Mission Control');
      onUpdate?.({ localDisposition });
    } catch (error) {
      setTask((current) => current ? { ...current, localDisposition: previousDisposition } : current);
      toast.error(error instanceof Error ? error.message : 'Failed to update Mission Control state');
    } finally {
      setUpdatingDisposition(false);
    }
  };

  const [durationHighlight, setDurationHighlight] = useState(false);
  const [effortHighlight, setEffortHighlight] = useState(false);

  const handleEffortChange = async (effort: number | null) => {
    const suggestedDuration = effort ? EFFORT_TO_DURATION[effort] : undefined;
    const updates = suggestedDuration
      ? { effort, estimatedDuration: suggestedDuration }
      : { effort };
    const fields: TaskField[] = suggestedDuration ? ['effort', 'estimatedDuration'] : ['effort'];
    if (!ensureFieldsEditable(...fields)) return;
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      toast.error('Failed to update effort');
      return;
    }
    if (suggestedDuration) {
      setDurationHighlight(true);
      setTimeout(() => setDurationHighlight(false), 700);
    }
    setTask((prev) => prev ? { ...prev, ...updates } : prev);
    onUpdate?.(updates);
  };

  const handleDueDateChange = async (dueDate: string) => {
    if (!(await saveField('dueDate', dueDate || null))) return false;
    setTask((prev) => prev?.id === taskId ? { ...prev, dueDate: dueDate || null } : prev);
    return true;
  };

  const handleReminderChange = useCallback((reminderAt: string | null) => {
    void saveField('reminderAt', reminderAt).then((saved) => {
      if (saved) setTask((prev) => prev ? { ...prev, reminderAt } : prev);
    });
  }, [saveField]);

  const handleMicroStatusChange = useCallback(async (microStatus: string | null) => {
    if (!ensureFieldsEditable('microStatus')) return;
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ microStatus }),
    });
    if (!response.ok) {
      toast.error('Failed to update micro-status');
      return;
    }
    setTask((prev) => prev ? { ...prev, microStatus } : prev);
    setShowMicroStatusPicker(false);
    setMicroStatusSuggestion(null);
    onUpdate?.({ microStatus });
  }, [ensureFieldsEditable, taskId, onUpdate]);

  const fetchMicroStatusSuggestion = useCallback(async () => {
    try {
      const res = await fetch('/api/ai/suggest-micro-status');
      if (!res.ok) return;
      const data = await res.json();
      const match = data.suggestions?.find((s: { taskId: string }) => s.taskId === taskId);
      if (match) {
        setMicroStatusSuggestion({ status: match.suggestedStatus, reason: match.reason });
      }
    } catch { /* ignore */ }
  }, [taskId]);

  const handleRecurrenceChange = async (recurrence: string) => {
    const value = recurrence === 'none' ? null : recurrence;
    if (!(await saveField('recurrence', value))) return;
    setTask((prev) => prev ? { ...prev, recurrence: value } : prev);
  };

  const handleDurationChange = useCallback(async (minutes: number | null) => {
    const suggestedEffort = minutes ? durationToEffort(minutes) : undefined;
    const updates = suggestedEffort
      ? { estimatedDuration: minutes, effort: suggestedEffort }
      : { estimatedDuration: minutes };
    const fields: TaskField[] = suggestedEffort ? ['estimatedDuration', 'effort'] : ['estimatedDuration'];
    if (!ensureFieldsEditable(...fields)) return;
    const response = await fetch(`/api/tasks/${taskId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      toast.error('Failed to update duration');
      return;
    }
    if (suggestedEffort) {
      setEffortHighlight(true);
      setTimeout(() => setEffortHighlight(false), 700);
    }
    setTask((prev) => prev ? { ...prev, ...updates } : prev);
    onUpdate?.(updates);
  }, [ensureFieldsEditable, taskId, onUpdate]);

  const handleAddProject = useCallback(async (projectId: string) => {
    if (!task || !projectId || task.projectIds?.includes(projectId) || !ensureFieldsEditable('projects')) return;
    const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    });
    if (!response.ok) {
      toast.error('Failed to add project');
      return;
    }
    setTask((prev) => prev ? { ...prev, projectIds: [...(prev.projectIds || []), projectId] } : prev);
    onUpdate?.();
  }, [ensureFieldsEditable, task, onUpdate]);

  const handleRemoveProject = useCallback(async (projectId: string) => {
    if (!task || !ensureFieldsEditable('projects')) return;
    const response = await fetch(`/api/hub-projects/${projectId}/tasks`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: task.id }),
    });
    if (!response.ok) {
      toast.error('Failed to remove project');
      return;
    }
    setTask((prev) => prev ? { ...prev, projectIds: (prev.projectIds || []).filter((id) => id !== projectId) } : prev);
    setProjectHierarchies((prev) => {
      const next = { ...prev };
      delete next[projectId];
      return next;
    });
    onUpdate?.();
  }, [ensureFieldsEditable, task, onUpdate]);

  const handleProjectPhaseChange = useCallback(async (projectId: string, phaseId: string | null) => {
    if (!task || !ensureFieldsEditable('phases')) return;
    const hierarchy = projectHierarchies[projectId];
    if (!hierarchy) {
      toast.error('Project phases are unavailable');
      return;
    }
    if (taskPhaseInProject(hierarchy, task.id)?.id === phaseId) return;

    setUpdatingProjectPhaseIds((prev) => new Set(prev).add(projectId));
    try {
      const result = await executeProjectHierarchyCommand({
        projectId,
        expectedRevision: hierarchy.revision,
        command: {
          type: 'move_tasks',
          taskIds: [task.id],
          toPhaseId: phaseId,
          toIndex: phaseId ? (hierarchy.phaseItemsByPhase[phaseId]?.length ?? 0) : 0,
        },
      });
      setProjectHierarchies((prev) => ({ ...prev, [projectId]: result.hierarchy }));
      onUpdate?.();
    } catch (error) {
      if (error instanceof ProjectHierarchyClientError && error.current) {
        setProjectHierarchies((prev) => ({ ...prev, [projectId]: error.current! }));
      }
      toast.error(error instanceof Error ? error.message : 'Failed to update project phase');
    } finally {
      setUpdatingProjectPhaseIds((prev) => {
        const next = new Set(prev);
        next.delete(projectId);
        return next;
      });
    }
  }, [ensureFieldsEditable, onUpdate, projectHierarchies, task]);

  const parsedMetadata = task?.metadata ? (() => { try { return JSON.parse(task.metadata); } catch { return {}; } })() : {};
  const currentRecurrence: string = task?.recurrence !== undefined
    ? task.recurrence ?? 'none'
    : parsedMetadata?.recurrence ?? 'none';
  const supportsRecurrence = task ? RECURRENCE_CONNECTORS.includes(task.connectorType) : false;

  // Pre-compute the next recurring date for the "Skip to current" action.
  // Only defined when the task is overdue and has a recurrence set.
  const taskDueDateOnly = task?.dueDate?.split('T')[0] ?? null;
  const todayForPanel = getLocalToday();
  const skipToCurrentDate =
    currentRecurrence !== 'none' && taskDueDateOnly && taskDueDateOnly < todayForPanel
      ? getNextRecurringDate(taskDueDateOnly, currentRecurrence, todayForPanel)
      : null;
  const isOverdue = Boolean(
    taskDueDateOnly
    && taskDueDateOnly < todayForPanel
    && task?.status !== 'done'
    && task?.status !== 'cancelled',
  );

  const taskTags = Array.from(new Map([...availableTags, ...extraTags].map(t => [t.id, t])).values()).filter((t) => task?.tagIds?.includes(t.id) && !isSyntheticTag(t.name));
  const assignableProjects = hubProjects.filter((project) => !project.hidden);
  const iconSrc = task ? CONNECTOR_ICON_PATHS[task.connectorType] : null;
  const sameSourceLists = task?.connectorInstanceId
    ? sourceLists.filter((l) => l.connectorInstanceId === task.connectorInstanceId)
    : sourceLists;
  const supportsMoveToList = task
    ? task.editPolicy.sourceMoveSupported && sameSourceLists.length > 0 && !!onMoveToList
    : false;

  const handleSubtasksChange = useCallback((subtasks: { id: string; title: string; status: string }[]) => {
    setTask((prev) => prev ? { ...prev, subtasks } : prev);
    const done = subtasks.filter(s => s.status === 'done').length;
    onSubtaskCountChange?.(done, subtasks.length);
  }, [onSubtaskCountChange]);

  const jumpToSubtasks = useCallback(() => {
    const panel = panelRef.current;
    const section = subtasksSectionRef.current;
    const heading = subtasksHeadingRef.current;
    if (!panel || !section || !heading) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    panel.scrollTo({
      top: section.offsetTop,
      behavior: reduceMotion ? 'auto' : 'smooth',
    });
    heading.focus({ preventScroll: true });
  }, []);

  const jumpToRecurrence = useCallback(() => {
    const section = recurrenceSectionRef.current;
    const heading = recurrenceHeadingRef.current;
    if (!section || !heading) return;

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const scrollHost = mode === 'panel' ? panelRef.current : contentScrollRef.current;
    if (scrollHost && mode !== 'mobile') {
      scrollHost.scrollTo({
        top: Math.max(0, section.offsetTop - 16),
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    } else {
      section.scrollIntoView({
        block: 'center',
        behavior: reduceMotion ? 'auto' : 'smooth',
      });
    }
    heading.focus({ preventScroll: true });
    setRecurrenceFocused(true);
    if (recurrenceFocusTimeoutRef.current) clearTimeout(recurrenceFocusTimeoutRef.current);
    recurrenceFocusTimeoutRef.current = setTimeout(() => setRecurrenceFocused(false), 1400);
  }, [mode]);

  const handleSkipToCurrent = async () => {
    if (!skipToCurrentDate || skipToCurrentInFlightRef.current) return;
    skipToCurrentInFlightRef.current = true;
    setSkippingToCurrent(true);
    try {
      if (await handleDueDateChange(skipToCurrentDate)) {
        toast.success(`Due date moved to ${formatShortDate(skipToCurrentDate)}`);
      }
    } finally {
      skipToCurrentInFlightRef.current = false;
      setSkippingToCurrent(false);
    }
  };

  // Resize handler for panel mode
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const renderedWidth = panelRef.current?.getBoundingClientRect().width || panelWidth;
    resizeRef.current = { startX: e.clientX, startWidth: renderedWidth, currentWidth: renderedWidth };
    const handleMove = (ev: MouseEvent) => {
      if (!resizeRef.current) return;
      const delta = resizeRef.current.startX - ev.clientX;
      const newWidth = Math.max(minPanelWidth, Math.min(600, resizeRef.current.startWidth + delta));
      resizeRef.current.currentWidth = newWidth;
      setPanelWidth(newWidth);
    };
    const handleUp = () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      if (resizeRef.current) {
        localStorage.setItem('mission-control:detail-panel-width', String(resizeRef.current.currentWidth));
      }
      resizeRef.current = null;
    };
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
  }, [minPanelWidth, panelWidth]);

  const { handlePaste: handleImagePaste, pasteCount } = useImagePasteHandler(
    taskId,
    supportsAttachments,
  );

  // Content fade key — changes when loading a new task
  const contentKey = loading ? 'loading' : task?.id || 'empty';

  const panelContent = (
    <motion.div
      ref={contentScrollRef}
      data-task-detail-scroll
      key={contentKey}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.15, ease: 'easeOut' }}
      className={mode === 'dialog' || mode === 'workspace' ? 'overflow-y-auto flex-1 min-h-0' : ''}
    >
    {loading ? (
      <div className="relative flex h-32 items-center justify-center">
        <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
        {mode === 'mobile' && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 top-3 flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
            aria-label="Close task detail"
          >
            <X size={18} />
          </button>
        )}
      </div>
    ) : !task ? (
      <div className="flex items-center justify-between gap-3 p-4 text-sm text-[var(--text-muted)]">
        <span>Task not found</span>
        {mode === 'mobile' && (
          <button
            type="button"
            onClick={onClose}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-lg hover:bg-[var(--surface-2)]"
            aria-label="Close task detail"
          >
            <X size={18} />
          </button>
        )}
      </div>
    ) : (
      <div className={cn(
        'mx-auto w-full',
        mode === 'panel' && 'flex flex-col gap-4 p-5',
        mode === 'mobile' && 'flex flex-col gap-3 px-4 pb-28 [&_button]:min-h-11 [&_button]:min-w-11 [&_input]:min-h-11',
        mode === 'dialog' && 'grid max-w-4xl grid-cols-2 items-start gap-4 p-6',
        mode === 'workspace' && 'grid max-w-[1320px] grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(380px,1.35fr)] items-start gap-5 p-7',
      )}>
        <header className={cn(
          'border-b border-[var(--border-subtle)] bg-gradient-to-b from-[var(--surface-2)]/45 to-transparent',
          mode === 'panel' && '-mx-5 -mt-5 px-5 pb-4 pt-4',
          mode === 'mobile' && 'sticky top-0 z-20 -mx-4 bg-[var(--surface-1)]/95 px-4 pb-4 pt-6 backdrop-blur-xl',
          mode === 'dialog' && 'col-span-full row-start-1 -mx-6 -mt-6 px-6 pb-4 pt-5',
          mode === 'workspace' && 'col-span-full row-start-1 -mx-7 -mt-7 px-7 pb-4 pt-5',
        )}>
        {/* Header */}
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2 min-w-0">
            {iconSrc && <Image src={iconSrc} alt={task.connectorType} width={16} height={16} className="flex-shrink-0" />}
            <span className="text-xs text-[var(--text-muted)] uppercase tracking-wide truncate">
              {task.sourceListName || task.connectorType.replace(/-/g, ' ')}
            </span>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {onModeChange && mode !== 'mobile' && mode !== 'panel' && (
              <Tooltip content="Pin to side panel">
                <button
                  onClick={() => onModeChange?.('panel')}
                  className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                  aria-label="Pin to side panel"
                >
                  <Columns3 size={15} />
                </button>
              </Tooltip>
            )}
            {onModeChange && mode !== 'mobile' && (
              <Tooltip content={mode === 'workspace' ? 'Exit full workspace' : mode === 'dialog' ? 'Use full workspace' : 'Open popout'}>
                <button
                  onClick={() => onModeChange?.(mode === 'panel' ? 'dialog' : mode === 'dialog' ? 'workspace' : 'dialog')}
                  className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                  aria-label={mode === 'workspace' ? 'Exit full workspace' : mode === 'dialog' ? 'Use full workspace' : 'Open popout'}
                >
                  {mode === 'workspace' ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
                </button>
              </Tooltip>
            )}
            <button
              onClick={onClose}
              aria-label="Close task detail"
              className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Title */}
        {editingTitle && canEditTitle ? (
          <input
            ref={titleRef}
            value={titleValue}
            onChange={(e) => setTitleValue(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={(e) => { if (e.key === 'Enter') handleTitleBlur(); if (e.key === 'Escape') { setTitleValue(task.title); setEditingTitle(false); } }}
            className={cn('mt-4 w-full border-b border-[var(--accent)] bg-transparent pb-1 text-lg font-semibold text-[var(--text-primary)] outline-none', (mode === 'dialog' || mode === 'workspace') && 'text-xl')}
            autoFocus
          />
        ) : (
          <h2
            className={cn(
              'mt-4 text-balance text-lg font-semibold leading-snug text-[var(--text-primary)] [overflow-wrap:anywhere]',
              (mode === 'dialog' || mode === 'workspace') && 'text-xl',
            )}
          >
            {canEditTitle ? (
              <button
                type="button"
                onClick={() => { setEditingTitle(true); setTimeout(() => titleRef.current?.focus(), 0); }}
                className="w-full cursor-text text-left transition-colors duration-100 hover:text-[var(--accent)]"
              >
                {task.title}
              </button>
            ) : (
              <span title={blockedReason('title')}>{task.title}</span>
            )}
          </h2>
        )}

        <div className={cn(
          'mt-2 flex items-center justify-between gap-3 text-xs text-[var(--text-muted)]',
        )}>
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate">
              {hubProjects.find((project) => task.projectIds?.includes(project.id))?.name || task.sourceListName || 'No list'}
            </span>
            {(() => {
              const displayId = getTaskDisplayId(task.connectorType, task.metadata, task.sourceId);
              return displayId ? (
                <>
                  <span aria-hidden="true">•</span>
                  <span className="shrink-0 font-mono tabular-nums">{displayId}</span>
                </>
              ) : null;
            })()}
          </div>
          <span className="shrink-0">{formatTaskDetailUpdatedAt(task.updatedAt)}</span>
        </div>
        </header>

        {mode === 'panel' && task.subtasks && task.subtasks.length > 0 && (() => {
          const completedSubtasks = task.subtasks.filter((subtask) => subtask.status === 'done').length;
          return (
            <button
              type="button"
              onClick={jumpToSubtasks}
              aria-label={`Jump to subtasks, ${completedSubtasks} of ${task.subtasks.length} complete`}
              className="order-0 -mt-1 flex w-fit items-center gap-1.5 rounded-full border border-[var(--border-subtle)] bg-[var(--surface-0)]/55 px-2.5 py-1 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]"
            >
              <ListChecks size={12} aria-hidden="true" />
              Subtasks {completedSubtasks}/{task.subtasks.length}
            </button>
          );
        })()}

        {/* Mark Complete Button */}
        {mode !== 'mobile' && task.status !== 'done' && task.status !== 'cancelled' && (
          <button
            onClick={handleComplete}
            disabled={!canEditStatus}
            title={!canEditStatus ? blockedReason('status') : taskFieldSaveLabel(task.editPolicy, 'status')}
            className={cn(
              'flex min-h-[40px] w-full items-center justify-center gap-2 rounded-lg border border-[var(--success)]/20 bg-[var(--success)]/10 px-3 py-2 text-xs font-medium text-[var(--success)] transition-colors duration-150 hover:bg-[var(--success)]/20',
              mode === 'panel' && 'order-0',
              mode === 'dialog' && 'col-start-1 row-start-2',
              mode === 'workspace' && 'col-start-1 row-start-2',
            )}
          >
            <Circle size={14} className="text-[var(--success)]" />
            Mark Complete
          </button>
        )}

        <div className="contents">
        {/* Primary 2x2 field grid */}
        <div className={cn(
          'grid grid-cols-2 items-stretch gap-3',
          (mode === 'panel' || mode === 'mobile') && 'order-0',
          mode === 'dialog' && 'col-start-1 row-start-3',
          mode === 'workspace' && 'col-start-1 row-start-3',
        )}>
          {/* Status + Status Reason grouped */}
          <div className="relative flex min-h-28 flex-col gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
              {task.status === 'done' ? (
                <CheckCircle2 size={13} className="flex-shrink-0 text-[var(--success)]" />
              ) : (
                <Circle size={13} className={`flex-shrink-0 ${
                  task.status === 'in_progress' ? 'text-[var(--accent)]' :
                  task.status === 'cancelled' ? 'text-red-400' :
                  'text-[var(--text-muted)]'
                }`} />
              )}
              Status
            </span>
            <div className="flex items-center gap-2">
              <Select
                value={task.status}
                onValueChange={(status) => {
                  if (status === 'done') handleComplete();
                  else void handleStatusChange(status);
                }}
                disabled={!canEditStatus}
              >
                <SelectTrigger
                  aria-label="Task status"
                  title={!canEditStatus ? blockedReason('status') : taskFieldSaveLabel(task.editPolicy, 'status')}
                  variant="inline"
                  className={
                  task.status === 'done' ? 'text-[var(--success)]' :
                  task.status === 'in_progress' ? 'text-[var(--accent)]' :
                  task.status === 'cancelled' ? 'text-red-400' :
                  'text-[var(--text-muted)]'
                }>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todo" className="text-[var(--text-muted)]">To Do</SelectItem>
                  <SelectItem value="in_progress" className="text-purple-400">In Progress</SelectItem>
                  <SelectItem value="blocked" className="text-amber-400">Blocked</SelectItem>
                  <SelectItem value="done" className="text-green-400">Done</SelectItem>
                  <SelectItem value="cancelled" className="text-rose-400">Cancelled</SelectItem>
                  {task.connectorType === 'github-issues' && (
                    <>
                      <SelectItem value="cancelled:not_planned" className="text-rose-400">Close as Not Planned</SelectItem>
                      <SelectItem value="cancelled:duplicate" className="text-rose-400">Close as Duplicate</SelectItem>
                    </>
                  )}
                </SelectContent>
              </Select>

              {/* Status reason badge — shown when task is closed with a specific reason */}
              {(task.status === 'done' || task.status === 'cancelled') && task.statusReason && task.statusReason !== 'completed' && (
                <span className={`text-xs rounded px-1.5 py-0.5 font-medium ${
                  task.statusReason === 'not_planned'
                    ? 'bg-amber-500/10 text-amber-500 border border-amber-500/20'
                    : task.statusReason === 'moved'
                    ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                    : 'bg-purple-500/10 text-purple-400 border border-purple-500/20'
                }`}>
                  {task.statusReason === 'not_planned' ? <><Ban size={12} className="inline" /> Not Planned</> : task.statusReason === 'moved' ? <><ArrowLeftRight size={12} className="inline" /> Moved</> : <><Copy size={12} className="inline" /> Duplicate</>}
                </span>
              )}

            </div>

              {/* Status Reason (Micro-Status) */}
              {task.status !== 'done' && task.status !== 'cancelled' && (
                  <div className="mt-auto flex items-center gap-1.5">
                    <AlertCircle size={11} className={`flex-shrink-0 ${task.microStatus ? '' : 'text-[var(--text-muted)]'}`}
                      style={task.microStatus && MICRO_STATUS_CONFIG[task.microStatus as MicroStatus] ? { color: MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color } : undefined}
                    />
                    <button
                      onClick={() => setShowMicroStatusPicker(!showMicroStatusPicker)}
                      disabled={!canEditMicroStatus}
                      title={!canEditMicroStatus ? blockedReason('microStatus') : taskFieldSaveLabel(task.editPolicy, 'microStatus')}
                      className={`flex min-h-8 flex-1 items-center justify-between rounded-lg border border-[var(--border-subtle)] px-2 text-left text-xs transition-colors ${
                        task.microStatus
                          ? 'font-medium'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                      }`}
                      style={task.microStatus && MICRO_STATUS_CONFIG[task.microStatus as MicroStatus] ? {
                        backgroundColor: `${MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color}20`,
                        color: MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color,
                        border: `1px solid ${MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].color}30`,
                      } : undefined}
                    >
                      {task.microStatus && MICRO_STATUS_CONFIG[task.microStatus as MicroStatus]
                        ? `${MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].emoji} ${MICRO_STATUS_CONFIG[task.microStatus as MicroStatus].label}`
                        : 'Add reason'}
                      <ChevronDown size={11} />
                    </button>

                    {/* AI suggestion badge */}
                    {!task.microStatus && !microStatusSuggestion && (
                      <Tooltip content="Get AI suggestion">
                        <button
                          onClick={fetchMicroStatusSuggestion}
                          disabled={!canEditMicroStatus}
                          title={!canEditMicroStatus ? blockedReason('microStatus') : undefined}
                          className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors inline-flex items-center gap-0.5"
                        >
                          <Sparkles size={10} />
                        </button>
                      </Tooltip>
                    )}
                  </div>
              )}

            {/* AI suggestion & dropdown — below the status row */}
            {canEditMicroStatus && task.status !== 'done' && task.status !== 'cancelled' && (
              <>
                {microStatusSuggestion && MICRO_STATUS_CONFIG[microStatusSuggestion.status as MicroStatus] && (
                  <div className="ml-[25px] flex items-start gap-1.5 p-1.5 rounded-md bg-[var(--accent)]/10 border border-[var(--accent)]/20">
                   <Sparkles size={10} className="text-[var(--accent)] mt-0.5 flex-shrink-0" />
                   <div className="min-w-0">
                     <button
                       onClick={() => handleMicroStatusChange(microStatusSuggestion.status)}
                       className="text-xs text-[var(--accent)] hover:underline font-medium"
                     >
                       {MICRO_STATUS_CONFIG[microStatusSuggestion.status as MicroStatus].emoji} {MICRO_STATUS_CONFIG[microStatusSuggestion.status as MicroStatus].label}
                     </button>
                     <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-tight">{microStatusSuggestion.reason}</p>
                   </div>
                   <button
                     onClick={() => setMicroStatusSuggestion(null)}
                     className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] flex-shrink-0"
                   >
                     <X size={10} />
                   </button>
                  </div>
                )}

                {/* Micro-status picker dropdown */}
                <AnimatePresence>
                  {showMicroStatusPicker && (
                   <motion.div
                     className="absolute left-0 top-full mt-1 w-64 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl z-20"
                     initial={{ opacity: 0, y: -4, scale: 0.98 }}
                     animate={{ opacity: 1, y: 0, scale: 1 }}
                     exit={{ opacity: 0, y: -4, scale: 0.98 }}
                     transition={{ duration: 0.12 }}
                   >
                     <div className="px-3 pt-2.5 pb-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                       Why isn&apos;t this moving?
                     </div>
                     <div className="max-h-60 overflow-y-auto">
                       {/* Clear option */}
                       {task.microStatus && (
                         <button
                           onClick={() => handleMicroStatusChange(null)}
                           className="w-full flex items-center gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors text-xs text-[var(--text-muted)]"
                         >
                           <span className="w-4 text-center"><X size={12} /></span>
                           <span>Clear status reason</span>
                         </button>
                       )}
                       {(Object.entries(MICRO_STATUS_CONFIG) as [MicroStatus, typeof MICRO_STATUS_CONFIG[MicroStatus]][]).map(([key, config]) => (
                         <button
                           key={key}
                           onClick={() => handleMicroStatusChange(key)}
                           className={`w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-0)] transition-colors ${
                             task.microStatus === key ? 'bg-[var(--surface-0)]' : ''
                           }`}
                         >
                           <span className="text-sm flex-shrink-0 mt-px">{config.emoji}</span>
                           <div className="min-w-0 flex-1">
                             <span className="block text-xs font-medium" style={{ color: config.color }}>{config.label}</span>
                             <span className="block text-xs text-[var(--text-muted)] leading-tight">{config.description}</span>
                           </div>
                         </button>
                       ))}
                     </div>
                   </motion.div>
                  )}
                </AnimatePresence>
              </>
            )}
          {/* Close reason picker — shown when user is cancelling a GitHub task */}
          <AnimatePresence>
            {showCloseReasonPicker && canEditStatus && (
              <motion.div
                className="ml-[25px] rounded-xl border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden"
                initial={{ opacity: 0, y: -4, height: 0 }}
                animate={{ opacity: 1, y: 0, height: 'auto' }}
                exit={{ opacity: 0, y: -4, height: 0 }}
                transition={{ duration: 0.15 }}
              >
                <div className="px-3 pt-2.5 pb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  Close reason
                </div>
                <button
                  onClick={() => handleCloseWithReason('not_planned')}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-1)] transition-colors"
                >
                  <span className="text-sm flex-shrink-0"><Ban size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-amber-500">Not Planned</span>
                    <span className="block text-xs text-[var(--text-muted)] leading-tight">Won&apos;t be worked on — close without completing</span>
                  </div>
                </button>
                <button
                  onClick={() => handleCloseWithReason('duplicate')}
                  className="w-full flex items-start gap-2.5 px-3 py-2 text-left hover:bg-[var(--surface-1)] transition-colors"
                >
                  <span className="text-sm flex-shrink-0"><Copy size={14} /></span>
                  <div className="min-w-0 flex-1">
                    <span className="block text-xs font-medium text-purple-400">Duplicate</span>
                    <span className="block text-xs text-[var(--text-muted)] leading-tight">This is a duplicate of another issue</span>
                  </div>
                </button>
                <button
                  onClick={() => { setShowCloseReasonPicker(false); setPendingStatus(null); }}
                  className="w-full px-3 py-2 text-left text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-1)] transition-colors border-t border-[var(--border-subtle)]"
                >
                  Cancel
                </button>
              </motion.div>
            )}
          </AnimatePresence>
          </div>

          {/* Priority */}
            <div className="flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Flag size={13} />Priority</span>
              <Select value={task.priority || 'none'} onValueChange={(v) => handlePriorityChange(v)} disabled={!canEditPriority}>
                <SelectTrigger
                  aria-label="Task priority"
                  title={!canEditPriority ? blockedReason('priority') : taskFieldSaveLabel(task.editPolicy, 'priority')}
                  variant="inline"
                  className={PRIORITY_COLORS[task.priority] || PRIORITY_COLORS.none}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="critical" className="text-rose-400">Critical</SelectItem>
                  <SelectItem value="high" className="text-orange-400">High</SelectItem>
                  <SelectItem value="medium" className="text-amber-300">Medium</SelectItem>
                  <SelectItem value="low" className="text-sky-400">Low</SelectItem>
                  <SelectItem value="none" className="text-[var(--text-muted)]">None</SelectItem>
                </SelectContent>
              </Select>
            </div>

          {/* Due Date */}
          <div className="relative flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
            <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Calendar size={13} />Due date</span>
            {currentRecurrence !== 'none' && (
              <Tooltip content="View recurrence settings">
                <button
                  type="button"
                  onClick={jumpToRecurrence}
                  aria-label="View recurrence settings"
                  className="absolute right-2 top-2 flex min-h-7 min-w-7 items-center justify-center rounded-md bg-blue-500/10 text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60"
                >
                  <Repeat size={13} aria-hidden="true" />
                </button>
              </Tooltip>
            )}
            <div className="flex w-full items-center gap-1.5">
              <DatePicker
                value={taskDueDateOnly}
                onChange={canEditDueDate ? (date) => { void handleDueDateChange(date); } : () => {}}
                variant="inline"
                placeholder="Set due date"
                aria-label="Due date"
                disabled={!canEditDueDate}
                title={!canEditDueDate ? blockedReason('dueDate') : taskFieldSaveLabel(task.editPolicy, 'dueDate')}
                className={isOverdue ? 'text-rose-400' : undefined}
              />
              {isOverdue && (
                <span className="rounded-full bg-rose-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-rose-400">
                  Overdue
                </span>
              )}
            </div>
            <button
              onClick={() => { void handleToggleMyDay(); }}
              disabled={updatingMyDay}
              className={cn(
                'mt-auto flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2 text-left text-xs transition-colors',
                effectiveIsInMyDay ? 'bg-amber-500/10 text-amber-400' : 'text-[var(--text-muted)] hover:text-amber-400',
              )}
            >
              {updatingMyDay
                ? <Loader2 size={13} className="animate-spin" />
                : <Sun size={13} fill={effectiveIsInMyDay ? 'currentColor' : 'none'} />}
              {effectiveIsInMyDay ? 'On My Day' : 'Add to My Day'}
            </button>
          </div>

          {/* Effort with nested duration */}
            <div className="flex min-h-28 flex-col items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3">
              <span className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><Gauge size={13} />Effort</span>
                <div className="w-full" title={effortDurationBlockedReason}>
                  <EffortSelect effort={task.effort} onChange={handleEffortChange} disabled={!canEditEffortAndDuration} highlight={effortHighlight} />
                </div>
                <Select
                  value={task.estimatedDuration == null ? 'none' : String(task.estimatedDuration)}
                  onValueChange={(value) => handleDurationChange(value === 'none' ? null : Number(value))}
                  disabled={!canEditEffortAndDuration}
                >
                  <SelectTrigger
                    aria-label="Task duration"
                    title={effortDurationBlockedReason ?? taskFieldSaveLabel(task.editPolicy, 'estimatedDuration')}
                    variant="inline"
                    className={cn(
                      'mt-auto min-h-8 w-full justify-between rounded-lg border border-[var(--border-subtle)] px-2 text-xs',
                      durationHighlight && 'ring-2 ring-[var(--accent)]/40',
                    )}
                  >
                    <span className="flex items-center gap-1.5">
                      <Clock size={12} />
                      <SelectValue />
                    </span>
                  </SelectTrigger>
                  <SelectContent>
                    {DURATION_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.value === 'none' ? option.label : `Duration: ${option.label}`}
                      </SelectItem>
                    ))}
                    {task.estimatedDuration != null && !DURATION_OPTIONS.some((option) => option.value === String(task.estimatedDuration)) && (
                      <SelectItem value={String(task.estimatedDuration)}>Duration: {task.estimatedDuration} minutes</SelectItem>
                    )}
                  </SelectContent>
                </Select>
            </div>
          </div>
        </div>

        {/* Description / Notes with Markdown */}
        <section className={cn(
          'flex flex-col overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
          (mode === 'panel' || mode === 'mobile') && 'order-1',
          mode === 'dialog' && 'col-span-2 row-start-7 min-h-72 self-stretch',
          mode === 'workspace' && 'col-start-3 row-start-2 row-span-3 min-h-[520px] self-stretch',
        )}>
          <div className="mb-2 flex items-center gap-2">
            <FileText size={13} className="text-[var(--text-muted)]" />
            <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Notes</h3>
            <div className="ml-auto flex items-center gap-1">
              {!editingDesc && (
                <Tooltip content={canEditDescription ? 'Edit notes' : blockedReason('description')}>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDesc(true);
                      setTimeout(() => descRef.current?.focus(), 0);
                    }}
                    className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                    aria-label="Edit notes"
                    disabled={!canEditDescription}
                  >
                    <Pencil size={13} aria-hidden="true" />
                  </button>
                </Tooltip>
              )}
              <Tooltip content="Expand notes">
                <button
                  ref={notesExpandButtonRef}
                  type="button"
                  onClick={() => {
                    setExpandedNotesEditing(editingDesc);
                    setNotesExpanded(true);
                  }}
                  className="flex min-h-9 min-w-9 items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  aria-label="Expand notes"
                >
                  <Maximize2 size={14} aria-hidden="true" />
                </button>
              </Tooltip>
            </div>
          </div>
          {editingDesc && canEditDescription ? (
            <MarkdownEditor
              textareaRef={descRef}
              value={descValue}
              onValueChange={setDescValue}
              onEditorBlur={handleDescBlur}
              onEscape={() => {
                setDescValue(task.description || '');
                setEditingDesc(false);
              }}
              onPaste={handleImagePaste}
              containerClassName={cn(
                (mode === 'dialog' || mode === 'workspace') && 'flex min-h-0 flex-1 flex-col',
              )}
              toolbarClassName="mb-1.5 pb-1.5"
              className={cn(
                'w-full overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-3 font-mono text-xs text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]',
                (mode === 'dialog' || mode === 'workspace')
                  ? 'min-h-0 flex-1 resize-none'
                  : 'max-h-72 min-h-32 resize-y',
              )}
              placeholder={supportsAttachments ? "Add notes (supports Markdown, paste images)..." : "Add notes (supports Markdown)..."}
              aria-label="Edit notes"
              autoFocus
            />
          ) : (
            <div
              className={cn(
                `overflow-y-auto rounded-xl border border-[var(--border-subtle)] p-3 text-xs text-[var(--text-secondary)] ${canEditDescription ? 'cursor-text hover:bg-[var(--surface-0)]' : 'cursor-default'} transition-colors duration-100`,
                (mode === 'dialog' || mode === 'workspace')
                  ? 'min-h-0 flex-1'
                  : 'max-h-64 min-h-24',
              )}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('a, button, input')) return;
                if (canEditDescription) { setEditingDesc(true); setTimeout(() => descRef.current?.focus(), 0); }
              }}
            >
              {task.description ? (
                <div className="prose prose-invert prose-xs max-w-none [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0 [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs [&_code]:text-xs [&_pre]:text-xs [&_a]:text-blue-400 [&_a:hover]:underline [&_img]:rounded-md [&_img]:max-w-full [&_img]:h-auto [&_img]:my-2">
                  <LazyInteractiveMarkdown
                    onCheckboxToggle={canEditDescription ? handleCheckboxToggle : undefined}
                    sourceUrl={task.sourceUrl}
                  >
                    {task.description}
                  </LazyInteractiveMarkdown>
                </div>
              ) : (
                <span className="text-[var(--text-muted)] italic">
                  {canEditDescription ? 'Click to add notes...' : blockedReason('description')}
                </span>
              )}
            </div>
          )}
        </section>

          {/* Tags */}
        <section className={cn(
          'overflow-visible rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
          (mode === 'panel' || mode === 'mobile') && 'order-2',
          mode === 'dialog' && 'col-start-1 row-start-4',
          mode === 'workspace' && 'col-start-1 row-start-4',
        )}>
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2.5">
            <h3 className="flex items-center gap-2 text-xs font-semibold text-[var(--text-secondary)]"><Tag size={13} />Tags</h3>
            <Tooltip content="Suggested tags are not available yet">
            <button type="button" disabled className="flex min-h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-violet-300 opacity-60">
              <Sparkles size={12} />Suggest
            </button>
            </Tooltip>
          </div>
          <div className="p-3">
            <div className="min-w-0">
              <div className="flex flex-wrap gap-1">
                {taskTags.map((tag) => (
                  <span
                    key={tag.id}
                    className="group/tag inline-flex min-h-7 items-center gap-1 rounded-full bg-[var(--surface-2)] px-2.5 py-1 text-xs font-medium text-[var(--text-secondary)]"
                    style={tag.color ? {
                      backgroundColor: `${tag.color}30`,
                      color: `color-mix(in oklch, ${tag.color} 60%, white)`,
                    } : undefined}
                  >
                    {tag.name}
                    <button
                        onClick={() => handleRemoveTag(tag.id)}
                        disabled={!canEditTags}
                        className="ml-0.5 rounded-full opacity-60 transition-all hover:text-red-400 group-hover/tag:opacity-100 focus:opacity-100"
                        title={canEditTags ? `Remove tag "${tag.name}"` : blockedReason('tags')}
                        aria-label={`Remove tag ${tag.name}`}
                      >
                        <X size={10} />
                      </button>
                  </span>
                ))}
                <div className="relative" ref={tagPickerRef}>
                      <Tooltip content={canEditTags ? 'Add tag' : blockedReason('tags')}>
                        <button
                          onClick={() => showTagPicker ? setShowTagPicker(false) : openTagPicker()}
                          disabled={!canEditTags}
                          className="flex min-h-7 items-center gap-1 rounded-full border border-dashed border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)]"
                          aria-label="Add tag"
                        >
                          <Plus size={10} />
                          Add
                        </button>
                      </Tooltip>

                      <AnimatePresence>
                        {showTagPicker && (
                          <motion.div
                            className="absolute left-0 top-full mt-1 w-56 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-20 overflow-hidden"
                            initial={{ opacity: 0, y: -4, scale: 0.98 }}
                            animate={{ opacity: 1, y: 0, scale: 1 }}
                            exit={{ opacity: 0, y: -4, scale: 0.98 }}
                            transition={{ duration: 0.12 }}
                          >
                            {/* Search / input */}
                            <div className="px-2 pt-2 pb-1.5">
                              <div className="flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                                <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                                <input
                                  type="text"
                                  value={tagInput}
                                  onChange={(e) => setTagInput(e.target.value)}
                                  onKeyDown={(e) => {
                                      if (e.key === 'Enter' && tagInput.trim() && (!connectorCaps || connectorCaps.tagCreationMode === 'freeform')) {
                                      e.preventDefault();
                                      handleAddTag(tagInput.trim());
                                    }
                                    if (e.key === 'Escape') { setShowTagPicker(false); setTagInput(''); }
                                  }}
                                    placeholder={(!connectorCaps || connectorCaps.tagCreationMode === 'freeform') ? 'Search or create tag…' : 'Search labels…'}
                                  className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                                  autoFocus
                                />
                              </div>
                            </div>

                            {pickerLoading ? (
                              <div className="flex items-center justify-center py-4">
                                <Loader2 size={14} className="animate-spin text-[var(--text-muted)]" />
                              </div>
                            ) : (
                              <div className="max-h-52 overflow-y-auto py-1">
                                {/* Freeform: show "create" option when input doesn't match existing */}
                                {(!connectorCaps || connectorCaps.tagCreationMode === 'freeform') && tagInput.trim() && !pickerTags.some(t => t.name.toLowerCase() === tagInput.trim().toLowerCase()) && (
                                  <button
                                    onClick={() => handleAddTag(tagInput.trim())}
                                    className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--accent)] text-left hover:bg-[var(--surface-2)] transition-colors duration-75"
                                  >
                                    <Plus size={11} />
                                    Create &ldquo;{tagInput.trim()}&rdquo;
                                  </button>
                                )}

                                {(() => {
                                  const filtered = tagInput.trim()
                                    ? pickerTags.filter(t => t.name.toLowerCase().includes(tagInput.toLowerCase()) && !isSyntheticTag(t.name))
                                    : pickerTags.filter(t => !isSyntheticTag(t.name));
                                  const unapplied = filtered.filter(t => !task?.tagIds?.includes(t.id));
                                  if (unapplied.length === 0 && !((!connectorCaps || connectorCaps.tagCreationMode === 'freeform') && tagInput.trim())) {
                                    return <div className="px-3 py-2 text-xs text-[var(--text-muted)]">{tagInput.trim() ? 'No matching labels' : 'No labels available'}</div>;
                                  }
                                  return unapplied.map(tag => (
                                    <button
                                      key={tag.id}
                                      onClick={() => handleAddTag(tag.name)}
                                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] text-left hover:bg-[var(--surface-2)] transition-colors duration-75"
                                    >
                                      {tag.color && (
                                        <span
                                          className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                                          style={{ backgroundColor: tag.color }}
                                        />
                                      )}
                                      {tag.name}
                                    </button>
                                  ));
                                })()}
                              </div>
                            )}
                          </motion.div>
                        )}
                      </AnimatePresence>
                 </div>
              </div>
            </div>
          </div>
        </section>

          {/* Project */}
        <section className={cn(
          'overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
          (mode === 'panel' || mode === 'mobile') && 'order-3',
          mode === 'dialog' && 'col-start-2 row-start-2',
          mode === 'workspace' && 'col-start-2 row-start-2',
        )}>
          <div className="flex items-center justify-between border-b border-[var(--border-subtle)] px-3 py-2">
            <h3 className="text-xs font-semibold text-[var(--text-secondary)]">Projects &amp; phases</h3>
            <Select
              value=""
              onValueChange={handleAddProject}
              disabled={!canEditProjects || assignableProjects.every((project) => task.projectIds?.includes(project.id))}
            >
              <SelectTrigger
                aria-label="Add project"
                variant="inline"
                className="min-h-8"
                title={!canEditProjects
                  ? blockedReason('projects')
                  : assignableProjects.every((project) => task.projectIds?.includes(project.id))
                    ? 'All projects added'
                    : taskFieldSaveLabel(task.editPolicy, 'projects')}
              >
                <span className="flex items-center gap-1"><Plus size={11} />Add project</span>
              </SelectTrigger>
              <SelectContent>
                {assignableProjects.filter((project) => !task.projectIds?.includes(project.id)).map(p => (
                  <SelectItem key={p.id} value={p.id}>
                    <span className="inline-flex items-center gap-1.5">
                      <IconRenderer value={p.icon} size={14} color={p.color} fallback={<span>📁</span>} />
                      {p.name}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2 p-3">
            {(task.projectIds || []).length === 0 ? (
              <p className="text-xs italic text-[var(--text-muted)]">No projects</p>
            ) : task.projectIds.map((projectId) => {
              const project = hubProjects.find((candidate) => candidate.id === projectId);
              if (!project) return null;
              return (
                <div key={projectId} className="flex min-h-12 items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-2.5 py-1.5">
                  <IconRenderer value={project.icon} size={14} color={project.color} fallback={<FolderOpen size={14} />} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[var(--text-secondary)]">{project.name}</div>
                    <div className="truncate text-[10px] text-[var(--text-muted)]">
                      Phase: <strong className="font-medium text-[var(--text-secondary)]">
                        {projectHierarchies[projectId]
                          ? taskPhaseInProject(projectHierarchies[projectId], task.id)?.name ?? 'No phase'
                          : projectHierarchies[projectId] === null ? 'Unavailable' : 'Loading...'}
                      </strong>
                    </div>
                  </div>
                  {canEditProjects && canEditPhases && (
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <button
                          type="button"
                          disabled={updatingProjectPhaseIds.has(projectId)}
                          className="flex min-h-8 min-w-8 items-center justify-center rounded-md text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`Edit phase for ${project.name}`}
                        >
                          {updatingProjectPhaseIds.has(projectId)
                            ? <Loader2 size={12} className="animate-spin" />
                            : <ChevronDown size={12} />}
                        </button>
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content
                          align="end"
                          sideOffset={4}
                          className="z-[130] min-w-52 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-2xl"
                        >
                          <DropdownMenu.Label className="px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)]">
                            Assign phase
                          </DropdownMenu.Label>
                          {projectHierarchies[projectId] ? (() => {
                            const hierarchy = projectHierarchies[projectId]!;
                            const currentPhaseId = taskPhaseInProject(hierarchy, task.id)?.id ?? null;
                            return (
                              <DropdownMenu.RadioGroup
                                value={currentPhaseId ?? '__no_phase__'}
                                onValueChange={(value) => void handleProjectPhaseChange(
                                  projectId,
                                  value === '__no_phase__' ? null : value,
                                )}
                              >
                                <DropdownMenu.RadioItem
                                  value="__no_phase__"
                                  className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-[var(--text-secondary)] outline-none focus:bg-[var(--surface-2)]"
                                >
                                  <span className="w-3">
                                    <DropdownMenu.ItemIndicator><Check size={12} /></DropdownMenu.ItemIndicator>
                                  </span>
                                  No phase
                                </DropdownMenu.RadioItem>
                                {hierarchy.phases.map((phase) => (
                                  <DropdownMenu.RadioItem
                                    key={phase.id}
                                    value={phase.id}
                                    className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-[var(--text-secondary)] outline-none focus:bg-[var(--surface-2)]"
                                  >
                                    <span className="w-3">
                                      <DropdownMenu.ItemIndicator><Check size={12} /></DropdownMenu.ItemIndicator>
                                    </span>
                                    {phase.name}
                                  </DropdownMenu.RadioItem>
                                ))}
                              </DropdownMenu.RadioGroup>
                            );
                          })() : (
                            <DropdownMenu.Item
                              disabled
                              className="flex min-h-9 cursor-not-allowed items-center rounded-lg px-2 text-xs text-[var(--text-muted)] opacity-60"
                            >
                              Phases unavailable
                            </DropdownMenu.Item>
                          )}
                          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border-subtle)]" />
                          <DropdownMenu.Item
                            onSelect={() => void handleRemoveProject(projectId)}
                            className="flex min-h-9 cursor-default items-center gap-2 rounded-lg px-2 text-xs text-red-400 outline-none focus:bg-red-500/10"
                          >
                            <Trash2 size={12} />
                            Remove project
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        <section
          ref={recurrenceSectionRef}
          className={cn(
          'overflow-hidden rounded-xl border bg-[var(--surface-0)]/35 transition-[border-color,box-shadow] duration-200',
          recurrenceFocused
            ? 'border-blue-400/70 ring-4 ring-blue-500/10'
            : 'border-[var(--border-subtle)]',
          (mode === 'panel' || mode === 'mobile') && 'order-4',
          mode === 'dialog' && 'col-start-2 row-start-3',
          mode === 'workspace' && 'col-start-2 row-start-3',
        )}>
          <h3
            ref={recurrenceHeadingRef}
            tabIndex={-1}
            className="border-b border-[var(--border-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--text-secondary)] outline-none"
          >
            Planning
          </h3>
          <div className="space-y-3 p-3">
            <div className="flex items-center gap-3" title={!canEditReminder ? blockedReason('reminderAt') : taskFieldSaveLabel(task.editPolicy, 'reminderAt')}>
              <Bell size={13} className={`flex-shrink-0 ${task.reminderAt ? 'text-purple-400' : 'text-[var(--text-muted)]'}`} />
              <ReminderPicker
                value={task.reminderAt ?? null}
                onChange={canEditReminder ? handleReminderChange : () => {}}
                disabled={!canEditReminder}
              />
            </div>

            {(supportsRecurrence || currentRecurrence !== 'none') && (
              <div className={cn(
                'flex items-start gap-3 rounded-lg border p-2 transition-colors',
                currentRecurrence !== 'none'
                  ? 'border-blue-400/25 bg-blue-500/[0.06]'
                  : 'border-transparent',
              )}>
                <Repeat size={13} className={`mt-1 flex-shrink-0 ${currentRecurrence !== 'none' ? 'text-blue-400' : 'text-[var(--text-muted)]'}`} />
                <div className="flex-1 min-w-0 space-y-1.5">
                  {supportsRecurrence ? (
                    <div title={!canEditRecurrence ? blockedReason('recurrence') : taskFieldSaveLabel(task.editPolicy, 'recurrence')}>
                      <RecurrencePicker value={currentRecurrence} onChange={handleRecurrenceChange} variant="compact" disabled={!canEditRecurrence} />
                    </div>
                  ) : (
                    <span className="text-xs text-blue-400">{getRecurrenceDisplayLabel(currentRecurrence)}</span>
                  )}
                  {skipToCurrentDate && (
                    <button
                      type="button"
                      onClick={() => { void handleSkipToCurrent(); }}
                      disabled={skippingToCurrent || !canEditDueDate}
                      title={!canEditDueDate
                        ? blockedReason('dueDate')
                        : `Skip overdue occurrences and set due date to ${formatShortDate(skipToCurrentDate)}`}
                      aria-busy={skippingToCurrent}
                      className="flex min-h-8 w-full items-center gap-1.5 rounded-lg border border-blue-400/30 bg-blue-500/10 px-2 text-left text-xs font-medium text-blue-300 transition-colors hover:border-blue-400/50 hover:bg-blue-500/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:cursor-wait disabled:opacity-60"
                    >
                      <FastForward size={12} aria-hidden="true" />
                      Skip to current
                      <span className="ml-auto text-[10px] font-normal text-[var(--text-muted)]">
                        Next: {formatShortDate(skipToCurrentDate)}
                      </span>
                    </button>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <section ref={mode === 'panel' ? subtasksSectionRef : undefined} className={cn(
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
          (mode === 'panel' || mode === 'mobile') && 'order-5',
          mode === 'dialog' && 'col-start-1 row-start-5',
          mode === 'workspace' && 'col-start-1 row-start-5',
        )}>
          <div className="flex items-center gap-2 mb-2">
            <ListChecks size={13} className="text-[var(--text-muted)]" />
            <h3
              ref={mode === 'panel' ? subtasksHeadingRef : undefined}
              tabIndex={mode === 'panel' ? -1 : undefined}
              className={cn(
                'text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide',
                mode === 'panel' && 'rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-1)]',
              )}
            >
              Subtasks
              {task.subtasks && task.subtasks.length > 0 && ` (${task.subtasks.filter(s => s.status === 'done').length}/${task.subtasks.length})`}
            </h3>
          </div>
          <SubtaskSection
            key={task.id}
            taskId={task.id}
            subtasks={task.subtasks || []}
            onSubtasksChange={handleSubtasksChange}
            onUpdate={onUpdate}
            canEdit={canManageSubtasks}
            canCreateSubtasks={canManageSubtasks}
          />
        </section>

        {/* Relationships and cross-connector provenance */}
        <div className={cn(
          (mode === 'panel' || mode === 'mobile') && 'order-6',
          mode === 'dialog' && 'col-start-1 row-start-6',
          mode === 'workspace' && 'col-start-1 row-start-6',
        )} data-task-relationships-slot>
          <TaskRelationshipsSection
            key={`relationships-${task.id}`}
            taskId={task.id}
            canEdit={canEditDependencies}
            onUpdate={() => onUpdate?.()}
            touch={mode === 'mobile'}
          />
          <LinkedSourcesSection taskId={taskId} />
        </div>

        {/* Potential Duplicates Banner */}
        {potentialDuplicates.length > 0 && task.status !== 'done' && task.status !== 'cancelled' && (
          <section className={cn(
            'rounded-xl border border-purple-500/20 bg-purple-500/5 p-3',
            (mode === 'panel' || mode === 'mobile') && 'order-6',
            mode === 'dialog' && 'col-start-2 row-start-5',
            mode === 'workspace' && 'col-start-2 row-start-5',
          )}>
            <div className="flex items-center gap-1.5 mb-2">
              <span className="text-sm"><Copy size={14} /></span>
              <span className="text-xs font-semibold text-purple-400">
                {potentialDuplicates.length === 1 ? 'Potential duplicate detected' : `${potentialDuplicates.length} potential duplicates detected`}
              </span>
            </div>
            <div className="space-y-1.5">
              {potentialDuplicates.slice(0, 3).map((dupe) => (
                <div key={dupe.id} className="flex items-start gap-2">
                  <DuplicateTaskPreview candidate={dupe} />
                  {canEditStatus && (
                    <button
                      onClick={async () => {
                        const updates = { status: 'cancelled', statusReason: 'duplicate' };
                        await fetch(`/api/tasks/${taskId}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(updates),
                        });
                        setTask((prev) => prev ? { ...prev, status: 'cancelled', statusReason: 'duplicate' } : prev);
                        setPotentialDuplicates([]);
                        onUpdate?.({ status: 'cancelled', statusReason: 'duplicate' });
                      }}
                      className="flex-shrink-0 text-xs px-2 py-0.5 rounded border border-purple-500/30 bg-purple-500/10 text-purple-400 hover:bg-purple-500/20 transition-colors"
                    >
                      Close as dup
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              onClick={() => setPotentialDuplicates([])}
              className="mt-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
            >
              Dismiss
            </button>
          </section>
        )}

        {(dispositionOptions.length > 0 || Boolean(supportsMoveToList && onMoveToList) || writableConnectors.length > 0 || Boolean(task.sourceId && getDeepLinkInfo(task.connectorType, task.sourceId)) || (canDeleteTask && mode !== 'mobile')) && (
        <section className={cn(
          'overflow-visible rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35',
          (mode === 'panel' || mode === 'mobile') && 'order-7',
          mode === 'dialog' && 'col-start-2 row-start-4',
          mode === 'workspace' && 'col-start-2 row-start-4',
        )}>
          <h3 className="border-b border-[var(--border-subtle)] px-3 py-2.5 text-xs font-semibold text-[var(--text-secondary)]">Source &amp; actions</h3>
          <div className="flex flex-wrap items-center gap-2 p-3">
          {dispositionOptions.length > 0 && (
            <div className="w-full rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] p-2.5">
              <div className="mb-2 flex items-start gap-2">
                <Archive size={14} className="mt-0.5 shrink-0 text-emerald-400" aria-hidden="true" />
                <div>
                  <p className="text-xs font-medium text-emerald-300">Mission Control state</p>
                  <p className="text-[11px] text-[var(--text-muted)]">
                    Hide or restore this task locally. The upstream task is unchanged.
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                {dispositionOptions.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={updatingDisposition}
                    onClick={() => { void handleLocalDispositionChange(option.value); }}
                    title={option.detail}
                    aria-label={`${option.label}. ${option.detail}`}
                    className="min-h-9 rounded-lg border border-emerald-400/25 bg-emerald-500/10 px-2.5 text-xs font-medium text-emerald-300 transition-colors hover:bg-emerald-500/20 disabled:cursor-wait disabled:opacity-60"
                  >
                    {updatingDisposition ? <Loader2 size={12} className="mr-1 inline animate-spin" /> : null}
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* Move to list */}
          {supportsMoveToList && onMoveToList && (
            <MoveToListDropdown
              sourceLists={sameSourceLists}
              currentSourceListId={task?.sourceListId}
              onMoveToList={onMoveToList}
            />
          )}

          {/* Move to source (cross-source) — always available, even for read-only connectors */}
          {writableConnectors.length > 0 && (
            <div className="flex items-center">
                <button
                  onClick={() => setShowMoveDialog(true)}
                  className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
                >
                  <ArrowLeftRight size={13} />
                  Move source
                </button>
            </div>
          )}

          {/* Source link */}
          {(() => {
            const deepLink = task.sourceId ? getDeepLinkInfo(task.connectorType, task.sourceId) : null;
            if (!deepLink) return null;
            return (
              <div className="flex items-center">
                <Tooltip content={`Open in ${deepLink.label}`}>
                  <a
                    href={deepLink.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex min-h-9 items-center gap-1.5 rounded-lg bg-blue-500/10 px-2.5 text-xs font-medium text-blue-400 transition-colors hover:bg-blue-500/20 hover:text-blue-300"
                  >
                    <Image src={deepLink.icon} alt={deepLink.label} width={14} height={14} className="flex-shrink-0" />
                    Open in {deepLink.label}
                    <ExternalLink size={11} className="opacity-60" />
                  </a>
                </Tooltip>
              </div>
            );
          })()}
          {canDeleteTask && mode !== 'mobile' && (
            <button
              type="button"
              onClick={handleDelete}
              className="flex min-h-9 items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-2.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
            >
              <Trash2 size={13} />
              {taskRemovalLabel(task.editPolicy)}
            </button>
          )}
          </div>
        </section>
        )}

        {/* Document Preview — enhanced for document-intelligence, generic for others */}
        {parsedMetadata?.previewUrl && (
          <div className={cn(
            'border-t border-[var(--border-subtle)] pt-3',
            (mode === 'panel' || mode === 'mobile') && 'order-7',
            mode === 'dialog' && 'col-start-2 row-start-6',
            mode === 'workspace' && 'col-start-2 row-start-6',
          )}>
            <div className="flex items-center gap-2 mb-2">
              <FileText size={13} className="text-[var(--text-muted)]" />
              <span className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">Document</span>
            </div>

            {task.connectorType === 'document-intelligence' ? (
              <>
                {/* Document-oriented preview with metadata grid */}
                <div className="rounded-lg bg-[var(--surface-2)] border border-[var(--border)] overflow-hidden">
                  {/* Preview header with link */}
                  <a
                    href={parsedMetadata.previewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border-subtle)] hover:bg-[var(--surface-3)]/50 transition-colors duration-100 group/preview"
                  >
                    <div className="w-8 h-10 rounded bg-[var(--surface-3)] flex items-center justify-center flex-shrink-0">
                      <FileText size={14} className="text-[var(--text-muted)]" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-[var(--text-primary)] truncate">
                        {parsedMetadata.documentTitle || 'Document'}
                      </p>
                      <p className="text-[10px] text-[var(--accent)] group-hover/preview:underline">
                        {parsedMetadata.previewLabel || 'Open in Paperless'}
                      </p>
                    </div>
                    <ExternalLink size={12} className="text-[var(--accent)] flex-shrink-0" />
                  </a>

                  {/* Structured metadata grid */}
                  <div className="px-3 py-2 space-y-1.5">
                    {parsedMetadata.correspondent && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Correspondent</span>
                        <span className="text-xs text-[var(--text-secondary)] font-medium">{parsedMetadata.correspondent}</span>
                      </div>
                    )}
                    {typeof parsedMetadata.amount === 'number' && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Amount</span>
                        <span className="text-xs text-emerald-400 font-semibold tabular-nums">${parsedMetadata.amount.toFixed(2)}</span>
                      </div>
                    )}
                    {parsedMetadata.actionType && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Action</span>
                        <span className="text-xs text-[var(--text-secondary)] capitalize">{parsedMetadata.actionType}</span>
                      </div>
                    )}
                    {parsedMetadata.urgency && (
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Urgency</span>
                        <span className={cn(
                          'text-[10px] font-medium px-1.5 py-0.5 rounded border capitalize',
                          parsedMetadata.urgency === 'critical' ? 'text-rose-400 bg-rose-400/10 border-rose-400/30' :
                          parsedMetadata.urgency === 'high' ? 'text-orange-400 bg-orange-400/10 border-orange-400/30' :
                          parsedMetadata.urgency === 'medium' ? 'text-amber-300 bg-amber-300/10 border-amber-300/30' :
                          'text-sky-400 bg-sky-400/10 border-sky-400/30'
                        )}>
                          {parsedMetadata.urgency}
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Action buttons */}
                <div className="flex items-center gap-2 mt-2.5">
                  {parsedMetadata.previewUrl && (
                    <a
                      href={parsedMetadata.previewUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex-1 flex items-center justify-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-[var(--surface-3)] text-[var(--text-secondary)] border border-[var(--border)] hover:bg-[var(--surface-3)]/80 transition-colors duration-100"
                    >
                      <ExternalLink size={10} />
                      Open Doc
                    </a>
                  )}
                </div>

                {/* Open in OWL */}
                {parsedMetadata.docHubUrl && (
                  <a
                    href={parsedMetadata.docHubUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center justify-center gap-1.5 w-full mt-2 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-blue-500/10 text-blue-400 border border-blue-500/30 hover:bg-blue-500/20 transition-colors duration-100"
                  >
                    <ExternalLink size={10} />
                    Open in OWL
                  </a>
                )}
              </>
            ) : (
              <>
                {/* Generic preview for non-DI connectors */}
                <a
                  href={parsedMetadata.previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--accent)]/50 hover:bg-[var(--surface-2)]/80 transition-colors duration-150 group/preview"
                >
                  <ExternalLink size={14} className="text-[var(--accent)] flex-shrink-0" />
                  <span className="text-xs text-[var(--accent)] group-hover/preview:underline truncate">
                    {parsedMetadata.previewLabel || 'Open Document'}
                  </span>
                </a>
                {parsedMetadata.correspondent && (
                  <p className="text-xs text-[var(--text-muted)] mt-1.5">
                    {parsedMetadata.correspondent}
                    {typeof parsedMetadata.amount === 'number' && (
                      <span className="ml-2 font-medium text-[var(--text-secondary)]">
                        ${parsedMetadata.amount.toFixed(2)}
                      </span>
                    )}
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {/* Attachments */}
        <div className={cn(
          'rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)]/35 p-3',
          (mode === 'panel' || mode === 'mobile') && 'order-8',
          mode === 'dialog' && 'col-span-2 row-start-8',
          mode === 'workspace' && 'col-start-3 row-start-5',
        )}>
          <TaskAttachmentSection
            taskId={taskId}
            canEdit={canManageAttachments}
            supportsAttachments={supportsAttachments}
            connectorType={task.connectorType}
            sourceUrl={task.sourceUrl}
            refreshKey={pasteCount}
          />
        </div>

        {/* Footer meta */}
        <div className={cn(
          'space-y-1 border-t border-[var(--border-subtle)] pt-3',
          (mode === 'panel' || mode === 'mobile') && 'order-9',
          mode === 'dialog' && 'col-span-2 row-start-9',
          mode === 'workspace' && 'col-span-3 row-start-7',
        )}>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-muted)]">
          <p>
            Created {new Date(task.createdAt).toLocaleDateString()}
          </p>
          {task.updatedAt && (
            <p>
              Updated {new Date(task.updatedAt).toLocaleDateString()}
            </p>
          )}
          </div>
        </div>
        {mode === 'mobile' && (
          <div className="sticky bottom-0 z-10 -mx-4 mt-5 flex items-center gap-2 border-t border-[var(--border)] bg-[var(--surface-1)]/95 px-4 py-3 backdrop-blur">
            {task.status !== 'done' && task.status !== 'cancelled' && (
              <button
                type="button"
                onClick={handleComplete}
                disabled={!canEditStatus}
                title={!canEditStatus ? blockedReason('status') : taskFieldSaveLabel(task.editPolicy, 'status')}
                className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-[var(--success)]/15 px-4 text-sm font-semibold text-[var(--success)]"
              >
                <CheckCircle2 size={17} />
                Complete
              </button>
            )}
            <button
              type="button"
              onClick={() => { void handleToggleMyDay(); }}
              disabled={updatingMyDay}
              className={cn(
                'flex min-h-11 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium',
                effectiveIsInMyDay
                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-400'
                  : 'border-[var(--border)] text-[var(--text-secondary)]',
              )}
            >
              {updatingMyDay
                ? <Loader2 size={17} className="animate-spin" />
                : <Sun size={17} fill={effectiveIsInMyDay ? 'currentColor' : 'none'} />}
              My Day
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger asChild>
                <button
                  type="button"
                  disabled={!canDeleteTask}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-xl border border-[var(--border)] text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="More task actions"
                  title={canDeleteTask ? undefined : 'No additional actions available'}
                >
                  <MoreHorizontal size={18} />
                </button>
              </DropdownMenu.Trigger>
              {canDeleteTask && (
                <DropdownMenu.Portal>
                  <DropdownMenu.Content
                    align="end"
                    side="top"
                    sideOffset={6}
                    className="z-[130] min-w-48 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1 shadow-2xl"
                  >
                    <DropdownMenu.Item
                      onSelect={handleDelete}
                      className="flex min-h-11 cursor-default items-center gap-2 rounded-lg px-3 text-sm text-red-400 outline-none focus:bg-red-500/10"
                    >
                      <Trash2 size={16} />
                      {taskRemovalLabel(task.editPolicy)}
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              )}
            </DropdownMenu.Root>
          </div>
        )}
        {portalRoot && notesExpanded && createPortal(
          <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/65 p-4 backdrop-blur-sm" role="presentation">
            <section
              ref={notesDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="expanded-notes-title"
              tabIndex={-1}
              className="flex h-[min(820px,92vh)] w-[min(1120px,96vw)] flex-col overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
            >
              <header className="flex items-center gap-3 border-b border-[var(--border-subtle)] px-5 py-4">
                <FileText size={17} className="text-[var(--accent)]" />
                <div className="min-w-0 flex-1">
                  <h2 id="expanded-notes-title" className="truncate text-sm font-semibold text-[var(--text-primary)]">Notes</h2>
                  <p className="truncate text-xs text-[var(--text-muted)]">{task.title}</p>
                </div>
                <div className="flex rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-0)] p-1" role="group" aria-label="Notes view">
                  <button
                    type="button"
                    onClick={() => setExpandedNotesEditing(false)}
                    aria-pressed={!expandedNotesEditing}
                    className={cn('min-h-9 rounded-md px-3 text-xs font-medium', !expandedNotesEditing ? 'bg-[var(--surface-2)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}
                  >
                    Read
                  </button>
                  {canEditDescription && (
                    <button
                      type="button"
                      onClick={() => setExpandedNotesEditing(true)}
                      aria-pressed={expandedNotesEditing}
                      className={cn('min-h-9 rounded-md px-3 text-xs font-medium', expandedNotesEditing ? 'bg-[var(--surface-2)] text-[var(--text-primary)]' : 'text-[var(--text-muted)]')}
                    >
                      Edit
                    </button>
                  )}
                </div>
                <button
                  type="button"
                  onClick={closeExpandedNotes}
                  className="flex min-h-11 min-w-11 items-center justify-center rounded-lg text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]"
                  aria-label="Close expanded notes"
                >
                  <X size={18} />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-hidden p-5">
                {expandedNotesEditing ? (
                  <div className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_minmax(0,1fr)] gap-5 md:grid-cols-2 md:grid-rows-1">
                    <MarkdownEditor
                      textareaRef={expandedDescRef}
                      value={descValue}
                      onValueChange={setDescValue}
                      onPaste={handleImagePaste}
                      containerClassName="flex h-full min-h-0 flex-col"
                      toolbarClassName="mb-2 shrink-0 pb-2"
                      className="min-h-0 flex-1 resize-none overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--surface-0)] p-4 font-mono text-sm leading-relaxed text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
                      aria-label="Edit notes"
                      data-notes-autofocus
                      autoFocus
                    />
                    <div className="h-full overflow-y-auto rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-0)] p-5" aria-label="Notes preview">
                      <div className="prose prose-invert max-w-none">
                        <LazyInteractiveMarkdown sourceUrl={task.sourceUrl}>
                          {descValue || '*Nothing to preview yet.*'}
                        </LazyInteractiveMarkdown>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="prose prose-invert mx-auto h-full max-w-3xl overflow-y-auto pr-2">
                    <LazyInteractiveMarkdown
                      onCheckboxToggle={canEditDescription ? handleCheckboxToggle : undefined}
                      sourceUrl={task.sourceUrl}
                    >
                      {task.description || '*No notes yet.*'}
                    </LazyInteractiveMarkdown>
                  </div>
                )}
              </div>
              {expandedNotesEditing && (
                <footer className="flex items-center justify-end gap-2 border-t border-[var(--border-subtle)] px-5 py-3">
                  <button type="button" onClick={() => { setDescValue(task.description || ''); setExpandedNotesEditing(false); }} className="min-h-10 rounded-lg px-4 text-xs text-[var(--text-secondary)] hover:bg-[var(--surface-2)]">Cancel</button>
                  <button type="button" onClick={async () => { if (await handleDescBlur()) setExpandedNotesEditing(false); }} className="min-h-10 rounded-lg bg-[var(--accent)] px-4 text-xs font-semibold text-white hover:brightness-110">Save notes</button>
                </footer>
              )}
            </section>
          </div>,
          portalRoot,
        )}
      </div>
    )}
    </motion.div>
  );

  if (mode === 'mobile') {
    return (
      <>
        <div className="bg-[var(--surface-1)]">{panelContent}</div>
        <ConfirmDialog
          open={confirmDialog.open}
          title={confirmDialog.title}
          message={confirmDialog.message}
          confirmLabel={confirmDialog.confirmLabel}
          confirmVariant={confirmDialog.variant}
          onConfirm={confirmDialog.onConfirm}
          onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
        />
        {showMoveDialog && task && (
          <TaskMoveDialog
            taskId={task.id}
            taskTitle={task.title}
            sourceConnectorType={task.connectorType}
            writableConnectors={writableConnectors}
            onClose={() => { setShowMoveDialog(false); onMoveDialogDismissed?.(); }}
            onSuccess={(_newTaskId, action) => {
              toast.success(action === 'move' ? 'Task moved successfully' : 'Task copied successfully');
              onClose();
              onUpdate?.();
            }}
          />
        )}
      </>
    );
  }

  // Dialog and workspace modes render as modal overlays.
  if (mode === 'dialog' || mode === 'workspace') {
    const isWorkspace = mode === 'workspace';
    const dialog = (
      <>
      <AnimatePresence>
        <div className={cn('fixed inset-0 z-[90] flex justify-center', isWorkspace ? 'items-stretch p-4' : 'items-start pt-[6vh]')} role="presentation">
          <motion.div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={onClose}
            aria-hidden="true"
          />
          <motion.div
            ref={modalDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label={isWorkspace ? `Task workspace: ${task?.title ?? 'Task'}` : `Task details: ${task?.title ?? 'Task'}`}
            tabIndex={-1}
            className={cn(
              'relative flex flex-col overflow-hidden border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl',
              isWorkspace
                ? 'h-full w-full max-w-[1320px] rounded-2xl'
                : 'max-h-[88vh] w-[min(920px,94vw)] rounded-2xl',
            )}
            initial={{ opacity: 0, scale: 0.96, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
          >
            {panelContent}
          </motion.div>
        </div>
      </AnimatePresence>
      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
      {showMoveDialog && task && (() => {
        const moveDialog = <TaskMoveDialog
          taskId={task.id}
          taskTitle={task.title}
          sourceConnectorType={task.connectorType}
          writableConnectors={writableConnectors}
          onClose={() => { setShowMoveDialog(false); onMoveDialogDismissed?.(); }}
          onSuccess={(newTaskId, action) => {
            toast.success(action === 'move' ? 'Task moved successfully' : 'Task copied successfully');
            onClose();
            onUpdate?.();
          }}
        />;

        return portalDialog && portalRoot ? createPortal(moveDialog, portalRoot) : moveDialog;
      })()}
      </>
    );

    if (!portalDialog) return dialog;
    return portalRoot ? createPortal(dialog, portalRoot) : null;
  }

  // Panel mode: render as side panel with resize handle
  return (
    <>
    <motion.aside
      ref={panelRef}
      tabIndex={focusPanelOnMount ? -1 : undefined}
      className="bg-[var(--surface-1)] border-l border-[var(--border)] shadow-[-12px_0_30px_-24px_rgba(0,0,0,0.45)] flex-shrink-0 overflow-y-auto relative"
      style={{ width: panelWidth, maxWidth: 'min(calc(100vw - 4rem), 100%)' }}
      initial={animatePanel ? { opacity: 0, x: 16 } : false}
      animate={{ opacity: 1, x: 0 }}
      exit={animatePanel ? { opacity: 0, x: 12 } : undefined}
      transition={{ duration: 0.2, ease: [0.4, 0, 0.2, 1] }}
    >
      {/* Resize handle */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-[var(--accent)]/30 active:bg-[var(--accent)]/50 transition-colors z-10"
        onMouseDown={handleResizeStart}
      />
      {panelContent}
    </motion.aside>
    <ConfirmDialog
      open={confirmDialog.open}
      title={confirmDialog.title}
      message={confirmDialog.message}
      confirmLabel={confirmDialog.confirmLabel}
      confirmVariant={confirmDialog.variant}
      onConfirm={confirmDialog.onConfirm}
      onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
    />
    {showMoveDialog && task && (() => {
      const moveDialog = <TaskMoveDialog
        taskId={task.id}
        taskTitle={task.title}
        sourceConnectorType={task.connectorType}
        writableConnectors={writableConnectors}
        onClose={() => { setShowMoveDialog(false); onMoveDialogDismissed?.(); }}
        onSuccess={(newTaskId, action) => {
          toast.success(action === 'move' ? 'Task moved successfully' : 'Task copied successfully');
          onClose();
          onUpdate?.();
        }}
      />;

      return portalDialog && portalRoot ? createPortal(moveDialog, portalRoot) : moveDialog;
    })()}
    </>
  );
}