'use client';

import React, { useEffect, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { toast } from 'sonner';
import {
  Plus, Trash2, Loader2, EyeOff, Eye, Pencil, X, Check, Globe,
} from 'lucide-react';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { settingsLogger } from '@/lib/client-logger';
import { IconPickerButton } from '@/components/ui/icon-picker';
import { IconRenderer } from '@/components/ui/icon-picker';

// ─── TYPES ──────────────────────────────────────────────────────────────────

interface ContentTypeDefinition {
  id: string;
  name: string;
  icon?: string;
  color: string;
  builtin: boolean;
  suppressed: boolean;
  priority: number;
  urlPatterns: string[];
  keywordHints: string[];
  description?: string;
}

// ─── EMPTY FORM STATE ───────────────────────────────────────────────────────

interface FormState {
  id: string;
  name: string;
  icon: string;
  color: string;
  priority: number;
  urlPatterns: string;
  keywordHints: string;
  description: string;
}

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  icon: 'lucide:globe',
  color: '#6b7280',
  priority: 50,
  urlPatterns: '',
  keywordHints: '',
  description: '',
};

// ─── COMPONENT ──────────────────────────────────────────────────────────────

export function ContentTypesSection() {
  const [types, setTypes] = useState<ContentTypeDefinition[]>([]);
  const [builtinIds, setBuiltinIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // Editor state
  const [editing, setEditing] = useState<string | null>(null); // id being edited, or '__new__'
  const [form, setForm] = useState<FormState>(EMPTY_FORM);

  // Delete confirm
  const [confirmDialog, setConfirmDialog] = useState<{
    open: boolean; title: string; message: string; confirmLabel: string;
    variant: 'danger' | 'warning'; onConfirm: () => void;
  }>({ open: false, title: '', message: '', confirmLabel: '', variant: 'danger', onConfirm: () => {} });

  // ─── FETCH ──────────────────────────────────────────────────────────────

  const fetchTypes = useCallback(async () => {
    try {
      const res = await fetch('/api/triage/content-types');
      const data = await res.json();
      setTypes(data.contentTypes || []);
      setBuiltinIds(data.builtinIds || []);
    } catch (err) {
      settingsLogger.error('Failed to load content types', { err });
      toast.error('Failed to load content types');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTypes(); }, [fetchTypes]);

  // ─── SUPPRESS / RESTORE ────────────────────────────────────────────────

  async function toggleSuppression(ct: ContentTypeDefinition) {
    const newSuppressed = !ct.suppressed;
    setTypes((prev) => prev.map((t) => t.id === ct.id ? { ...t, suppressed: newSuppressed } : t));
    try {
      const res = await fetch('/api/triage/content-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'suppress', id: ct.id, suppressed: newSuppressed }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTypes(data.contentTypes);
      toast.success(newSuppressed ? `"${ct.name}" hidden from detection` : `"${ct.name}" restored`);
    } catch {
      setTypes((prev) => prev.map((t) => t.id === ct.id ? { ...t, suppressed: ct.suppressed } : t));
      toast.error('Failed to update content type');
    }
  }

  // ─── DELETE ─────────────────────────────────────────────────────────────

  function confirmDelete(ct: ContentTypeDefinition) {
    setConfirmDialog({
      open: true,
      title: `Delete "${ct.name}"?`,
      message: 'This will permanently remove this custom content type. Existing triage items will keep their current type.',
      confirmLabel: 'Delete',
      variant: 'danger',
      onConfirm: () => doDelete(ct.id),
    });
  }

  async function doDelete(id: string) {
    setConfirmDialog((prev) => ({ ...prev, open: false }));
    try {
      const res = await fetch('/api/triage/content-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete', id }),
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      setTypes(data.contentTypes);
      if (editing === id) cancelEdit();
      toast.success('Content type deleted');
    } catch {
      toast.error('Failed to delete content type');
    }
  }

  // ─── EDITOR ─────────────────────────────────────────────────────────────

  function startCreate() {
    setEditing('__new__');
    setForm(EMPTY_FORM);
  }

  function startEdit(ct: ContentTypeDefinition) {
    setEditing(ct.id);
    setForm({
      id: ct.id,
      name: ct.name,
      icon: ct.icon || 'globe',
      color: ct.color,
      priority: ct.priority,
      urlPatterns: ct.urlPatterns.join('\n'),
      keywordHints: ct.keywordHints.join(', '),
      description: ct.description || '',
    });
  }

  function cancelEdit() {
    setEditing(null);
    setForm(EMPTY_FORM);
  }

  async function saveForm() {
    if (!form.name.trim()) {
      toast.error('Name is required');
      return;
    }

    // Validate regex patterns
    const patterns = form.urlPatterns.split('\n').map((s) => s.trim()).filter(Boolean);
    for (const pattern of patterns) {
      try { new RegExp(pattern); } catch {
        toast.error(`Invalid regex: "${pattern}"`);
        return;
      }
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        icon: form.icon,
        color: form.color,
        priority: form.priority,
        urlPatterns: patterns,
        keywordHints: form.keywordHints.split(',').map((s) => s.trim()).filter(Boolean),
        description: form.description.trim() || undefined,
      };
      if (editing !== '__new__') body.id = editing;

      const res = await fetch('/api/triage/content-types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Save failed');
      }
      const data = await res.json();
      setTypes(data.contentTypes);
      cancelEdit();
      toast.success(editing === '__new__' ? 'Content type created' : 'Content type updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to save');
    } finally {
      setSaving(false);
    }
  }

  // ─── RENDER ─────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 size={20} className="animate-spin text-[var(--text-muted)]" />
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-lg font-semibold text-[var(--text-primary)]">Content Types</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            URL patterns and keywords are used to auto-detect the type of incoming content.
          </p>
        </div>
        <button
          onClick={startCreate}
          disabled={editing === '__new__'}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
        >
          <Plus size={14} />
          Add Type
        </button>
      </div>

      {/* New type form */}
      <AnimatePresence>
        {editing === '__new__' && (
          <motion.div
            key="new-form"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden mb-4"
          >
            <ContentTypeForm
              form={form}
              onChange={setForm}
              onSave={saveForm}
              onCancel={cancelEdit}
              saving={saving}
              isNew
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Content type list */}
      <div className="space-y-2">
        {types.map((ct) => (
          <div key={ct.id}>
            {editing === ct.id ? (
              <ContentTypeForm
                form={form}
                onChange={setForm}
                onSave={saveForm}
                onCancel={cancelEdit}
                saving={saving}
              />
            ) : (
              <ContentTypeRow
                ct={ct}
                isBuiltin={builtinIds.includes(ct.id)}
                onEdit={() => startEdit(ct)}
                onToggleSuppression={() => toggleSuppression(ct)}
                onDelete={() => confirmDelete(ct)}
              />
            )}
          </div>
        ))}
      </div>

      {types.length === 0 && (
        <p className="text-xs text-[var(--text-muted)] text-center py-8">
          No content types defined. Click &quot;Add Type&quot; to create one.
        </p>
      )}

      <ConfirmDialog
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        confirmLabel={confirmDialog.confirmLabel}
        confirmVariant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
        onCancel={() => setConfirmDialog((prev) => ({ ...prev, open: false }))}
      />
    </div>
  );
}

