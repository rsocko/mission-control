'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  FileText,
  Upload,
  Play,
  Eye,
  CheckCircle2,
  AlertTriangle,
  Loader2,
  ArrowRight,
  ExternalLink,
  ChartNetwork,
  Tag,
  Layers,
  ChevronDown,
  ChevronRight,
  Code,
  Pencil,
  RotateCcw,
  X,
  GitBranch,
  Plus,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { fadeSlideUp } from '@/lib/motion';
import { Modal } from '@/components/ui/Modal';

// ─── Types ──────────────────────────────────────────────────────────────────

interface ConnectedRepo {
  connectorId: string;
  connectorName: string;
  repo: string;
  displayName: string;
}

interface Finding {
  id: string;
  area: string;
  issue: string;
  impact: string;
  suggestedFix: string;
  effort: string;
  priorityOrder: number;
  priorityLabel: string;
  linkedIssueNumbers?: number[];
}

interface PhaseDefinition {
  name: string;
  description: string;
  estimatedDays: number | null;
  sortOrder: number;
  findingIds: string[];
}

interface PreviewData {
  document: {
    title: string | null;
    findings: Finding[];
    phases: PhaseDefinition[];
    priorityGroups: Array<{ order: number; title: string; label: string; findingIds: string[] }>;
  };
  proposedProjectName: string;
  proposedPhases: PhaseDefinition[];
  proposedIssueCount: number;
  proposedTags: string[];
}

interface CreatedIssue {
  findingId: string;
  title: string;
  issueNumber: number | null;
  htmlUrl: string | null;
}

interface CreatedPhase {
  name: string;
  id: string;
  findingIds: string[];
  sortOrder: number;
}

interface TaskAssignment {
  findingId: string;
  issueNumber: number | null;
  taskId: string | null;
  phaseName: string | null;
  status: string;
}

interface ExecuteResult {
  dryRun: boolean;
  projectId: string | null;
  appendedToExisting?: boolean;
  phases: CreatedPhase[];
  issues: CreatedIssue[];
  assignments: TaskAssignment[];
  tags: string[];
  errors: string[];
}

type Step = 'input' | 'preview' | 'executing' | 'done';

type InputMode = 'paste' | 'url' | 'file';

// ─── Props ──────────────────────────────────────────────────────────────────

export interface DocumentIntakeWizardProps {
  isOpen: boolean;
  onClose: () => void;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function DocumentIntakeWizard({ isOpen, onClose }: DocumentIntakeWizardProps) {
  const [step, setStep] = useState<Step>('input');
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [document, setDocument] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [repo, setRepo] = useState('');
  const [projectName, setProjectName] = useState('');
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expandedPhases, setExpandedPhases] = useState<Set<number>>(new Set());
  const [previewTab, setPreviewTab] = useState<'analysis' | 'source'>('analysis');
  const [sourceView, setSourceView] = useState<'rendered' | 'raw' | 'edit'>('rendered');
  const [editBuffer, setEditBuffer] = useState('');
  const [reprocessing, setReprocessing] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [editableTags, setEditableTags] = useState<string[]>([]);
  const [newTag, setNewTag] = useState('');

  // Abort controller to cancel in-flight fetches on reset/close
  const abortRef = useRef<AbortController | null>(null);

