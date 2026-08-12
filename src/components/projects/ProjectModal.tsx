'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { motion } from 'motion/react';
import { Palette, Trash2, X, EyeOff, Plus, Tag, Type, List, Plug } from 'lucide-react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { IconPickerButton } from '@/components/ui/icon-picker';
import { modalContent, modalOverlay } from '@/lib/motion';
import { COLOR_PRESETS } from '@/lib/constants/colors';
import { DatePicker } from '@/components/ui/date-picker';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { projectLogger } from '@/lib/client-logger';
import { resolveProjectIconColor } from '@/lib/projects/normalize-project';
import type { AutoIncludeRule, HubProject } from '@/types';

const FIELD_CLASS_NAME = 'w-full bg-[var(--surface-0)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs text-[var(--text-primary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]/30';
const LABEL_CLASS_NAME = 'block text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1';

function isSyncManaged(project: HubProject | null | undefined): boolean {
  if (!project?.metadata) return false;
  return !!(project.metadata as Record<string, unknown>).syncManaged;
}

interface ProjectModalProps {
  onClose: () => void;
  onSaved: () => void;
  project?: HubProject | null;
}

export function ProjectModal({ onClose, onSaved, project }: ProjectModalProps) {
  const isEditMode = Boolean(project);
  const syncManaged = isSyncManaged(project);
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [color, setColor] = useState(project?.color ?? COLOR_PRESETS[0]);
  const [icon, setIcon] = useState(project?.icon ?? '');
  const [iconColor, setIconColor] = useState(
    resolveProjectIconColor(project?.iconColor, project?.color ?? COLOR_PRESETS[0]) ?? '',
  );
  const [category, setCategory] = useState(project?.category ?? '');
  const [targetDate, setTargetDate] = useState(project?.targetDate ? project.targetDate.slice(0, 10) : '');
  const [autoIncludeRules, setAutoIncludeRules] = useState<AutoIncludeRule[]>(
    (project?.autoIncludeRules as AutoIncludeRule[] | undefined) ?? []
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [confirmDialog, setConfirmDialog] = useState<{ open: boolean; title: string; message: string; confirmLabel: string; variant: 'danger' | 'warning'; onConfirm: () => void }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    nameRef.current?.select();
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!name.trim() || isSaving || isDeleting) return;

    setIsSaving(true);

    const payload = {
      name: name.trim(),
      description: description.trim() || null,
      color,
      icon: icon.trim() || null,
      iconColor: iconColor.trim() || null,
      category: category.trim() || null,
      targetDate: targetDate || null,
      sourceBindings: project?.sourceBindings ?? [],
      autoIncludeRules,
    };

    try {
      const response = await fetch(
        isEditMode ? `/api/hub-projects/${project?.id}` : '/api/hub-projects',
        {
          method: isEditMode ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      );

      if (!response.ok) {
        const error = await response.json().catch(() => null);
        throw new Error(error?.error || 'Failed to save project');
      }

      toast.success(isEditMode ? 'Project updated' : 'Project created');
      onClose();
      onSaved();
    } catch (error) {
      projectLogger.error('Failed to save project', { err: error });
      toast.error(error instanceof Error ? error.message : 'Failed to save project');
    } finally {
      setIsSaving(false);
    }
  }

  async function handleHide() {
    if (!project || isSaving || isDeleting) return;

    try {
      const response = await fetch(`/api/hub-projects/${project.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hidden: true }),
      });

      if (!response.ok) throw new Error('Failed to hide project');

      toast.success(`"${project.name}" hidden from sidebar`);
      onClose();
      onSaved();
    } catch (error) {
      projectLogger.error('Failed to hide project', { err: error });
      toast.error('Failed to hide project');
    }
  }

  async function handleDelete() {
    if (!project || isSaving || isDeleting) return;

    setConfirmDialog({
      open: true,
      title: syncManaged ? 'Delete synced project?' : 'Delete project?',
      message: syncManaged
        ? `"${project.name}" is synced from a GitHub Project. Deleting it will remove it from Mission Control, but it will be recreated on the next sync. To hide it instead, use the Hide button.`
        : `Delete "${project.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: async () => {
        setConfirmDialog((d) => ({ ...d, open: false }));
        setIsDeleting(true);

        try {
          const response = await fetch(`/api/hub-projects/${project.id}`, {
            method: 'DELETE',
          });

          if (!response.ok) {
            const error = await response.json().catch(() => null);
            throw new Error(error?.error || 'Failed to delete project');
          }

          toast.success('Project deleted');
          onClose();
          onSaved();
        } catch (error) {
          projectLogger.error('Failed to delete project', { err: error });
          toast.error(error instanceof Error ? error.message : 'Failed to delete project');
        } finally {
          setIsDeleting(false);
        }
      },
    });
  }

  return (
    <motion.div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-4 pt-[10vh] backdrop-blur-sm"
      onClick={onClose}
      variants={modalOverlay}
      initial="hidden"
      animate="show"
      exit="exit"
      role="dialog"
      aria-modal="true"
      aria-labelledby="project-modal-title"
    >
      <motion.div
        className="w-full max-w-[520px] rounded-2xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
        variants={modalContent}
        initial="hidden"
        animate="show"
        exit="exit"
      >
        <div className="flex items-center justify-between px-6 pt-5">
          <div>
            <h2 id="project-modal-title" className="text-base font-semibold text-[var(--text-primary)]">
              {isEditMode ? 'Edit Project' : 'Create Project'}
            </h2>
            <p className="mt-1 text-xs text-[var(--text-muted)]">
              {isEditMode ? 'Update project details and grouping.' : 'Add a new project to track.'}
            </p>
            {syncManaged && (
              <span className="mt-1.5 inline-flex items-center gap-1 rounded-full bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-400">
                ⟲ Synced from GitHub Project
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--text-tertiary)] transition-colors hover:bg-[var(--surface-0)] hover:text-[var(--text-primary)]"
            aria-label="Close project modal"
          >
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-6 py-5">
          <div className="space-y-4">
            <div>
              <label htmlFor="project-name" className={LABEL_CLASS_NAME}>Name</label>
              <input
                id="project-name"
                ref={nameRef}
                type="text"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Project name"
                className={FIELD_CLASS_NAME}
                required
              />
            </div>

            <div>
              <label htmlFor="project-description" className={LABEL_CLASS_NAME}>Description</label>
              <textarea
                id="project-description"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                placeholder="What is this project about?"
                className={`${FIELD_CLASS_NAME} min-h-[88px] resize-y`}
              />
            </div>

            <div>
              <label className={LABEL_CLASS_NAME}>
                <span className="inline-flex items-center gap-1">
                  <Palette size={11} />
                  Color
                </span>
              </label>
              <div className="flex flex-wrap gap-2">
                {COLOR_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => {
                      setColor(preset);
                      setIconColor(preset);
                    }}
                    className={`flex h-10 w-10 items-center justify-center rounded-full border transition-transform hover:scale-[1.03] ${
                      color === preset ? 'border-white/90' : 'border-white/20'
                    }`}
                    style={{
                      backgroundColor: preset,
                      boxShadow: color === preset ? `0 0 0 2px ${preset}55` : undefined,
                    }}
                    aria-label={`Select ${preset} color`}
                  >
                    {color === preset && <span className="h-2.5 w-2.5 rounded-full bg-white/90" />}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className={LABEL_CLASS_NAME}>Icon</label>
                <IconPickerButton
                  value={icon || null}
                  onChange={setIcon}
                  size="md"
                  color={iconColor || undefined}
                  onColorChange={setIconColor}
                />
              </div>
              <div>
                <label htmlFor="project-category" className={LABEL_CLASS_NAME}>Category</label>
                <input
                  id="project-category"
                  type="text"
                  value={category}
                  onChange={(event) => setCategory(event.target.value)}
                  placeholder="Platform"
                  className={FIELD_CLASS_NAME}
                />
              </div>
              <div>
                <label htmlFor="project-target-date" className={LABEL_CLASS_NAME}>Target Date</label>
                <DatePicker
                  value={targetDate || null}
                  onChange={(date) => setTargetDate(date)}
                  variant="input"
                  placeholder="Select target date"
                  aria-label="Project target date"
                />
              </div>
            </div>

            {/* Auto-Include Rules */}
            <div>
              <label className={LABEL_CLASS_NAME}>Auto-Include Rules</label>
              <p className="mb-2 text-[10px] text-[var(--text-tertiary)]">
                Automatically add tasks matching these rules to this project.
              </p>
              <div className="space-y-2">
                {autoIncludeRules.map((rule, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[var(--surface-0)] text-[var(--text-muted)]">
                      {rule.type === 'tag' && <Tag size={12} />}
                      {rule.type === 'title_contains' && <Type size={12} />}
                      {rule.type === 'source_list' && <List size={12} />}
                      {rule.type === 'connector' && <Plug size={12} />}
                    </div>
                    <Select
                      value={rule.type}
                      onValueChange={(value) => {
                        const updated = [...autoIncludeRules];
                        updated[index] = { ...rule, type: value as AutoIncludeRule['type'] };
                        setAutoIncludeRules(updated);
                      }}
                    >
                      <SelectTrigger
                        aria-label={`Rule ${index + 1} type`}
                        className="h-9 min-h-0 w-[140px] shrink-0 text-xs"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="tag">Label / Tag</SelectItem>
                        <SelectItem value="title_contains">Title contains</SelectItem>
                        <SelectItem value="source_list">Source list</SelectItem>
                        <SelectItem value="connector">Connector</SelectItem>
                      </SelectContent>
                    </Select>
                    <input
                      type="text"
                      value={rule.value}
                      onChange={(e) => {
                        const updated = [...autoIncludeRules];
                        updated[index] = { ...rule, value: e.target.value };
                        setAutoIncludeRules(updated);
                      }}
                      placeholder={
                        rule.type === 'tag' ? 'e.g. di-mc-integration' :
                        rule.type === 'title_contains' ? 'e.g. [Phase 0]' :
                        rule.type === 'source_list' ? 'e.g. octo-org/ideation' :
                        'Connector instance ID'
                      }
                      className={`${FIELD_CLASS_NAME} flex-1`}
                    />
                    <button
                      type="button"
                      onClick={() => setAutoIncludeRules(autoIncludeRules.filter((_, i) => i !== index))}
                      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] transition-colors hover:bg-red-500/10 hover:text-red-400"
                      aria-label="Remove rule"
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  onClick={() => setAutoIncludeRules([...autoIncludeRules, { type: 'tag', value: '' }])}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-dashed border-[var(--border)] px-3 py-1.5 text-[10px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--accent)] hover:text-[var(--accent)]"
                >
                  <Plus size={10} />
                  Add Rule
                </button>
              </div>
            </div>
          </div>

          <div className="mt-6 flex items-center justify-between gap-3">
            <div className="flex items-center gap-1">
              {isEditMode && !syncManaged && (
                <button
                  type="button"
                  onClick={handleDelete}
                  disabled={isDeleting || isSaving}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-red-400 transition-colors hover:text-red-300 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <Trash2 size={14} />
                  {isDeleting ? 'Deleting...' : 'Delete'}
                </button>
              )}
              {isEditMode && (
                <button
                  type="button"
                  onClick={handleHide}
                  disabled={isDeleting || isSaving}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs text-[var(--text-muted)] transition-colors hover:text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  <EyeOff size={14} />
                  Hide
                </button>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={onClose} className="px-4 py-2 text-xs text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition-colors">
                Cancel
              </button>
              <button
                type="submit"
                disabled={!name.trim() || isSaving || isDeleting}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? (isEditMode ? 'Saving...' : 'Creating...') : (isEditMode ? 'Save Changes' : 'Create')}
              </button>
            </div>
          </div>
        </form>
      </motion.div>

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((d) => ({ ...d, open: false }))}
      />
    </motion.div>
  );
}