// ─── ROW COMPONENT ────────────────────────────────────────────────────────────

function ContentTypeRow({
  ct,
  isBuiltin,
  onEdit,
  onToggleSuppression,
  onDelete,
}: {
  ct: ContentTypeDefinition;
  isBuiltin: boolean;
  onEdit: () => void;
  onToggleSuppression: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`flex items-center gap-3 px-4 py-3 rounded-[var(--radius-md)] border transition-colors ${
        ct.suppressed
          ? 'border-[var(--border)] bg-[var(--surface-1)] opacity-50'
          : 'border-[var(--border)] bg-[var(--surface-1)] hover:bg-[var(--surface-2)]'
      }`}
    >
      {/* Color swatch + icon */}
      <div
        className="flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] shrink-0"
        style={{ backgroundColor: `${ct.color}20` }}
      >
        <IconRenderer value={ct.icon || 'lucide:globe'} size={16} color={ct.color} fallback={<Globe size={16} style={{ color: ct.color }} />} />
      </div>

      {/* Name + meta */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-[var(--text-primary)] truncate">{ct.name}</span>
          {isBuiltin && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-[var(--surface-3)] text-[var(--text-muted)] font-medium uppercase tracking-wider">
              Built-in
            </span>
          )}
          {ct.suppressed && (
            <span className="text-xs px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-medium">
              Hidden
            </span>
          )}
        </div>
        {ct.description && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5 truncate">{ct.description}</p>
        )}
        <div className="flex items-center gap-3 mt-1">
          {ct.urlPatterns.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {ct.urlPatterns.length} URL pattern{ct.urlPatterns.length !== 1 ? 's' : ''}
            </span>
          )}
          {ct.keywordHints.length > 0 && (
            <span className="text-xs text-[var(--text-muted)]">
              {ct.keywordHints.length} keyword{ct.keywordHints.length !== 1 ? 's' : ''}
            </span>
          )}
          <span className="text-xs text-[var(--text-muted)]">
            Priority: {ct.priority}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center gap-1 shrink-0">
        <button
          onClick={onEdit}
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
          title="Edit"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onToggleSuppression}
          className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--surface-3)] transition-colors"
          title={ct.suppressed ? 'Restore' : 'Hide from detection'}
        >
          {ct.suppressed ? <Eye size={14} /> : <EyeOff size={14} />}
        </button>
        {!isBuiltin && (
          <button
            onClick={onDelete}
            className="p-1.5 rounded-[var(--radius-sm)] text-[var(--text-muted)] hover:text-red-400 hover:bg-red-500/10 transition-colors"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </div>
  );
}