  // Existing project selection
  const [projectMode, setProjectMode] = useState<'new' | 'existing'>('new');
  const [existingProjects, setExistingProjects] = useState<Array<{ id: string; name: string; category?: string | null }>>([]);
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [projectSearch, setProjectSearch] = useState('');
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  // Category typeahead
  const [category, setCategory] = useState('');
  const [existingCategories, setExistingCategories] = useState<string[]>([]);
  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);

  // Connected GitHub repos
  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const repoDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetch('/api/connectors/github-repos')
      .then(res => res.json())
      .then(data => setConnectedRepos(data.repos ?? []))
      .catch(() => setConnectedRepos([]));

    fetch('/api/hub-projects')
      .then(res => res.json())
      .then(data => {
        const projects = data.projects ?? [];
        setExistingProjects(projects.map((p: { id: string; name: string; category?: string | null }) => ({
          id: p.id,
          name: p.name,
          category: p.category,
        })));
        const cats = projects
          .map((p: { category?: string | null }) => p.category)
          .filter((c: string | null | undefined): c is string => typeof c === 'string' && c.length > 0);
        setExistingCategories([...new Set<string>(cats)].sort());
      })
      .catch(() => { setExistingCategories([]); setExistingProjects([]); });
  }, [isOpen]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (repoDropdownRef.current && !repoDropdownRef.current.contains(e.target as Node)) {
        setRepoDropdownOpen(false);
      }
      if (categoryDropdownRef.current && !categoryDropdownRef.current.contains(e.target as Node)) {
        setCategoryDropdownOpen(false);
      }
      if (projectDropdownRef.current && !projectDropdownRef.current.contains(e.target as Node)) {
        setProjectDropdownOpen(false);
      }
    }
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const filteredRepos = useMemo(() => {
    if (!repoSearch.trim()) return connectedRepos;
    const q = repoSearch.toLowerCase();
    return connectedRepos.filter(
      r => r.repo.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q),
    );
  }, [connectedRepos, repoSearch]);

  const filteredCategories = useMemo(() => {
    if (!category.trim()) return existingCategories;
    const q = category.toLowerCase();
    return existingCategories.filter(c => c.toLowerCase().includes(q));
  }, [existingCategories, category]);

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return existingProjects;
    const q = projectSearch.toLowerCase();
    return existingProjects.filter(p => p.name.toLowerCase().includes(q));
  }, [existingProjects, projectSearch]);

  const selectedFindingCount = useMemo(() => {
    if (!preview) return 0;
    return preview.document.findings.filter(f => selectedFindingIds.has(f.id)).length;
  }, [preview, selectedFindingIds]);

  const skippedFindingCount = useMemo(() => {
    if (!preview) return 0;
    return preview.document.findings.length - selectedFindingCount;
  }, [preview, selectedFindingCount]);

  const handleFileUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setDocument(reader.result as string);
    };
    reader.readAsText(file);
  }, []);

  const handlePreview = useCallback(async () => {
    const hasContent = document.trim() || documentUrl.trim();
    if (!hasContent) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);

    try {
      const payload: Record<string, string | undefined> = {
        mode: 'preview',
        projectName: projectName || undefined,
      };
      if (document.trim()) {
        payload.document = document;
      } else if (documentUrl.trim()) {
        payload.documentUrl = documentUrl;
      }

      const res = await fetch('/api/ai/intake-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      setPreview(data.preview);
      setSelectedFindingIds(new Set((data.preview?.document?.findings ?? []).map((finding: Finding) => finding.id)));
      setEditableTags(data.preview?.proposedTags ?? []);
      setNewTag('');
      setStep('preview');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      setLoading(false);
    }
  }, [document, documentUrl, projectName]);

  const handleReprocess = useCallback(async () => {
    if (!editBuffer.trim()) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setReprocessing(true);
    setError(null);

    try {
      setDocument(editBuffer);
      const res = await fetch('/api/ai/intake-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: 'preview',
          document: editBuffer,
          projectName: projectName || undefined,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(data.error || `Request failed (${res.status})`);
      }

      const data = await res.json();
      setPreview(data.preview);
      setSelectedFindingIds(new Set((data.preview?.document?.findings ?? []).map((finding: Finding) => finding.id)));
      setEditableTags(data.preview?.proposedTags ?? []);
      setNewTag('');
      setSourceView('rendered');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Reprocess failed');
    } finally {
      setReprocessing(false);
    }
  }, [editBuffer, projectName]);

  const handleExecute = useCallback(async () => {
    const hasContent = document.trim() || documentUrl.trim();
    if (!hasContent || !repo.trim() || !preview) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const allFindingIds = preview.document.findings.map(f => f.id);
    const skipFindingIds = allFindingIds.filter(id => !selectedFindingIds.has(id));
    const tags = editableTags.map(tag => tag.trim()).filter(Boolean);
    setStep('executing');
    setError(null);

    try {
      const payload: Record<string, string | string[] | undefined> = {
        repo,
        mode: 'execute',
        projectName: projectMode === 'new' ? (projectName || undefined) : undefined,
        existingProjectId: projectMode === 'existing' ? (selectedProjectId || undefined) : undefined,
        category: category || undefined,
        skipFindingIds: skipFindingIds.length > 0 ? skipFindingIds : undefined,
        tags: tags.length > 0 ? tags : undefined,
      };
      if (document.trim()) {
        payload.document = document;
      } else if (documentUrl.trim()) {
        payload.documentUrl = documentUrl;
      }

      const res = await fetch('/api/ai/intake-document', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: 'Request failed' }));
        throw new Error(data.error || `Execution failed (${res.status})`);
      }

      const data = await res.json();
      setResult(data.result);
      setStep('done');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setError(err instanceof Error ? err.message : 'Execution failed');
      setStep('preview');
    }
  }, [document, documentUrl, repo, projectName, projectMode, selectedProjectId, category, preview, selectedFindingIds, editableTags]);

  const handleReset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep('input');
    setInputMode('paste');
    setDocument('');
    setDocumentUrl('');
    setRepo('');
    setRepoSearch('');
    setRepoDropdownOpen(false);
    setProjectName('');
    setProjectMode('new');
    setSelectedProjectId('');
    setProjectSearch('');
    setCategory('');
    setPreview(null);
    setResult(null);
    setError(null);
    setSelectedFindingIds(new Set());
    setEditableTags([]);
    setNewTag('');
  }, []);

  const handleClose = useCallback(() => {
    handleReset();
    onClose();
  }, [handleReset, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} size="2xl" title="Import Project from Document" closeOnBackdropClick={step === 'input'}>
      <div className="overflow-y-auto px-5 pb-5 max-h-[75vh]">
        {/* Step Indicator */}
        <div className="flex items-center gap-2 mb-6 text-sm">
          {(['input', 'preview', 'executing', 'done'] as Step[]).map((s, i) => (
            <div key={s} className="flex items-center gap-2">
              {i > 0 && <ArrowRight className="w-3 h-3 text-[var(--text-muted)]" />}
              <span className={`px-2 py-0.5 rounded ${step === s ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]' : 'text-[var(--text-muted)]'}`}>
                {s === 'input' ? '1. Input' : s === 'preview' ? '2. Preview' : s === 'executing' ? '3. Executing' : '4. Done'}
              </span>
            </div>
          ))}
        </div>

        <AnimatePresence mode="wait">
          {/* Step 1: Input */}
          {step === 'input' && (
            <motion.div key="input" variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-6">
              {/* Document Input */}
              <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
                <label className="block text-sm font-medium text-[var(--text-secondary)] mb-3">
                  Document Source
                </label>

                {/* Input Mode Tabs */}
                <div className="flex items-center gap-1 mb-4 bg-[var(--surface-1)] rounded-md p-1 w-fit">
                  {([
                    { key: 'paste' as InputMode, label: 'Paste Content' },
                    { key: 'url' as InputMode, label: 'From URL' },
                    { key: 'file' as InputMode, label: 'Upload File' },
                  ]).map(({ key, label }) => (
                    <button
                      key={key}
                      onClick={() => setInputMode(key)}
                      className={`px-3 py-1.5 text-xs rounded transition-colors ${
                        inputMode === key
                          ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Paste mode */}
                {inputMode === 'paste' && (
                  <>
                    <textarea
                      value={document}
                      onChange={e => setDocument(e.target.value)}
                      placeholder="Paste your audit findings markdown here..."
                      className="w-full h-48 bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-3 text-sm font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50 resize-y"
                    />
                    {document && (
                      <span className="text-xs text-[var(--text-muted)] mt-1 block">
                        {document.split('\n').length} lines
                      </span>
                    )}
                  </>
                )}

                {/* URL mode */}
                {inputMode === 'url' && (
                  <div className="space-y-2">
                    <input
                      type="url"
                      value={documentUrl}
                      onChange={e => setDocumentUrl(e.target.value)}
                      placeholder="https://raw.githubusercontent.com/owner/repo/main/docs/audit.md"
                      className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                    />
                    <p className="text-xs text-[var(--text-muted)]">
                      Supports public URLs and private GitHub URLs (uses configured GitHub connector for auth)
                    </p>
                  </div>
                )}

                {/* File upload mode */}
                {inputMode === 'file' && (
                  <div className="space-y-2">
                    <label className="cursor-pointer flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors border border-dashed border-[var(--border)] rounded-md p-6 justify-center">
                      <Upload className="w-5 h-5" />
                      {document ? `Loaded (${document.split('\n').length} lines)` : 'Click to upload .md file'}
                      <input type="file" accept=".md,.markdown,.txt" onChange={handleFileUpload} className="hidden" />
                    </label>
                  </div>
                )}
              </div>

              {/* Config */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                    Target GitHub Repo
                  </label>
                  <div className="relative" ref={repoDropdownRef}>
                    <button
                      type="button"
                      onClick={() => setRepoDropdownOpen(!repoDropdownOpen)}
                      className="w-full flex items-center justify-between bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-left transition-colors focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50 hover:border-[var(--accent-500)]/30"
                    >
                      {repo ? (
                        <span className="flex items-center gap-2 text-[var(--text-primary)]">
                          <GitBranch className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                          {repo}
                        </span>
                      ) : (
                        <span className="text-[var(--text-muted)]">Select a connected repo…</span>
                      )}
                      <ChevronDown className={`w-4 h-4 text-[var(--text-muted)] transition-transform ${repoDropdownOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {repoDropdownOpen && (
                      <div className="absolute z-50 mt-1 w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-xl max-h-60 overflow-hidden">
                        {connectedRepos.length > 3 && (
                          <div className="p-2 border-b border-[var(--border)]">
                            <input
                              type="text"
                              value={repoSearch}
                              onChange={e => setRepoSearch(e.target.value)}
                              placeholder="Search repos…"
                              autoFocus
                              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none"
                            />
                          </div>
                        )}
                        <div className="overflow-y-auto max-h-48">
                          {filteredRepos.length === 0 ? (
                            <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">
                              {connectedRepos.length === 0
                                ? 'No GitHub connectors configured. Add one in Settings → Connectors.'
                                : 'No matching repos found.'}
                            </div>
                          ) : (
                            filteredRepos.map(r => (
                              <button
                                key={`${r.connectorId}:${r.repo}`}
                                type="button"
                                onClick={() => {
                                  setRepo(r.repo);
                                  setRepoDropdownOpen(false);
                                  setRepoSearch('');
                                }}
                                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-2)] transition-colors flex items-center gap-2 ${
                                  repo === r.repo ? 'bg-[var(--surface-2)] text-[var(--accent-400)]' : 'text-[var(--text-secondary)]'
                                }`}
                              >
                                <GitBranch className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                                <span className="truncate">{r.repo}</span>
                                {connectedRepos.filter(cr => cr.connectorId !== r.connectorId).length > 0 && (
                                  <span className="ml-auto text-xs text-[var(--text-muted)] truncate">{r.connectorName}</span>
                                )}
                              </button>
                            ))
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
                <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
                  <div className="flex items-center gap-3 mb-3">
                    <label className="block text-sm font-medium text-[var(--text-secondary)]">
                      Project
                    </label>
                    <div className="flex rounded-md border border-[var(--border)] overflow-hidden text-xs">
                      <button
                        type="button"
                        onClick={() => setProjectMode('new')}
                        className={`px-2.5 py-1 transition-colors ${projectMode === 'new' ? 'bg-[var(--accent-500)] text-white' : 'bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'}`}
                      >
                        <Plus className="w-3 h-3 inline mr-1" />New
                      </button>
                      <button
                        type="button"
                        onClick={() => setProjectMode('existing')}
                        className={`px-2.5 py-1 transition-colors ${projectMode === 'existing' ? 'bg-[var(--accent-500)] text-white' : 'bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'}`}
                      >
                        <Layers className="w-3 h-3 inline mr-1" />Existing
                      </button>
                    </div>
                  </div>
                  {projectMode === 'new' ? (
                    <input
                      type="text"
                      value={projectName}
                      onChange={e => setProjectName(e.target.value)}
                      placeholder="Auto-generated from doc title"
                      className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                    />
                  ) : (
                    <div className="relative" ref={projectDropdownRef}>
                      <input
                        type="text"
                        value={projectSearch}
                        onChange={e => { setProjectSearch(e.target.value); setSelectedProjectId(''); setProjectDropdownOpen(true); }}
                        onFocus={() => setProjectDropdownOpen(true)}
                        placeholder="Search existing projects…"
                        className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                      />
                      {selectedProjectId && (
                        <button
                          onClick={() => { setSelectedProjectId(''); setProjectSearch(''); }}
                          className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {projectDropdownOpen && filteredProjects.length > 0 && (
                        <div className="absolute z-20 mt-1 w-full max-h-40 overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg">
                          {filteredProjects.map(p => (
                            <button
                              key={p.id}
                              type="button"
                              onClick={() => { setSelectedProjectId(p.id); setProjectSearch(p.name); setProjectDropdownOpen(false); }}
                              className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-3)] transition-colors flex items-center justify-between ${selectedProjectId === p.id ? 'bg-[var(--accent-500)]/10 text-[var(--accent-500)]' : 'text-[var(--text-primary)]'}`}
                            >
                              <span className="truncate">{p.name}</span>
                              {p.category && <span className="ml-2 text-xs text-[var(--text-muted)] truncate">{p.category}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                      {projectDropdownOpen && filteredProjects.length === 0 && projectSearch.trim() && (
                        <div className="absolute z-20 mt-1 w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg px-3 py-2 text-sm text-[var(--text-muted)]">
                          No projects found
                        </div>
                      )}
                    </div>
                  )}
                </div>
                <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
                  <label className="block text-sm font-medium text-[var(--text-secondary)] mb-2">
                    Category <span className="text-[var(--text-muted)]">(optional)</span>
                  </label>
                  <div className="relative" ref={categoryDropdownRef}>
                    <input
                      type="text"
                      value={category}
                      onChange={e => {
                        setCategory(e.target.value);
                        setCategoryDropdownOpen(true);
                      }}
                      onFocus={() => setCategoryDropdownOpen(true)}
                      placeholder="Uncategorized"
                      className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                    />
                    {category && (
                      <button
                        onClick={() => { setCategory(''); setCategoryDropdownOpen(false); }}
                        className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {categoryDropdownOpen && filteredCategories.length > 0 && (
                      <div className="absolute z-20 mt-1 w-full max-h-40 overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg">
                        {filteredCategories.map(c => (
                          <button
                            key={c}
                            onClick={() => { setCategory(c); setCategoryDropdownOpen(false); }}
                            className="w-full text-left px-3 py-1.5 text-sm text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                          >
                            {c}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handlePreview}
                  disabled={!(document.trim() || documentUrl.trim()) || loading}
                  className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-500)] hover:bg-[var(--accent-600)] rounded-md text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Eye className="w-4 h-4" />}
                  Analyze Document
                </button>
              </div>

              {error && (
                <div className="flex items-center gap-2 text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-md p-3">
                  <AlertTriangle className="w-4 h-4 shrink-0" />
                  {error}
                </div>
              )}
            </motion.div>
          )}

          {/* Step 2: Preview */}
          {step === 'preview' && preview && (
            <motion.div key="preview" variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-4">
              {/* Preview Tab Bar */}
              <div className="flex items-center gap-1 bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-1 w-fit shrink-0">
                <button
                  onClick={() => setPreviewTab('analysis')}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded transition-colors ${
                    previewTab === 'analysis'
                      ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <Eye className="w-3.5 h-3.5" />
                  Analysis
                </button>
                <button
                  onClick={() => setPreviewTab('source')}
                  className={`flex items-center gap-2 px-3 py-1.5 text-xs rounded transition-colors ${
                    previewTab === 'source'
                      ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                      : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                  }`}
                >
                  <Code className="w-3.5 h-3.5" />
                  View Source Document
                </button>
              </div>

              {previewTab === 'source' ? (
                /* Source Document View */
                <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
                  {/* Source sub-toggle */}
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-1 bg-[var(--surface-1)] rounded-md p-1">
                      {([
                        { key: 'rendered' as const, label: 'Rendered' },
                        { key: 'raw' as const, label: 'Raw' },
                      ]).map(({ key, label }) => (
                        <button
                          key={key}
                          onClick={() => setSourceView(key)}
                          className={`px-3 py-1 text-xs rounded transition-colors ${
                            sourceView === key
                              ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                              : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)]'
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <button
                      onClick={() => {
                        if (sourceView === 'edit') {
                          setSourceView('rendered');
                        } else {
                          setEditBuffer(document);
                          setSourceView('edit');
                        }
                      }}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs rounded transition-colors ${
                        sourceView === 'edit'
                          ? 'bg-[var(--accent-500)]/20 text-[var(--accent-400)]'
                          : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]'
                      }`}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      {sourceView === 'edit' ? 'Editing' : 'Edit'}
                    </button>
                  </div>

                  {/* Source content */}
                  {sourceView === 'edit' ? (
                    <div className="space-y-3">
                      <textarea
                        value={editBuffer}
                        onChange={(e) => setEditBuffer(e.target.value)}
                        className="w-full h-[40vh] bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 text-sm font-mono text-[var(--text-secondary)] resize-none focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                        placeholder="Edit document content..."
                      />
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleReprocess}
                          disabled={reprocessing || !editBuffer.trim()}
                          className="flex items-center gap-2 px-4 py-2 text-sm bg-[var(--accent-500)]/20 text-[var(--accent-400)] rounded-md hover:bg-[var(--accent-500)]/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {reprocessing ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <RotateCcw className="w-4 h-4" />
                          )}
                          {reprocessing ? 'Reprocessing...' : 'Reprocess'}
                        </button>
                        <button
                          onClick={() => setSourceView('rendered')}
                          className="flex items-center gap-2 px-4 py-2 text-sm text-[var(--text-muted)] rounded-md hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)] transition-colors"
                        >
                          <X className="w-4 h-4" />
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : sourceView === 'raw' ? (
                    <pre className="max-h-[40vh] overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 text-xs font-mono text-[var(--text-secondary)] whitespace-pre-wrap break-words">
                      {document || documentUrl ? document || '(Document loaded from URL — raw content not available locally)' : '(No document content)'}
                    </pre>
                  ) : (
                    <div className="max-h-[40vh] overflow-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md p-4 prose prose-invert prose-sm max-w-none">
                      {document || documentUrl ? (
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                          {document || '*(Document loaded from URL — raw content not available locally)*'}
                        </ReactMarkdown>
                      ) : (
                        <p className="text-[var(--text-muted)] italic">No document content</p>
                      )}
                    </div>
                  )}
                </div>
              ) : (
                /* Analysis View */
                <>
                  {/* Summary Cards */}
                  <div className="grid grid-cols-4 gap-4">
                    <SummaryCard
                      icon={<FileText className="w-5 h-5 text-amber-400" />}
                      label="Findings"
                      value={selectedFindingCount}
                      subtitle={(() => {
                        const included = preview.document.findings.filter(f => selectedFindingIds.has(f.id));
                        const existing = included.filter(f => f.linkedIssueNumbers && f.linkedIssueNumbers.length > 0).length;
                        const newCount = selectedFindingCount - existing;
                        if (existing === 0) return undefined;
                        return `${existing} existing · ${newCount} new`;
                      })()}
                    />
                    <SummaryCard
                      icon={<Layers className="w-5 h-5 text-blue-400" />}
                      label="Phases"
                      value={preview.proposedPhases.length}
                    />
                    <SummaryCard
                      icon={<Tag className="w-5 h-5 text-green-400" />}
                      label="Tags"
                      value={editableTags.length}
                    />
                    <SummaryCard
                      icon={<ChartNetwork className="w-5 h-5 text-purple-400" />}
                      label="Project"
                      value={preview.proposedProjectName}
                      isText
                    />
                  </div>

                  {/* Priority Groups */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
                    <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Priority Groups</h3>
                    <div className="space-y-2">
                      {preview.document.priorityGroups.map(group => (
                        <div key={group.order} className="flex items-center justify-between text-sm">
                          <span className="text-[var(--text-secondary)]">{group.label}</span>
                          <span className="text-[var(--text-muted)]">{group.findingIds.length} items</span>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Phases — Expandable */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
                    <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Proposed Phases</h3>
                    <div className="space-y-3">
                      {preview.proposedPhases.map(phase => {
                        const isExpanded = expandedPhases.has(phase.sortOrder);
                        const phaseFindings = phase.findingIds
                          .map(id => preview.document.findings.find(f => f.id === id))
                          .filter(Boolean) as Finding[];

                        return (
                          <div key={phase.sortOrder} className="border border-[var(--border)] rounded-md">
                            <button
                              onClick={() => {
                                setExpandedPhases(prev => {
                                  const next = new Set(prev);
                                  if (next.has(phase.sortOrder)) {
                                    next.delete(phase.sortOrder);
                                  } else {
                                    next.add(phase.sortOrder);
                                  }
                                  return next;
                                });
                              }}
                              className="w-full p-3 flex items-center justify-between text-left hover:bg-[var(--surface-2)]/50 rounded-md transition-colors"
                            >
                              <div className="flex items-center gap-2">
                                {isExpanded ? (
                                  <ChevronDown className="w-4 h-4 text-[var(--text-muted)]" />
                                ) : (
                                  <ChevronRight className="w-4 h-4 text-[var(--text-muted)]" />
                                )}
                                <span className="text-sm font-medium text-[var(--text-primary)]">{phase.name}</span>
                              </div>
                              <div className="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                                {phase.estimatedDays && <span>{phase.estimatedDays}d</span>}
                                <span>{phase.findingIds.length} items</span>
                              </div>
                            </button>

                            {/* Collapsed: show ID badges */}
                            {!isExpanded && phase.findingIds.length > 0 && (
                              <div className="px-3 pb-3 pt-0 flex flex-wrap gap-1">
                                {phase.findingIds.map(id => {
                                  const finding = preview.document.findings.find(f => f.id === id);
                                  const isExisting = finding?.linkedIssueNumbers && finding.linkedIssueNumbers.length > 0;
                                  return (
                                    <span
                                      key={id}
                                      className={`px-1.5 py-0.5 rounded text-xs ${
                                        isExisting
                                          ? 'bg-purple-500/15 border border-purple-500/30 text-purple-300'
                                          : 'bg-[var(--surface-1)] text-[var(--text-muted)]'
                                      }`}
                                    >
                                      {id}{isExisting ? ` → #${finding!.linkedIssueNumbers![0]}` : ''}
                                    </span>
                                  );
                                })}
                              </div>
                            )}

                            {/* Expanded: show finding details */}
                            {isExpanded && phaseFindings.length > 0 && (
                              <div className="px-3 pb-3 border-t border-[var(--border)]/50">
                                <table className="w-full text-xs mt-2">
                                  <thead>
                                    <tr className="text-[var(--text-muted)] border-b border-[var(--border)]/50">
                                      <th className="text-left py-1.5 pr-2">ID</th>
                                      <th className="text-left py-1.5 pr-2">Issue</th>
                                      <th className="text-left py-1.5 pr-2">Status</th>
                                      <th className="text-left py-1.5 pr-2">Priority</th>
                                      <th className="text-left py-1.5">Tags</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {phaseFindings.map(f => {
                                      const isExisting = f.linkedIssueNumbers && f.linkedIssueNumbers.length > 0;
                                      return (
                                      <tr key={f.id} className="border-b border-[var(--border)]/30">
                                        <td className="py-1.5 pr-2 font-mono text-[var(--accent-400)] whitespace-nowrap">{f.id}</td>
                                        <td className="py-1.5 pr-2 text-[var(--text-secondary)]">{f.issue}</td>
                                        <td className="py-1.5 pr-2 whitespace-nowrap">
                                          {isExisting ? (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-purple-500/15 border border-purple-500/30 rounded text-[10px] text-purple-300 font-medium">
                                              <GitBranch className="w-2.5 h-2.5" />
                                              {f.linkedIssueNumbers!.map(n => `#${n}`).join(', ')}
                                            </span>
                                          ) : (
                                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-emerald-500/15 border border-emerald-500/30 rounded text-[10px] text-emerald-300 font-medium">
                                              New
                                            </span>
                                          )}
                                        </td>
                                        <td className="py-1.5 pr-2 text-[var(--text-muted)] whitespace-nowrap">P{f.priorityOrder}</td>
                                        <td className="py-1.5">
                                          <div className="flex flex-wrap gap-1">
                                            <span className="px-1 py-0.5 bg-amber-500/10 rounded text-[10px] text-amber-300">Priority {f.priorityOrder}</span>
                                            <span className="px-1 py-0.5 bg-blue-500/10 rounded text-[10px] text-blue-300">Effort {f.effort}</span>
                                            <span className="px-1 py-0.5 bg-green-500/10 rounded text-[10px] text-green-300">Area: {f.area}</span>
                                          </div>
                                        </td>
                                      </tr>
                                      );
                                    })}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>

                  {/* Tags */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5">
                    <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Tags to Create (Editable)</h3>
                    <div className="flex flex-wrap gap-1.5 mb-3">
                      {editableTags.map(tag => (
                        <span key={tag} className="inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--accent-500)]/10 border border-[var(--accent-500)]/20 rounded text-xs text-[var(--accent-400)]">
                          {tag}
                          <button
                            type="button"
                            onClick={() => setEditableTags(prev => prev.filter(t => t !== tag))}
                            className="text-[var(--accent-400)]/70 hover:text-[var(--accent-400)]"
                            aria-label={`Remove tag ${tag}`}
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        value={newTag}
                        onChange={e => setNewTag(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key !== 'Enter') return;
                          e.preventDefault();
                          const tag = newTag.trim();
                          if (!tag) return;
                          setEditableTags(prev => {
                            if (prev.some(existing => existing.toLowerCase() === tag.toLowerCase())) return prev;
                            return [...prev, tag];
                          });
                          setNewTag('');
                        }}
                        className="w-full max-w-sm bg-[var(--surface-1)] border border-[var(--border)] rounded px-2 py-1.5 text-xs text-[var(--text-primary)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
                        placeholder="Add tag and press Enter"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          const tag = newTag.trim();
                          if (!tag) return;
                          setEditableTags(prev => {
                            if (prev.some(existing => existing.toLowerCase() === tag.toLowerCase())) return prev;
                            return [...prev, tag];
                          });
                          setNewTag('');
                        }}
                        className="inline-flex items-center gap-1 px-2 py-1.5 text-xs bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded text-[var(--text-primary)]"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        Add
                      </button>
                    </div>
                  </div>

                  {/* Findings Table */}
                  <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5 overflow-x-auto">
                    <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">
                      Findings ({selectedFindingCount} included{skippedFindingCount > 0 ? ` · ${skippedFindingCount} skipped` : ''})
                    </h3>
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                          <th className="text-left py-2 pr-3">Include</th>
                          <th className="text-left py-2 pr-3">ID</th>
                          <th className="text-left py-2 pr-3">Area</th>
                          <th className="text-left py-2 pr-3">Issue</th>
                          <th className="text-left py-2 pr-3">Effort</th>
                          <th className="text-left py-2">Priority</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.document.findings.map(f => (
                          <tr key={f.id} className={`border-b border-[var(--border)]/50 ${selectedFindingIds.has(f.id) ? '' : 'opacity-50'}`}>
                            <td className="py-1.5 pr-3">
                              <input
                                type="checkbox"
                                checked={selectedFindingIds.has(f.id)}
                                onChange={(e) => {
                                  setSelectedFindingIds(prev => {
                                    const next = new Set(prev);
                                    if (e.target.checked) {
                                      next.add(f.id);
                                    } else {
                                      next.delete(f.id);
                                    }
                                    return next;
                                  });
                                }}
                                aria-label={`Include finding ${f.id}`}
                                className="h-3.5 w-3.5 rounded border-[var(--border)] bg-[var(--surface-1)] text-[var(--accent-500)] focus:ring-[var(--accent-500)]/60"
                              />
                            </td>
                            <td className="py-1.5 pr-3 font-mono text-[var(--accent-400)]">{f.id}</td>
                            <td className="py-1.5 pr-3 text-[var(--text-secondary)]">{f.area}</td>
                            <td className="py-1.5 pr-3 text-[var(--text-muted)] max-w-xs truncate">{f.issue}</td>
                            <td className="py-1.5 pr-3 text-[var(--text-muted)]">{f.effort}</td>
                            <td className="py-1.5 text-[var(--text-muted)]">P{f.priorityOrder}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* Actions — sticky at bottom */}
              <div className="sticky bottom-0 pt-4 pb-2 border-t border-[var(--border)] bg-[var(--surface-1)]/95 backdrop-blur-sm">
                <div className="flex items-center gap-3">
                <button
                  onClick={() => setStep('input')}
                  className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded-md text-sm font-medium transition-colors"
                >
                  ← Back
                </button>
                <button
                  onClick={handleExecute}
                  disabled={!repo.trim() || selectedFindingCount === 0 || (projectMode === 'existing' && !selectedProjectId)}
                  className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-500)] hover:bg-[var(--accent-600)] rounded-md text-sm font-medium text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Play className="w-4 h-4" />
                  Execute — {projectMode === 'existing' ? `Append ${selectedFindingCount} Tasks` : `Create ${selectedFindingCount} Tasks + Project`}
                </button>
                {!repo.trim() && (
                  <span className="text-xs text-[var(--text-muted)]">Select a target repo above to execute</span>
                )}
                {projectMode === 'existing' && !selectedProjectId && repo.trim() && (
                  <span className="text-xs text-[var(--text-muted)]">Select an existing project above to execute</span>
                )}
                {repo.trim() && selectedFindingCount === 0 && (
                  <span className="text-xs text-[var(--text-muted)]">Select at least one finding to execute</span>
                )}
                </div>

                {error && (
                  <div className="flex items-center gap-2 text-red-400 text-sm bg-red-950/30 border border-red-900/50 rounded-md p-3 mt-3">
                    <AlertTriangle className="w-4 h-4 shrink-0" />
                    {error}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* Step 3: Executing */}
          {step === 'executing' && (
            <motion.div key="executing" variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="flex flex-col items-center justify-center py-20">
              <Loader2 className="w-10 h-10 text-[var(--accent-400)] animate-spin mb-4" />
              <p className="text-[var(--text-secondary)] text-lg">Creating tasks, project, and phases...</p>
              <p className="text-[var(--text-muted)] text-sm mt-1">Tasks sync to GitHub as issues. This may take a minute for large documents.</p>
            </motion.div>
          )}

          {/* Step 4: Done */}
          {step === 'done' && result && (
            <motion.div key="done" variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-6">
              {/* Success banner */}
              <div className="bg-green-950/30 border border-green-800/50 rounded-lg p-4 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-green-400 mt-0.5 shrink-0" />
                <div>
                  <p className="text-green-200 font-medium">Intake Complete</p>
                  <p className="text-green-400/70 text-sm mt-0.5">
                    Processed {result.issues.length} finding{result.issues.length !== 1 ? 's' : ''},{' '}
                    {result.phases.length} phase{result.phases.length !== 1 ? 's' : ''},{' '}
                    {result.tags.length} tag{result.tags.length !== 1 ? 's' : ''}
                    {result.issues.filter(i => i.issueNumber).length > 0 && (
                      <> · {result.issues.filter(i => i.issueNumber).length} linked to GitHub</>
                    )}
                    {result.assignments.filter(a => a.status === 'assigned').length > 0 &&
                      result.issues.filter(i => i.issueNumber).length === 0 && (
                      <> · {result.assignments.filter(a => a.status === 'assigned').length} tasks assigned</>
                    )}
                  </p>
                </div>
              </div>

              {/* Errors */}
              {result.errors.length > 0 && (
                <div className="bg-red-950/30 border border-red-900/50 rounded-lg p-4">
                  <h3 className="text-sm font-medium text-red-300 mb-2 flex items-center gap-2">
                    <AlertTriangle className="w-4 h-4" />
                    {result.errors.length} Warning(s)
                  </h3>
                  <ul className="text-xs text-red-400/80 space-y-1">
                    {result.errors.map((err, i) => (
                      <li key={i}>• {err}</li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Project link */}
              {result.projectId && (
                <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
                  <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-2">Project</h3>
                  <a
                    href={`/projects/${result.projectId}`}
                    className="inline-flex items-center gap-2 text-[var(--accent-400)] hover:text-[var(--accent-300)] text-sm transition-colors"
                  >
                    <ChartNetwork className="w-4 h-4" />
                    Open project →
                  </a>
                </div>
              )}

              {/* Findings / Task Assignments */}
              <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-5 overflow-x-auto">
                <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">Findings</h3>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                      <th className="text-left py-2 pr-3">Finding</th>
                      <th className="text-left py-2 pr-3">Issue</th>
                      <th className="text-left py-2 pr-3">Phase</th>
                      <th className="text-left py-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.issues.map(issue => {
                      const assignment = result.assignments.find(a => a.findingId === issue.findingId);
                      return (
                        <tr key={issue.findingId} className="border-b border-[var(--border)]/50">
                          <td className="py-1.5 pr-3 font-mono text-[var(--accent-400)]">{issue.findingId}</td>
                          <td className="py-1.5 pr-3">
                            {issue.htmlUrl ? (
                              <a href={issue.htmlUrl} target="_blank" rel="noopener noreferrer"
                                className="text-blue-400 hover:text-blue-300 inline-flex items-center gap-1">
                                #{issue.issueNumber} <ExternalLink className="w-3 h-3" />
                              </a>
                            ) : (
                              <span className="text-[var(--text-muted)]">—</span>
                            )}
                          </td>
                          <td className="py-1.5 pr-3 text-[var(--text-muted)]">{assignment?.phaseName || '—'}</td>
                          <td className="py-1.5">
                            <span className={`px-1.5 py-0.5 rounded text-xs ${
                              assignment?.status === 'assigned' ? 'bg-green-500/10 text-green-400' :
                              assignment?.status === 'missing-task' ? 'bg-yellow-500/10 text-yellow-400' :
                              'bg-[var(--surface-2)] text-[var(--text-muted)]'
                            }`}>
                              {assignment?.status || 'pending'}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-3">
                <button
                  onClick={handleReset}
                  className="px-4 py-2 bg-[var(--surface-2)] hover:bg-[var(--surface-3)] border border-[var(--border)] rounded-md text-sm font-medium transition-colors"
                >
                  Start New Intake
                </button>
                {result.projectId && (
                  <a
                    href={`/projects/${result.projectId}`}
                    onClick={handleClose}
                    className="flex items-center gap-2 px-4 py-2 bg-[var(--accent-500)] hover:bg-[var(--accent-600)] rounded-md text-sm font-medium text-white transition-colors"
                  >
                    <ChartNetwork className="w-4 h-4" />
                    View Project
                  </a>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </Modal>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────────

function SummaryCard({ icon, label, value, isText, subtitle }: { icon: React.ReactNode; label: string; value: string | number; isText?: boolean; subtitle?: string }) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-center gap-2 mb-1">
        {icon}
        <span className="text-xs text-[var(--text-muted)]">{label}</span>
      </div>
      <p className={`${isText ? 'text-sm' : 'text-2xl font-bold'} text-[var(--text-primary)] truncate`}>
        {value}
      </p>
      {subtitle && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{subtitle}</p>}
    </div>
  );
}
