'use client';

import { useCallback, useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import {
  fetchConnectedRepos,
  fetchHubProjectsMetadata,
  requestIntakeExecute,
  requestIntakePreview,
} from './intake-api';
import type {
  ConnectedRepo,
  ExecuteResult,
  ExistingProject,
  InputMode,
  PreviewData,
  ProjectMode,
  Step,
} from './types';

export interface UseDocumentIntakeOptions {
  /** Mirrors the wizard modal's visibility; drives the connector/project metadata load. */
  isOpen: boolean;
  /** Called after the wizard resets its state, when the host should dismiss the modal. */
  onClose: () => void;
}

export interface UseDocumentIntakeResult {
  // ── Workflow step ──────────────────────────────────────────────────────
  step: Step;
  error: string | null;

  // ── Document source (shared across preview + execute) ──────────────────
  document: string;
  documentUrl: string;
  setDocument: Dispatch<SetStateAction<string>>;
  setDocumentUrl: Dispatch<SetStateAction<string>>;
  inputMode: InputMode;
  setInputMode: Dispatch<SetStateAction<InputMode>>;

  // ── Execution target ────────────────────────────────────────────────────
  repo: string;
  setRepo: Dispatch<SetStateAction<string>>;
  projectMode: ProjectMode;
  setProjectMode: Dispatch<SetStateAction<ProjectMode>>;
  projectName: string;
  setProjectName: Dispatch<SetStateAction<string>>;
  selectedProjectId: string;
  setSelectedProjectId: Dispatch<SetStateAction<string>>;
  category: string;
  setCategory: Dispatch<SetStateAction<string>>;

  // ── Connector/project metadata (loaded on open; non-critical) ──────────
  connectedRepos: ConnectedRepo[];
  existingProjects: ExistingProject[];
  existingCategories: string[];

  // ── Preview-derived state (seeded from the API, then user-editable) ───
  preview: PreviewData | null;
  loading: boolean;
  reprocessing: boolean;
  selectedFindingIds: Set<string>;
  toggleFinding: (findingId: string, included: boolean) => void;
  editableTags: string[];
  setEditableTags: Dispatch<SetStateAction<string[]>>;

  // ── Execute result ──────────────────────────────────────────────────────
  result: ExecuteResult | null;

  // ── Actions ─────────────────────────────────────────────────────────────
  /** Requests a preview for the current document/documentUrl and, on success, advances to 'preview'. */
  analyze: () => Promise<void>;
  /** Re-previews using edited document text. Resolves true on success, false otherwise. */
  reprocess: (documentText: string) => Promise<boolean>;
  /** Executes the intake for the current selections and advances to 'executing' then 'done'. */
  execute: () => Promise<void>;
  /** Returns to the input step without clearing any entered values. */
  backToInput: () => void;
  /** Clears all workflow state (aborting any in-flight request) and returns to the input step. */
  reset: () => void;
  /** Resets, then notifies the host to close the modal. */
  close: () => void;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * State machine + API orchestration for the Document Intake Wizard.
 *
 * Owns everything that must survive step transitions or feeds request
 * payloads: the document source, execution target selections, the fetched
 * preview/result, and in-flight request bookkeeping. Purely presentational
 * state (dropdown open/search, tab selection, editing buffers) stays local
 * to the step component that renders it.
 */
export function useDocumentIntake({ isOpen, onClose }: UseDocumentIntakeOptions): UseDocumentIntakeResult {
  const [step, setStep] = useState<Step>('input');
  const [document, setDocument] = useState('');
  const [documentUrl, setDocumentUrl] = useState('');
  const [inputMode, setInputMode] = useState<InputMode>('paste');
  const [repo, setRepo] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectMode, setProjectMode] = useState<ProjectMode>('new');
  const [selectedProjectId, setSelectedProjectId] = useState('');
  const [category, setCategory] = useState('');

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [result, setResult] = useState<ExecuteResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [reprocessing, setReprocessing] = useState(false);
  const [selectedFindingIds, setSelectedFindingIds] = useState<Set<string>>(new Set());
  const [editableTags, setEditableTags] = useState<string[]>([]);

  const [connectedRepos, setConnectedRepos] = useState<ConnectedRepo[]>([]);
  const [existingProjects, setExistingProjects] = useState<ExistingProject[]>([]);
  const [existingCategories, setExistingCategories] = useState<string[]>([]);

  // Abort controller to cancel in-flight preview/reprocess/execute fetches on reset/close/re-submit.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    fetchConnectedRepos()
      .then(setConnectedRepos)
      .catch(() => setConnectedRepos([]));

    fetchHubProjectsMetadata()
      .then(({ projects, categories }) => {
        setExistingProjects(projects);
        setExistingCategories(categories);
      })
      .catch(() => {
        setExistingProjects([]);
        setExistingCategories([]);
      });
  }, [isOpen]);

  const startRequest = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    return controller;
  }, []);

  const applyPreview = useCallback((data: PreviewData | null) => {
    setPreview(data);
    setSelectedFindingIds(new Set((data?.document?.findings ?? []).map((finding) => finding.id)));
    setEditableTags(data?.proposedTags ?? []);
  }, []);

  const analyze = useCallback(async () => {
    const hasContent = document.trim() || documentUrl.trim();
    if (!hasContent) return;
    const controller = startRequest();
    setLoading(true);
    setReprocessing(false);
    setError(null);

    try {
      const data = await requestIntakePreview({
        document: document.trim() ? document : undefined,
        documentUrl: !document.trim() && documentUrl.trim() ? documentUrl : undefined,
        projectName: projectName || undefined,
      }, controller.signal);
      // Guard against a superseded request resolving after a newer one started.
      if (controller.signal.aborted) return;
      applyPreview(data);
      setStep('preview');
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Preview failed');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [document, documentUrl, projectName, startRequest, applyPreview]);

  const reprocess = useCallback(async (documentText: string): Promise<boolean> => {
    if (!documentText.trim()) return false;
    const controller = startRequest();
    setLoading(false);
    setReprocessing(true);
    setError(null);
    setDocument(documentText);

    try {
      const data = await requestIntakePreview({
        document: documentText,
        projectName: projectName || undefined,
      }, controller.signal);
      if (controller.signal.aborted) return false;
      applyPreview(data);
      return true;
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return false;
      setError(err instanceof Error ? err.message : 'Reprocess failed');
      return false;
    } finally {
      if (!controller.signal.aborted) setReprocessing(false);
    }
  }, [projectName, startRequest, applyPreview]);

  const toggleFinding = useCallback((findingId: string, included: boolean) => {
    setSelectedFindingIds((prev) => {
      const next = new Set(prev);
      if (included) {
        next.add(findingId);
      } else {
        next.delete(findingId);
      }
      return next;
    });
  }, []);

  const execute = useCallback(async () => {
    const hasContent = document.trim() || documentUrl.trim();
    if (!hasContent || !repo.trim() || !preview) return;
    const controller = startRequest();
    const allFindingIds = preview.document.findings.map((finding) => finding.id);
    const skipFindingIds = allFindingIds.filter((id) => !selectedFindingIds.has(id));
    const tags = editableTags.map((tag) => tag.trim()).filter(Boolean);
    setLoading(false);
    setReprocessing(false);
    setStep('executing');
    setError(null);

    try {
      const data = await requestIntakeExecute({
        repo,
        projectName: projectMode === 'new' ? (projectName || undefined) : undefined,
        existingProjectId: projectMode === 'existing' ? (selectedProjectId || undefined) : undefined,
        category: category || undefined,
        skipFindingIds: skipFindingIds.length > 0 ? skipFindingIds : undefined,
        tags: tags.length > 0 ? tags : undefined,
        document: document.trim() ? document : undefined,
        documentUrl: !document.trim() && documentUrl.trim() ? documentUrl : undefined,
      }, controller.signal);
      if (controller.signal.aborted) return;
      setResult(data);
      setStep('done');
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) return;
      setError(err instanceof Error ? err.message : 'Execution failed');
      setStep('preview');
    }
  }, [
    document,
    documentUrl,
    repo,
    preview,
    selectedFindingIds,
    editableTags,
    projectMode,
    projectName,
    selectedProjectId,
    category,
    startRequest,
  ]);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setStep('input');
    setDocument('');
    setDocumentUrl('');
    setInputMode('paste');
    setRepo('');
    setProjectName('');
    setProjectMode('new');
    setSelectedProjectId('');
    setCategory('');
    setPreview(null);
    setResult(null);
    setError(null);
    setLoading(false);
    setReprocessing(false);
    setSelectedFindingIds(new Set());
    setEditableTags([]);
  }, []);

  const backToInput = useCallback(() => setStep('input'), []);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  return {
    step,
    error,
    document,
    documentUrl,
    setDocument,
    setDocumentUrl,
    inputMode,
    setInputMode,
    repo,
    setRepo,
    projectMode,
    setProjectMode,
    projectName,
    setProjectName,
    selectedProjectId,
    setSelectedProjectId,
    category,
    setCategory,
    connectedRepos,
    existingProjects,
    existingCategories,
    preview,
    loading,
    reprocessing,
    selectedFindingIds,
    toggleFinding,
    editableTags,
    setEditableTags,
    result,
    analyze,
    reprocess,
    execute,
    backToInput,
    reset,
    close,
  };
}