// ─── FORM COMPONENT ───────────────────────────────────────────────────────────

function ContentTypeForm({
  form,
  onChange,
  onSave,
  onCancel,
  saving,
  isNew,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  isNew?: boolean;
}) {
  const set = (field: keyof FormState, value: string | number) =>
    onChange({ ...form, [field]: value });

  return (
    <div className="rounded-[var(--radius-md)] border border-blue-500/30 bg-[var(--surface-1)] p-4 space-y-3">
      <h3 className="text-xs font-semibold text-[var(--text-primary)] mb-2">
        {isNew ? 'New Content Type' : `Edit: ${form.name}`}
      </h3>

      {/* Row 1: Name + Icon + Color */}
      <div className="grid grid-cols-[1fr_auto_auto] gap-3">
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Name</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Tutorials"
            className="w-full text-sm px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Icon</label>
          <IconPickerButton
            value={form.icon || null}
            onChange={(v) => set('icon', v)}
            color={form.color}
            size="sm"
            placeholder={<Globe size={14} className="opacity-40" />}
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Color</label>
          <input
            type="color"
            value={form.color}
            onChange={(e) => set('color', e.target.value)}
            className="w-10 h-[34px] rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] cursor-pointer"
          />
        </div>
      </div>

      {/* Row 2: Description + Priority */}
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div>
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Description</label>
          <input
            type="text"
            value={form.description}
            onChange={(e) => set('description', e.target.value)}
            placeholder="Short description"
            className="w-full text-sm px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
          />
        </div>
        <div className="w-20">
          <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">Priority</label>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => set('priority', parseInt(e.target.value, 10) || 0)}
            min={1}
            max={999}
            className="w-full text-sm px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] focus:outline-none tabular-nums"
          />
        </div>
      </div>

      {/* Row 3: URL Patterns */}
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
          URL Patterns <span className="font-normal text-[var(--text-muted)]">(one regex per line)</span>
        </label>
        <textarea
          value={form.urlPatterns}
          onChange={(e) => set('urlPatterns', e.target.value)}
          placeholder={'e.g. youtube\\.com/watch\\nmysite\\.com/tutorials'}
          rows={3}
          className="w-full text-sm font-mono px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none resize-none"
        />
      </div>

      {/* Row 4: Keyword Hints */}
      <div>
        <label className="block text-xs font-medium text-[var(--text-muted)] mb-1">
          Keyword Hints <span className="font-normal text-[var(--text-muted)]">(comma-separated)</span>
        </label>
        <input
          type="text"
          value={form.keywordHints}
          onChange={(e) => set('keywordHints', e.target.value)}
          placeholder="e.g. tutorial, how-to, walkthrough"
          className="w-full text-sm px-2.5 py-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none"
        />
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
        >
          {saving ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} />}
          {isNew ? 'Create' : 'Save'}
        </button>
        <button
          onClick={onCancel}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-[var(--radius-sm)] text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
        >
          <X size={12} />
          Cancel
        </button>
      </div>

      {/* Help text */}
      <p className="text-xs text-[var(--text-muted)] leading-relaxed">
        Lower priority numbers are checked first during auto-detection. URL patterns are regex matched against the item&apos;s URL. Keywords are matched against the title, description, and URL.
      </p>
    </div>
  );
}
