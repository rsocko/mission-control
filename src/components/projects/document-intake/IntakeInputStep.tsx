'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  AlertTriangle,
  ChevronDown,
  Eye,
  GitBranch,
  Layers,
  Loader2,
  Plus,
  Upload,
  X,
} from 'lucide-react';
import { fadeSlideUp } from '@/lib/motion';
import type { ConnectedRepo, ExistingProject, InputMode, ProjectMode } from './types';

export interface IntakeInputStepProps {
  document: string;
  documentUrl: string;
  onDocumentChange: (value: string) => void;
  onDocumentUrlChange: (value: string) => void;
  inputMode: InputMode;
  onInputModeChange: (mode: InputMode) => void;

  repo: string;
  onRepoChange: (value: string) => void;
  connectedRepos: ConnectedRepo[];

  projectMode: ProjectMode;
  onProjectModeChange: (mode: ProjectMode) => void;
  projectName: string;
  onProjectNameChange: (value: string) => void;
  existingProjects: ExistingProject[];
  selectedProjectId: string;
  onSelectedProjectIdChange: (id: string) => void;

  category: string;
  onCategoryChange: (value: string) => void;
  existingCategories: string[];

  loading: boolean;
  error: string | null;
  onAnalyze: () => void;
}

/**
 * Step 1: document source + execution target selection.
 *
 * Owns all of its own presentation-only state (input mode tabs, dropdown
 * open/search state); the document content, repo, project, and category
 * selections are lifted to `useDocumentIntake` since `IntakeExecuteStep`'s
 * request needs them too.
 */
export function IntakeInputStep({
  document,
  documentUrl,
  onDocumentChange,
  onDocumentUrlChange,
  inputMode,
  onInputModeChange,
  repo,
  onRepoChange,
  connectedRepos,
  projectMode,
  onProjectModeChange,
  projectName,
  onProjectNameChange,
  existingProjects,
  selectedProjectId,
  onSelectedProjectIdChange,
  category,
  onCategoryChange,
  existingCategories,
  loading,
  error,
  onAnalyze,
}: IntakeInputStepProps) {
  const [repoDropdownOpen, setRepoDropdownOpen] = useState(false);
  const [repoSearch, setRepoSearch] = useState('');
  const repoDropdownRef = useRef<HTMLDivElement>(null);

  const [projectSearch, setProjectSearch] = useState(
    () => existingProjects.find((project) => project.id === selectedProjectId)?.name ?? '',
  );
  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  const [categoryDropdownOpen, setCategoryDropdownOpen] = useState(false);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);

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
      (r) => r.repo.toLowerCase().includes(q) || r.displayName.toLowerCase().includes(q),
    );
  }, [connectedRepos, repoSearch]);

  const filteredCategories = useMemo(() => {
    if (!category.trim()) return existingCategories;
    const q = category.toLowerCase();
    return existingCategories.filter((c) => c.toLowerCase().includes(q));
  }, [existingCategories, category]);

  const filteredProjects = useMemo(() => {
    if (!projectSearch.trim()) return existingProjects;
    const q = projectSearch.toLowerCase();
    return existingProjects.filter((p) => p.name.toLowerCase().includes(q));
  }, [existingProjects, projectSearch]);

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      onDocumentChange(reader.result as string);
    };
    reader.readAsText(file);
  }

  return (
    <motion.div variants={fadeSlideUp} initial="hidden" animate="show" exit="hidden" className="space-y-6">
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
              onClick={() => onInputModeChange(key)}
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
              onChange={(e) => onDocumentChange(e.target.value)}
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
              onChange={(e) => onDocumentUrlChange(e.target.value)}
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
                      onChange={(e) => setRepoSearch(e.target.value)}
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
                    filteredRepos.map((r) => (
                      <button
                        key={`${r.connectorId}:${r.repo}`}
                        type="button"
                        onClick={() => {
                          onRepoChange(r.repo);
                          setRepoDropdownOpen(false);
                          setRepoSearch('');
                        }}
                        className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--surface-2)] transition-colors flex items-center gap-2 ${
                          repo === r.repo ? 'bg-[var(--surface-2)] text-[var(--accent-400)]' : 'text-[var(--text-secondary)]'
                        }`}
                      >
                        <GitBranch className="w-3.5 h-3.5 text-[var(--text-muted)] shrink-0" />
                        <span className="truncate">{r.repo}</span>
                        {connectedRepos.filter((cr) => cr.connectorId !== r.connectorId).length > 0 && (
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
                onClick={() => onProjectModeChange('new')}
                className={`px-2.5 py-1 transition-colors ${projectMode === 'new' ? 'bg-[var(--accent-500)] text-white' : 'bg-[var(--surface-1)] text-[var(--text-secondary)] hover:bg-[var(--surface-3)]'}`}
              >
                <Plus className="w-3 h-3 inline mr-1" />New
              </button>
              <button
                type="button"
                onClick={() => onProjectModeChange('existing')}
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
              onChange={(e) => onProjectNameChange(e.target.value)}
              placeholder="Auto-generated from doc title"
              className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
            />
          ) : (
            <div className="relative" ref={projectDropdownRef}>
              <input
                type="text"
                value={projectSearch}
                onChange={(e) => { setProjectSearch(e.target.value); onSelectedProjectIdChange(''); setProjectDropdownOpen(true); }}
                onFocus={() => setProjectDropdownOpen(true)}
                placeholder="Search existing projects…"
                className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
              />
              {selectedProjectId && (
                <button
                  onClick={() => { onSelectedProjectIdChange(''); setProjectSearch(''); }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
              {projectDropdownOpen && filteredProjects.length > 0 && (
                <div className="absolute z-20 mt-1 w-full max-h-40 overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg">
                  {filteredProjects.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => { onSelectedProjectIdChange(p.id); setProjectSearch(p.name); setProjectDropdownOpen(false); }}
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
              onChange={(e) => {
                onCategoryChange(e.target.value);
                setCategoryDropdownOpen(true);
              }}
              onFocus={() => setCategoryDropdownOpen(true)}
              placeholder="Uncategorized"
              className="w-full bg-[var(--surface-1)] border border-[var(--border)] rounded-md px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-1 focus:ring-[var(--accent-500)]/50"
            />
            {category && (
              <button
                onClick={() => { onCategoryChange(''); setCategoryDropdownOpen(false); }}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-secondary)]"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            )}
            {categoryDropdownOpen && filteredCategories.length > 0 && (
              <div className="absolute z-20 mt-1 w-full max-h-40 overflow-y-auto bg-[var(--surface-1)] border border-[var(--border)] rounded-md shadow-lg">
                {filteredCategories.map((c) => (
                  <button
                    key={c}
                    onClick={() => { onCategoryChange(c); setCategoryDropdownOpen(false); }}
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
          onClick={onAnalyze}
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
  );
}
