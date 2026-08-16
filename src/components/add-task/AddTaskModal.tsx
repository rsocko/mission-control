'use client';

import { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, CheckSquare, Clock, FileText, Link2, Repeat, ChevronDown, Maximize2, Minimize2, ClipboardList, X } from 'lucide-react';
import Image from 'next/image';
import {
  Select,
  SelectTrigger,
  SelectContent,
  SelectItem,
  SelectValue,
} from '@/components/ui/select';
import { Tooltip } from '@/components/ui/Tooltip';
import { IconRenderer } from '@/components/ui/icon-picker/IconRenderer';
import { getTagPillStyle, CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';
import { modalOverlay, modalContent } from '@/lib/motion';
import { ParsedTask, getDateSuggestions } from '@/lib/parse-task-input';
import RecurrencePicker from '@/components/ui/RecurrencePicker';
import { taskLogger } from '@/lib/client-logger';
import { isSyntheticTag } from '@/lib/utils/synthetic-tags';
import { EFFORT_TO_DURATION, durationToEffort } from '@/lib/constants/task-formatting';
import { EffortSelect } from '@/components/EffortBadge';
import type { QuickAddDestination } from './quick-add-types';

interface Tag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
}

interface HubProject {
  id: string;
  name: string;
  color: string;
  icon: string | null;
}

interface SourceList {
  sourceId: string;
  name: string;
  groupId?: string | null;
  sortOrder?: number;
}

interface ListGroup {
  id: string;
  name: string;
  sortOrder: number;
}

interface TaskTemplate {
  id: string;
  name: string;
  description: string;
  category?: string;
  type?: string;
  icon?: string;
  subtasks: Array<{ title: string; priority?: string; estimatedMinutes?: number }>;
  workflowTasks?: Array<{ title: string; description?: string; priority?: string; subtasks?: string[] }>;
  isBuiltIn: boolean;
}

export interface TaskPrefill {
  title?: string;
  description?: string;
  tags?: string[];
  sourceUrl?: string;
  priority?: ParsedTask['priority'];
  dueDate?: string;
  projectId?: string;
}

interface AddTaskModalProps {
  initialInput: string;
  initialParsed: ParsedTask | null;
  initialDestination: QuickAddDestination;
  destinations: QuickAddDestination[];
  onClose: () => void;
  onSubmit: () => void;
  /** Pre-select a project by ID when opening from a project detail page */
  initialProjectId?: string;
  /** Let the caller attach the task after creation through its domain workflow. */
  deferProjectAssignment?: boolean;
  /** Pre-select a list by sourceId when opening with a list filter active */
  initialListId?: string;
  /** Called with the new task ID after successful creation */
  onTaskCreated?: (taskId: string) => void;
  /** Auto-apply a template by ID when the modal opens */
  initialTemplateId?: string;
  /** Pre-check the "Add to My Day" toggle */
  initialAddToMyDay?: boolean;
  /** Pre-fill fields when creating a task from triage or other contexts */
  prefill?: TaskPrefill;
  /** Durable provenance used to deduplicate task creation from a triage item */
  triageItemId?: string;
}

function formatDurationLabel(minutes: number): string {
  if (minutes >= 2400) return '1w';
  if (minutes >= 480) return `${Math.floor(minutes / 480)}d`;
  if (minutes < 60) return `${minutes}min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}min` : `${h}h`;
}

function ConnectorIconImg({ type, size = 14 }: { type: string; size?: number }) {
  const src = CONNECTOR_ICON_PATHS[type];
  if (src) {
    return <Image src={src} alt={type} width={size} height={size} className="flex-shrink-0" />;
  }
  return <ClipboardList size={size} className="flex-shrink-0 text-[var(--text-muted)]" />;
}

export function AddTaskModal({
  initialInput,
  initialParsed,
  initialDestination,
  destinations,
  onClose,
  onSubmit,
  initialProjectId,
  deferProjectAssignment = false,
  initialListId,
  onTaskCreated,
  initialTemplateId,
  initialAddToMyDay,
  prefill,
  triageItemId,
}: AddTaskModalProps) {
  const [title, setTitle] = useState(prefill?.title || initialParsed?.title || initialInput);
  const [description, setDescription] = useState(prefill?.description || '');
  const [dueDate, setDueDate] = useState(prefill?.dueDate || initialParsed?.dueDate || '');
  const [dueDateText, setDueDateText] = useState(initialParsed?.dueDateLabel || '');
  const [priority, setPriority] = useState(prefill?.priority || initialParsed?.priority || 'none');
  const [destination, setDestination] = useState(initialDestination);
  const [selectedTags, setSelectedTags] = useState<Tag[]>([]);
  const [prefillTagSlugs, setPrefillTagSlugs] = useState<string[]>(prefill?.tags || []);
  const [tagsLoading, setTagsLoading] = useState(true);
  const [availableTags, setAvailableTags] = useState<Tag[]>([]);
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string>(prefill?.projectId || initialProjectId || '');
  const [addToMyDay, setAddToMyDay] = useState(initialAddToMyDay ?? false);
  const [addAnother, setAddAnother] = useState(false);
  const [showDateSuggestions, setShowDateSuggestions] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [subtasks, setSubtasks] = useState<string[]>([]);
  const [subtaskInput, setSubtaskInput] = useState('');
  const [estimatedDuration, setEstimatedDuration] = useState<number | null>(initialParsed?.estimatedDuration || null);
  const [effort, setEffort] = useState<number | null>(initialParsed?.effort || null);
  const [customDurationInput, setCustomDurationInput] = useState('');
  const [recurrence, setRecurrence] = useState<string>(initialParsed?.recurrence || 'none');
  const [availableLists, setAvailableLists] = useState<SourceList[]>([]);
  const [listGroups, setListGroups] = useState<ListGroup[]>([]);
  const [selectedListId, setSelectedListId] = useState<string>(initialListId || initialDestination.listId || '');
  const [listSearchQuery, setListSearchQuery] = useState('');
  const [isListDropdownOpen, setIsListDropdownOpen] = useState(false);
  const [templates, setTemplates] = useState<TaskTemplate[]>([]);
  const [showTemplatePicker, setShowTemplatePicker] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [showTagDropdown, setShowTagDropdown] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  const tagInputRef = useRef<HTMLInputElement>(null);
  const listDropdownRef = useRef<HTMLDivElement>(null);
  const submitInFlightRef = useRef(false);

  // Load lists for the selected connector
  useEffect(() => {
    if (destination.connectorType === 'local') {
      setAvailableLists([]);
      setListGroups([]);
      setSelectedListId('');
      return;
    }

    // Find the connector id (use the base connector, not list-level destination)
    const connectorId = destination.id;
    fetch(`/api/connectors/${connectorId}/lists`)
      .then(r => r.ok ? r.json() : { sourceLists: [], groups: [] })
      .then(data => {
        const lists: SourceList[] = (data.sourceLists || data.lists || []).map((l: { sourceId: string; name: string; groupId?: string | null; sortOrder?: number }) => ({
          sourceId: l.sourceId,
          name: l.name,
          groupId: l.groupId || null,
          sortOrder: l.sortOrder ?? 0,
        }));
        const groups: ListGroup[] = (data.groups || []).map((g: { id: string; name: string; sortOrder: number }) => ({
          id: g.id,
          name: g.name,
          sortOrder: g.sortOrder,
        }));
        setAvailableLists(lists);
        setListGroups(groups);
        // Keep selected list if it's still in the new connector's lists
        if (selectedListId && !lists.find(l => l.sourceId === selectedListId)) {
          setSelectedListId('');
        }
      })
      .catch(() => { setAvailableLists([]); setListGroups([]); });
  }, [destination.id, destination.connectorType]);

  // Load tags and projects
  useEffect(() => {
    fetch('/api/tags').then(r => r.json()).then(data => {
      setAvailableTags(data.tags || []);
      // Auto-select tags from parsed input or prefill
      const tagSlugs = initialParsed?.tags.length ? initialParsed.tags : (prefill?.tags || []);
      if (tagSlugs.length) {
        const matching = (data.tags || []).filter((t: Tag) =>
          tagSlugs.some(pt => t.slug === pt || t.name.toLowerCase() === pt.toLowerCase())
        );
        setSelectedTags(matching);
        setPrefillTagSlugs(tagSlugs.filter(slug =>
          !matching.some((tag: Tag) => tag.slug === slug || tag.name.toLowerCase() === slug.toLowerCase())
        ));
      }
    }).catch((err) => { taskLogger.error('Failed to fetch hub tags', { err }); })
      .finally(() => setTagsLoading(false));

    fetch('/api/hub-projects').then(r => r.json()).then(data => {
      setProjects(data.projects || []);
      // Auto-select project from parsed input
      if (initialParsed?.project && data.projects) {
        const match = data.projects.find((p: HubProject) =>
          p.name.toLowerCase().includes(initialParsed.project!.toLowerCase())
        );
        if (match) setSelectedProjectId(match.id);
      }
    }).catch((err) => { taskLogger.error('Failed to fetch hub projects', { err }); });
  }, [initialParsed]);

  // Load templates
  useEffect(() => {
    fetch('/api/subtask-templates')
      .then(r => r.json())
      .then(data => {
        const loadedTemplates = data.templates || [];
        setTemplates(loadedTemplates);
        // Auto-apply template if initialTemplateId was provided
        if (initialTemplateId) {
          const match = loadedTemplates.find((t: TaskTemplate) => t.id === initialTemplateId);
          if (match) applyTemplate(match);
        }
      })
      .catch((err) => { taskLogger.error('Failed to fetch subtask templates', { err }); });
  }, []);

  const applyTemplate = (template: TaskTemplate) => {
    if (!title.trim()) {
      setTitle(template.name);
    }
    setSubtasks(template.subtasks.map(s => s.title));
    // Sum estimated durations from template subtasks
    const totalMinutes = template.subtasks.reduce((sum, s) => sum + (s.estimatedMinutes || 0), 0);
    if (totalMinutes > 0 && !estimatedDuration) {
      setEstimatedDuration(totalMinutes);
    }
    setShowTemplatePicker(false);
  };

  // Focus title on mount
  useEffect(() => {
    titleRef.current?.focus();
    titleRef.current?.select();
  }, []);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Whether the current connector requires an explicit list selection
  const listRequired = destination.listSelectionMode === 'required'
    && destination.connectorType !== 'local'
    && !selectedListId
    && !destination.listId;
  const waitingForPrefillTags = tagsLoading && prefillTagSlugs.length > 0;

  const handleSubmit = async () => {
    if (!title.trim() || submitInFlightRef.current || isSubmitting || listRequired || waitingForPrefillTags) return;
    submitInFlightRef.current = true;
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim() || undefined,
          dueDate: dueDate || undefined,
          priority,
          connectorType: destination.connectorType,
          connectorInstanceId: destination.connectorType === 'local'
            ? undefined
            : destination.id,
          sourceListId: selectedListId || destination.listId,
          sourceListName: (selectedListId ? availableLists.find(l => l.sourceId === selectedListId)?.name : destination.listName) || undefined,
          tags: selectedTags.map(t => t.id),
          tagSlugs: prefillTagSlugs,
          projectIds: selectedProjectId && !deferProjectAssignment ? [selectedProjectId] : [],
          subtasks: subtasks.length > 0 ? subtasks : undefined,
          estimatedDuration: estimatedDuration || undefined,
          effort: effort || undefined,
          recurrence: recurrence !== 'none' ? recurrence : undefined,
          triageItemId,
        }),
      });

      if (res.ok) {
        const { id: newTaskId } = await res.json();

        // Optionally add to My Day
        if (addToMyDay) {
          const { getLocalToday } = await import('@/lib/utils/client-date');
          await fetch('/api/my-day', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ taskId: newTaskId, date: getLocalToday() }),
          }).catch((err) => { taskLogger.error('Failed to add task to My Day', { err, taskId: newTaskId }); });
        }

        // Notify caller of the new task ID
        onTaskCreated?.(newTaskId);

        if (addAnother) {
          // Keep destination and selectedListId from the last task
          setTitle('');
          setDescription('');
          setDueDate('');
          setDueDateText('');
          setPriority('none');
          setSelectedTags([]);
          setPrefillTagSlugs([]);
          setSelectedProjectId('');
          setSubtasks([]);
          setSubtaskInput('');
          setEstimatedDuration(null);
          setEffort(null);
          setCustomDurationInput('');
          setRecurrence('none');
          setAddToMyDay(false);
          setTagSearchQuery('');
          setShowTagDropdown(false);
          titleRef.current?.focus();
        } else {
          onSubmit();
        }
      }
    } catch (err) {
      taskLogger.error('Failed to create task', { err });
    } finally {
      submitInFlightRef.current = false;
      setIsSubmitting(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      handleSubmit();
    }
  };

  function insertMarkdown(before: string, after: string) {
    const el = descRef.current;
    if (!el) return;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const selected = description.slice(start, end);
    const newText = description.slice(0, start) + before + selected + after + description.slice(end);
    setDescription(newText);
    // Restore cursor position after the inserted text
    setTimeout(() => {
      el.focus();
      const cursorPos = start + before.length + selected.length;
      el.setSelectionRange(cursorPos, cursorPos);
    }, 0);
  }

  const isGitHub = destination.connectorType === 'github-issues';
  const dateSuggestions = getDateSuggestions();

  return (
    <motion.div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-start justify-center pt-[10vh] z-50"
      onClick={onClose}
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-task-dialog-title"
    >
      <motion.div
        className={`bg-[var(--surface-1)] border border-[var(--border)] rounded-2xl shadow-2xl flex flex-col transition-[width] duration-200 ${
          isExpanded ? 'w-[900px]' : 'w-[600px]'
        } max-w-[95vw] max-h-[85vh]`}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        {/* Header */}
        <div className="px-6 pt-5 pb-0 flex items-center justify-between flex-shrink-0">
          <h2 id="add-task-dialog-title" className="text-base font-semibold text-[var(--text-primary)] flex items-center gap-2">
            Add Task
          </h2>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              aria-label={isExpanded ? 'Collapse dialog' : 'Expand dialog'}
              className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1 rounded-md hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              {isExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
            <button onClick={onClose} aria-label="Close dialog" className="text-[var(--text-muted)] hover:text-[var(--text-secondary)] p-1 rounded-md hover:bg-[var(--surface-2)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"><X size={14} /></button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="px-6 py-4 space-y-4 overflow-y-auto flex-1 min-h-0">
          {/* Template Quick-Select */}
          {templates.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowTemplatePicker(!showTemplatePicker)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-dashed border-[var(--border-strong)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:border-[var(--accent)] transition-colors"
              >
                <FileText size={12} />
                Use template
                <ChevronDown size={10} className={`transition-transform duration-150 ${showTemplatePicker ? 'rotate-180' : ''}`} />
              </button>
              <AnimatePresence>
                {showTemplatePicker && (
                  <motion.div
                    className="absolute left-0 top-full mt-1.5 w-80 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-10 overflow-hidden"
                    initial={{ opacity: 0, y: -4, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -4, scale: 0.98 }}
                    transition={{ duration: 0.12 }}
                  >
                    <div className="px-3 pt-2.5 pb-1.5 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                      Templates
                    </div>
                    <div className="max-h-52 overflow-y-auto">
                      {templates.map((tmpl) => (
                        <button
                          key={tmpl.id}
                          onClick={() => applyTemplate(tmpl)}
                          className="w-full flex items-start gap-2.5 px-3 py-2.5 text-left hover:bg-[var(--surface-0)] transition-colors"
                        >
                          <FileText size={14} className="text-[var(--text-muted)] mt-0.5 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <span className="block text-xs font-medium text-[var(--text-primary)] truncate">{tmpl.name}</span>
                            <span className="block text-xs text-[var(--text-muted)] truncate">{tmpl.description || `${tmpl.subtasks.length} steps`}</span>
                          </div>
                          <span className="text-xs text-[var(--text-muted)] tabular-nums flex-shrink-0">{tmpl.subtasks.length}↓</span>
                        </button>
                      ))}
                    </div>
                    <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
                      Templates pre-fill steps & estimated duration
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          {/* Title */}
          <input
            ref={titleRef}
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="What needs to be done?"
            aria-label="Task title"
            className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-4 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
          />

          {/* Subtasks / Steps */}
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1.5">
              Steps {subtasks.length > 0 && <span className="text-[var(--accent-400)] normal-case font-normal">({subtasks.length})</span>}
            </label>
            {subtasks.length > 0 && (
              <div className="space-y-1 mb-2">
                {subtasks.map((st, i) => (
                  <div key={i} className="flex items-center gap-2 group">
                    <span className="w-4 h-4 rounded border border-[var(--border-strong)] flex-shrink-0" />
                    <span className="text-xs text-[var(--text-secondary)] flex-1">{st}</span>
                    <button
                      onClick={() => setSubtasks(subtasks.filter((_, idx) => idx !== i))}
                      className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 text-[var(--text-muted)] hover:text-red-400 text-xs transition-opacity"
                    ><X size={10} /></button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={subtaskInput}
                onChange={(e) => setSubtaskInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && subtaskInput.trim()) {
                    e.preventDefault();
                    setSubtasks([...subtasks, subtaskInput.trim()]);
                    setSubtaskInput('');
                  }
                }}
                placeholder="Add a step and press Enter..."
                className="flex-1 bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]"
              />
              {subtaskInput.trim() && (
                <button
                  onClick={() => { setSubtasks([...subtasks, subtaskInput.trim()]); setSubtaskInput(''); }}
                  className="px-2 py-1 text-xs font-medium bg-[var(--accent)] text-white rounded-md hover:opacity-90"
                >+ Add</button>
              )}
            </div>
          </div>

          {/* Source / Destination */}
          <div>
            <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">Add to</div>
            <div className="flex gap-2 flex-wrap">
              {destinations.filter(d => !d.listId).map((dest) => (
                <button
                  key={dest.id}
                  onClick={() => { setDestination(dest); setSelectedListId(''); }}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    destination.id === dest.id && !destination.listId
                      ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--accent-400)]'
                      : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                  }`}
                >
                  <ConnectorIconImg type={dest.connectorType} size={14} />
                  {dest.label}
                  {dest.account === 'work' && (
                    <span className="text-xs px-1 py-0.5 rounded font-bold bg-blue-900/40 text-blue-400">
                      {dest.account}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* List picker — typeahead combobox with grouped lists */}
            {(availableLists.length > 0 || destination.listSelectionMode === 'required') && (
              <div className="mt-3 relative" ref={listDropdownRef}>
                <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                  {isGitHub ? 'Repository' : 'List'} {listRequired && <span className="text-amber-500 normal-case">*</span>}
                </label>
                {availableLists.length > 0 ? (<>
                <div className="relative">
                  <input
                    type="text"
                    value={isListDropdownOpen ? listSearchQuery : (availableLists.find(l => l.sourceId === selectedListId)?.name || (destination.listSelectionMode === 'required' ? (isGitHub ? 'Pick a repository…' : 'Pick a list…') : 'Default list'))}
                    onChange={(e) => { setListSearchQuery(e.target.value); if (!isListDropdownOpen) setIsListDropdownOpen(true); }}
                    onFocus={() => { setIsListDropdownOpen(true); setListSearchQuery(''); }}
                    onBlur={(e) => { if (!listDropdownRef.current?.contains(e.relatedTarget as Node)) { setIsListDropdownOpen(false); setListSearchQuery(''); } }}
                    placeholder="Search lists..."
                    className={`w-full bg-[var(--surface-0)] border rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] outline-none pr-7 ${listRequired ? 'border-amber-400' : 'border-[var(--border)]'}`}
                  />
                  <ChevronDown size={12} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)] pointer-events-none" />
                </div>
                {isListDropdownOpen && (() => {
                  const query = listSearchQuery.toLowerCase();
                  const filteredLists = query
                    ? availableLists.filter(l => l.name.toLowerCase().includes(query))
                    : availableLists;

                  // Group lists: groups in sortOrder, then ungrouped at the end
                  const groupedEntries: { groupName: string | null; lists: SourceList[] }[] = [];
                  const sortedGroups = [...listGroups].sort((a, b) => a.sortOrder - b.sortOrder);

                  for (const group of sortedGroups) {
                    const groupLists = filteredLists
                      .filter(l => l.groupId === group.id)
                      .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
                    if (groupLists.length > 0) {
                      groupedEntries.push({ groupName: group.name, lists: groupLists });
                    }
                  }
                  const ungrouped = filteredLists
                    .filter(l => !l.groupId)
                    .sort((a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0));
                  if (ungrouped.length > 0) {
                    groupedEntries.push({ groupName: null, lists: ungrouped });
                  }

                  return (
                    <div className="absolute z-50 mt-1 w-full max-h-52 overflow-y-auto bg-[var(--surface-0)] border border-[var(--border)] rounded-lg shadow-lg py-1">
                      {/* Default list option — hidden when list selection is required (e.g. GitHub repos) */}
                      {destination.listSelectionMode !== 'required' && (
                        <button
                          type="button"
                          onMouseDown={(e) => e.preventDefault()}
                          onClick={() => { setSelectedListId(''); setIsListDropdownOpen(false); setListSearchQuery(''); }}
                          className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-2)] ${selectedListId === '' ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'}`}
                        >
                          Default list
                        </button>
                      )}
                      {groupedEntries.map((entry, gi) => (
                        <div key={entry.groupName || `ungrouped-${gi}`}>
                          {entry.groupName && (
                            <div className="px-3 pt-2 pb-0.5 text-[12px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                              {entry.groupName}
                            </div>
                          )}
                          {entry.lists.map(l => (
                            <button
                              key={l.sourceId}
                              type="button"
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { setSelectedListId(l.sourceId); setIsListDropdownOpen(false); setListSearchQuery(''); }}
                              className={`w-full text-left px-3 py-1.5 text-xs hover:bg-[var(--surface-2)] ${entry.groupName ? 'pl-5' : ''} ${selectedListId === l.sourceId ? 'text-[var(--accent)] font-medium' : 'text-[var(--text-primary)]'}`}
                            >
                              {l.name}
                            </button>
                          ))}
                        </div>
                      ))}
                      {filteredLists.length === 0 && (
                        <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No lists found</div>
                      )}
                    </div>
                  );
                })()}
                </>) : (
                <div className="px-3 py-2 bg-[var(--surface-0)] border border-amber-400/40 rounded-lg text-xs text-[var(--text-muted)]">
                  {isGitHub
                    ? 'No repositories available — check this connector\u0027s settings to add repos.'
                    : 'No lists available — check this connector\u0027s settings to add repos or lists.'}
                </div>
                )}
              </div>
            )}

            {/* Warning when list is required but not selected */}
            {listRequired && (
              <p className="mt-1.5 text-[12px] text-amber-500">
                {isGitHub
                  ? 'Select a repository — GitHub issues must be filed against a specific repo.'
                  : 'This connector requires you to pick a specific list before creating a task.'}
              </p>
            )}

            {/* Source-specific feature hint */}
            {isGitHub && (
              <div className="mt-2 px-3 py-2 bg-[var(--warning)]/10 border border-[var(--warning)]/20 rounded-lg text-xs text-[var(--warning)] flex items-center gap-2">
                <strong>GitHub:</strong> Markdown supported in description • Labels • Milestones
              </div>
            )}
          </div>

          {/* Details grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* Due date */}
            <div className="relative">
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Due date</label>
              <input
                type="text"
                value={dueDateText || dueDate}
                onChange={(e) => {
                  setDueDateText(e.target.value);
                  // Try to parse as ISO date
                  if (/^\d{4}-\d{2}-\d{2}$/.test(e.target.value)) {
                    setDueDate(e.target.value);
                  }
                }}
                onFocus={() => setShowDateSuggestions(true)}
                onBlur={() => setTimeout(() => setShowDateSuggestions(false), 200)}
                placeholder="Tomorrow, next Friday, Jun 25..."
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] outline-none"
              />
              {showDateSuggestions && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-[var(--shadow-lg)] z-10 overflow-hidden">
                  {dateSuggestions.map((s) => (
                    <button
                      key={s.label}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setDueDate(s.value);
                        setDueDateText(s.label);
                        setShowDateSuggestions(false);
                      }}
                      className="w-full flex items-center justify-between px-3 py-2 text-xs hover:bg-[var(--surface-0)] text-left"
                    >
                      <span className="text-[var(--text-secondary)]">{s.label}</span>
                      <span className="text-[var(--text-muted)]">{s.computed}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Priority */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Priority</label>
              <Select value={priority} onValueChange={(v) => setPriority(v)}>
                <SelectTrigger className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">⚪ None</SelectItem>
                  <SelectItem value="low">🟡 Low</SelectItem>
                  <SelectItem value="medium">🟠 Medium</SelectItem>
                  <SelectItem value="high">🔴 High</SelectItem>
                  <SelectItem value="critical">🔥 Critical</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Effort & Duration — stacked */}
            <div className="space-y-3">
              {/* Effort — dropdown */}
              <div>
                <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Effort</label>
                <EffortSelect
                  effort={effort}
                  onChange={(newEffort) => {
                    setEffort(newEffort);
                    if (newEffort && !estimatedDuration && EFFORT_TO_DURATION[newEffort]) {
                      setEstimatedDuration(EFFORT_TO_DURATION[newEffort]);
                    }
                  }}
                />
              </div>

              {/* Estimated Duration */}
              <div>
                <label className="flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                  <Clock size={10} />
                  Duration
                  {estimatedDuration && (
                    <span className="normal-case font-normal text-[var(--accent-400)]">
                      ({formatDurationLabel(estimatedDuration)})
                    </span>
                  )}
                </label>
                <div className="flex gap-1 flex-wrap">
                  {[15, 30, 60, 120, 240, 480, 1440, 2400].map(d => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        const newDuration = estimatedDuration === d ? null : d;
                        setEstimatedDuration(newDuration);
                        if (newDuration && !effort) {
                          const suggested = durationToEffort(newDuration);
                          if (suggested) setEffort(suggested);
                        }
                      }}
                      className={`px-2 py-1.5 text-xs rounded-md border transition-colors ${
                        estimatedDuration === d
                          ? 'border-blue-400 bg-blue-900/30 text-blue-300 font-medium'
                          : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-tertiary)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      {d >= 2400 ? '1w' : d >= 480 ? `${Math.floor(d / 480)}d` : d >= 60 ? `${d / 60}h` : `${d}m`}
                    </button>
                  ))}
                  <input
                    type="number"
                    min="1"
                    max="4800"
                    value={customDurationInput}
                    onChange={(e) => {
                      setCustomDurationInput(e.target.value);
                      const val = parseInt(e.target.value, 10);
                      if (val > 0 && val <= 4800) {
                        setEstimatedDuration(val);
                        if (!effort) {
                          const suggested = durationToEffort(val);
                          if (suggested) setEffort(suggested);
                        }
                      }
                    }}
                    placeholder="min"
                    className={`w-14 rounded-md border px-2 py-1.5 text-xs tabular-nums outline-none transition-colors ${
                      estimatedDuration && ![15, 30, 60, 120, 240, 480, 1440, 2400].includes(estimatedDuration)
                        ? 'border-blue-400 bg-blue-900/30 text-blue-300'
                        : 'border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-tertiary)]'
                    } focus:border-[var(--accent)]`}
                  />
                  {estimatedDuration && (
                    <button
                      type="button"
                      onClick={() => {
                        setEstimatedDuration(null);
                        setCustomDurationInput('');
                      }}
                      className="px-2 py-1.5 text-xs rounded-md border border-[var(--border)] bg-[var(--surface-0)] text-[var(--text-tertiary)] hover:bg-red-900/20 hover:text-red-300 hover:border-red-400 transition-colors"
                    >
                      <X size={10} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {/* Recurrence */}
            <div>
              <label className="flex items-center gap-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
                <Repeat size={10} />
                Repeat
              </label>
              <RecurrencePicker value={recurrence} onChange={setRecurrence} variant="full" />
              {recurrence !== 'none' && ['ms-todo', 'outlook-calendar'].includes(destination.connectorType) && (
                <p className="text-xs text-[var(--text-muted)] mt-1">
                  Synced to {destination.connectorType === 'ms-todo' ? 'Microsoft To Do' : 'Outlook'}
                </p>
              )}
            </div>

            {/* Hub Project */}
            <div>
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Project</label>
              <Select value={selectedProjectId} onValueChange={(v) => setSelectedProjectId(v)}>
                <SelectTrigger className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">— None —</SelectItem>
                  {projects.map(p => (
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

            {/* Tags — type-ahead */}
            <div className="relative">
              <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">Tags</label>
              <input
                ref={tagInputRef}
                type="text"
                value={tagSearchQuery}
                onChange={(e) => {
                  setTagSearchQuery(e.target.value);
                  setShowTagDropdown(true);
                }}
                onFocus={() => setShowTagDropdown(true)}
                onBlur={() => setTimeout(() => setShowTagDropdown(false), 200)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && tagSearchQuery.trim()) {
                    e.preventDefault();
                    const filtered = availableTags.filter(t =>
                      !selectedTags.find(st => st.id === t.id) &&
                      !isSyntheticTag(t.name) &&
                      t.name.toLowerCase().includes(tagSearchQuery.toLowerCase())
                    );
                    if (filtered.length > 0) {
                      setSelectedTags([...selectedTags, filtered[0]]);
                      setTagSearchQuery('');
                      setShowTagDropdown(false);
                      // Keep focus on input for rapid tagging
                      setTimeout(() => tagInputRef.current?.focus(), 0);
                    }
                  }
                  if (e.key === 'Backspace' && !tagSearchQuery && selectedTags.length > 0) {
                    setSelectedTags(selectedTags.slice(0, -1));
                  }
                }}
                placeholder="Search tags..."
                className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] outline-none"
              />
              {showTagDropdown && (() => {
                const filtered = availableTags.filter(t =>
                  !selectedTags.find(st => st.id === t.id) &&
                  !isSyntheticTag(t.name) &&
                  (!tagSearchQuery || t.name.toLowerCase().includes(tagSearchQuery.toLowerCase()))
                );
                if (filtered.length === 0) return null;
                return (
                  <div className="absolute top-full left-0 right-0 mt-1 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-[var(--shadow-lg)] z-10 max-h-40 overflow-y-auto">
                    {filtered.map(t => (
                      <button
                        key={t.id}
                        type="button"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          setSelectedTags([...selectedTags, t]);
                          setTagSearchQuery('');
                          setShowTagDropdown(false);
                        }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left hover:bg-[var(--surface-0)] transition-colors"
                      >
                        <span
                          className="inline-block h-2 w-2 flex-shrink-0 rounded-full bg-[var(--text-muted)]"
                          style={t.color ? { backgroundColor: t.color } : undefined}
                        />
                        <span className="text-[var(--text-secondary)]">{t.name}</span>
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>
          </div>

          {/* Selected tags */}
          {selectedTags.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {selectedTags.map(tag => (
                <span
                  key={tag.id}
                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium"
                  style={getTagPillStyle(tag.color)}
                >
                  {tag.name}
                  <button
                    onClick={() => setSelectedTags(selectedTags.filter(t => t.id !== tag.id))}
                    className="opacity-60 hover:opacity-100"
                  ><X size={10} /></button>
                </span>
              ))}
            </div>
          )}

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
              Description {isGitHub && <span className="text-orange-500">(Markdown)</span>}
            </label>
            <div className="flex gap-0.5 p-1 bg-[var(--surface-0)] border border-[var(--border)] border-b-0 rounded-t-lg">
              <Tooltip content="Bold" shortcut="⌘B"><button type="button" onClick={() => insertMarkdown('**', '**')} className="px-2 py-0.5 text-xs font-bold text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded">B</button></Tooltip>
              <Tooltip content="Italic" shortcut="⌘I"><button type="button" onClick={() => insertMarkdown('_', '_')} className="px-2 py-0.5 text-xs italic text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded">I</button></Tooltip>
              <Tooltip content="Strikethrough"><button type="button" onClick={() => insertMarkdown('~~', '~~')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded line-through">S</button></Tooltip>
              <span className="w-px h-4 bg-[var(--border)] self-center mx-0.5" />
              <Tooltip content="Inline code"><button type="button" onClick={() => insertMarkdown('`', '`')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded font-mono">{"`"}</button></Tooltip>
              <Tooltip content="Link" shortcut="⌘K"><button type="button" onClick={() => insertMarkdown('[', '](url)')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded"><Link2 size={12} /></button></Tooltip>
              <span className="w-px h-4 bg-[var(--border)] self-center mx-0.5" />
              <Tooltip content="Bullet list"><button type="button" onClick={() => insertMarkdown('- ', '')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded">•</button></Tooltip>
              <Tooltip content="Checklist"><button type="button" onClick={() => insertMarkdown('- [ ] ', '')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded"><CheckSquare size={12} /></button></Tooltip>
              <Tooltip content="Heading"><button type="button" onClick={() => insertMarkdown('### ', '')} className="px-2 py-0.5 text-xs text-[var(--text-tertiary)] hover:bg-[var(--surface-2)] rounded font-bold">H</button></Tooltip>
            </div>
            <textarea
              ref={descRef}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={isGitHub ? 'Supports **markdown**, `code`, and - [ ] checklists' : 'Add notes (markdown supported)...'}
              className="w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-b-lg px-3 py-2 text-xs text-[var(--text-primary)] outline-none min-h-[72px] resize-y font-mono"
            />
          </div>

          {/* My Day toggle */}
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={addToMyDay}
              onChange={(e) => setAddToMyDay(e.target.checked)}
              className="w-4 h-4 accent-blue-600 rounded"
            />
            <span className="text-xs text-[var(--text-secondary)]">Add to My Day</span>
          </label>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 bg-[var(--surface-0)] border-t border-[var(--border)] rounded-b-2xl flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-[var(--text-tertiary)] cursor-pointer">
              <input
                type="checkbox"
                checked={addAnother}
                onChange={(e) => setAddAnother(e.target.checked)}
                className="accent-blue-600"
              />
              Add another
            </label>
            <span className="text-xs text-[var(--text-muted)]">⌘+Enter to save</span>
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-[var(--text-secondary)] hover:bg-gray-200 rounded-lg transition-colors">
              Cancel
            </button>
            <button
              onClick={handleSubmit}
              disabled={!title.trim() || isSubmitting || listRequired || waitingForPrefillTags}
              className="px-4 py-1.5 bg-blue-600 text-white text-xs font-semibold rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isSubmitting ? 'Adding...' : waitingForPrefillTags ? 'Loading tags...' : 'Add Task'}
            </button>
          </div>
        </div>
      </motion.div>
    </motion.div>
  );
}