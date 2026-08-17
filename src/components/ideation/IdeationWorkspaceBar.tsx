'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronDown,
  Copy,
  Download,
  FileJson,
  History,
  LoaderCircle,
  Pencil,
  Plus,
  RotateCcw,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  createIdeationWorkspaceDocument,
  ideationWorkspaceDocumentSchema,
  parseLegacyIdeationDraft,
  type IdeationWorkspaceDocument,
} from '@/lib/graph-workspace/ideation-contract';
import type {
  IdeationWorkspace,
  IdeationWorkspaceSummary,
  IdeationWorkspaceVersion,
} from '@/lib/graph-workspace/types';
import type { IdeationNode } from '@/lib/graph/ideation-types';
import {
  reconcileIdeationOutline,
  serializeIdeationOutline,
} from '@/lib/ideation/text-outline';
import { useIdeationStore } from '@/lib/stores/ideationStore';

const LEGACY_KEY = 'mission-control:ideation';
const LEGACY_RECOVERY_KEY = 'mission-control:ideation:recovery';
const LEGACY_MIGRATED_KEY = 'mission-control:ideation:migrated';
const ACTIVE_WORKSPACE_KEY = 'mission-control:ideation:active-workspace';
const AUTOSAVE_DELAY_MS = 700;

interface ApiFailure {
  error?: string;
  code?: string;
  current?: IdeationWorkspace;
}

interface NameDialogState {
  mode: 'create' | 'rename' | 'duplicate';
  value: string;
}

interface RecoveryState {
  kind: 'conflict' | 'error';
  message: string;
  localDocument: IdeationWorkspaceDocument;
  remote?: IdeationWorkspace;
}

interface VersionSummary {
  id: string;
  workspaceId: string;
  revision: number;
  name: string;
  reason: IdeationWorkspaceVersion['reason'];
  createdAt: string;
}

async function jsonRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({})) as T & ApiFailure;
  if (!response.ok) {
    const error = new Error(body.error ?? `Request failed (${response.status})`);
    Object.assign(error, { status: response.status, body });
    throw error;
  }
  return body;
}

function createBlankDocument(): IdeationWorkspaceDocument {
  const root: IdeationNode = {
    id: crypto.randomUUID(),
    label: 'New Project',
    kind: 'idea',
    parentId: null,
    sortOrder: 0,
    properties: {},
  };
  return createIdeationWorkspaceDocument([root]);
}

function downloadFile(name: string, contents: string, type: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  URL.revokeObjectURL(url);
}

function fileName(name: string): string {
  return name.trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    || 'ideation-workspace';
}

function NameDialog({
  state,
  busy,
  onChange,
  onClose,
  onSubmit,
}: {
  state: NameDialogState;
  busy: boolean;
  onChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => void;
}) {
  const title = {
    create: 'Create workspace',
    rename: 'Rename workspace',
    duplicate: 'Duplicate workspace',
  }[state.mode];
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4">
      <form
        className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{title}</h2>
        <label className="mt-4 block space-y-1">
          <span className="text-xs text-[var(--text-secondary)]">Workspace name</span>
          <input
            autoFocus
            value={state.value}
            onChange={(event) => onChange(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--surface-0)] px-3 py-2 text-sm text-[var(--text-primary)]"
          />
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" disabled={!state.value.trim() || busy}>
            {busy ? <LoaderCircle className="animate-spin" /> : null}
            {state.mode === 'create' ? 'Create' : state.mode === 'rename' ? 'Rename' : 'Duplicate'}
          </Button>
        </div>
      </form>
    </div>
  );
}

function HistoryDialog({
  workspace,
  versions,
  inspected,
  busy,
  onClose,
  onInspect,
  onRestore,
}: {
  workspace: IdeationWorkspace;
  versions: VersionSummary[];
  inspected: IdeationWorkspaceVersion | null;
  busy: boolean;
  onClose: () => void;
  onInspect: (revision: number) => void;
  onRestore: (revision: number) => void;
}) {
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/65 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        className="flex max-h-[80vh] w-full max-w-3xl flex-col rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border)] p-4">
          <div>
            <h2 id="history-title" className="text-sm font-semibold text-[var(--text-primary)]">
              Version history
            </h2>
            <p className="text-xs text-[var(--text-tertiary)]">
              Checkpoints for {workspace.name}
            </p>
          </div>
          <Button size="icon" variant="ghost" onClick={onClose} aria-label="Close history">
            <X />
          </Button>
        </div>
        <div className="grid min-h-0 flex-1 md:grid-cols-[18rem_minmax(0,1fr)]">
          <div className="overflow-y-auto border-r border-[var(--border)] p-2">
            {versions.map((version) => (
              <button
                key={version.id}
                type="button"
                onClick={() => onInspect(version.revision)}
                className="mb-1 w-full rounded-lg px-3 py-2 text-left hover:bg-[var(--surface-2)]"
              >
                <span className="block text-xs font-medium text-[var(--text-primary)]">
                  Revision {version.revision}
                </span>
                <span className="block text-xs capitalize text-[var(--text-tertiary)]">
                  {version.reason} · {new Date(version.createdAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
          <div className="min-h-64 overflow-auto p-4">
            {inspected ? (
              <>
                <div className="mb-3 flex items-center justify-between gap-3">
                  <p className="text-xs text-[var(--text-secondary)]">
                    {inspected.document.nodes.length} nodes at revision {inspected.revision}
                  </p>
                  <Button
                    size="sm"
                    onClick={() => onRestore(inspected.revision)}
                    disabled={busy || inspected.revision === workspace.contentRevision}
                  >
                    <RotateCcw /> Restore as latest
                  </Button>
                </div>
                <pre className="max-h-96 overflow-auto rounded-lg bg-[var(--surface-0)] p-3 text-xs text-[var(--text-secondary)]">
                  {JSON.stringify(inspected.document, null, 2)}
                </pre>
              </>
            ) : (
              <p className="text-xs text-[var(--text-tertiary)]">
                Select a checkpoint to inspect its complete document.
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function IdeationWorkspaceBar() {
  const nodes = useIdeationStore((state) => state.nodes);
  const replaceNodes = useIdeationStore((state) => state.replaceNodes);
  const setWorkspaceContext = useIdeationStore((state) => state.setWorkspaceContext);
  const setWorkspaceFlusher = useIdeationStore((state) => state.setWorkspaceFlusher);
  const [workspaces, setWorkspaces] = useState<IdeationWorkspaceSummary[]>([]);
  const [active, setActive] = useState<IdeationWorkspace | null>(null);
  const [status, setStatus] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [nameDialog, setNameDialog] = useState<NameDialogState | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [inspected, setInspected] = useState<IdeationWorkspaceVersion | null>(null);
  const [recovery, setRecovery] = useState<RecoveryState | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const activeRef = useRef<IdeationWorkspace | null>(null);
  const lastSavedRef = useRef('');
  const pendingRef = useRef<IdeationWorkspaceDocument | null>(null);
  const timerRef = useRef<number | null>(null);
  const savePromiseRef = useRef<Promise<void> | null>(null);
  const blockedRef = useRef(false);

  const updateWorkspaceState = useCallback((workspace: IdeationWorkspace) => {
    activeRef.current = workspace;
    setActive(workspace);
    setWorkspaceContext(workspace.id, workspace.contentRevision);
    setWorkspaces((current) => [
      workspace,
      ...current.filter((candidate) => candidate.id !== workspace.id),
    ].sort((first, second) => second.updatedAt.localeCompare(first.updatedAt)));
  }, [setWorkspaceContext]);

  const applyWorkspace = useCallback((workspace: IdeationWorkspace) => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    blockedRef.current = false;
    lastSavedRef.current = JSON.stringify(workspace.document);
    updateWorkspaceState(workspace);
    replaceNodes(workspace.document.nodes);
    localStorage.setItem(ACTIVE_WORKSPACE_KEY, workspace.id);
    setRecovery(null);
    setStatus('saved');
  }, [replaceNodes, updateWorkspaceState]);

  const drainSaves = useCallback(async (): Promise<void> => {
    if (savePromiseRef.current) return savePromiseRef.current;
    const run = async () => {
      while (pendingRef.current && !blockedRef.current) {
        const document = pendingRef.current;
        pendingRef.current = null;
        const target = activeRef.current;
        if (!target || target.archivedAt) return;
        setStatus('saving');
        try {
          const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
            `/api/ideation/workspaces/${target.id}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                baseRevision: target.contentRevision,
                document,
              }),
            },
          );
          if (activeRef.current?.id !== target.id) return;
          lastSavedRef.current = JSON.stringify(document);
          updateWorkspaceState(result.workspace);
          setStatus('saved');
        } catch (error) {
          const failure = error as Error & { status?: number; body?: ApiFailure };
          blockedRef.current = true;
          setStatus('error');
          setRecovery({
            kind: failure.status === 409 ? 'conflict' : 'error',
            message: failure.message,
            localDocument: document,
            remote: failure.body?.current,
          });
          return;
        }
      }
    };
    const promise = run().finally(() => {
      savePromiseRef.current = null;
    });
    savePromiseRef.current = promise;
    return promise;
  }, [updateWorkspaceState]);

  const flushPending = useCallback(async () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = null;
    await drainSaves();
    return !blockedRef.current;
  }, [drainSaves]);

  useEffect(() => {
    setWorkspaceFlusher(() => flushPending());
    return () => setWorkspaceFlusher(null);
  }, [flushPending, setWorkspaceFlusher]);

  const loadWorkspace = useCallback(async (id: string) => {
    if (activeRef.current?.id === id) return;
    if (!await flushPending()) return;
    setStatus('loading');
    try {
      const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
        `/api/ideation/workspaces/${id}`,
      );
      applyWorkspace(result.workspace);
      setLibraryOpen(false);
    } catch (error) {
      setStatus('error');
      toast.error(error instanceof Error ? error.message : 'Failed to load workspace');
    }
  }, [applyWorkspace, flushPending]);

  useEffect(() => {
    let cancelled = false;
    const bootstrap = async () => {
      try {
        let migrated: IdeationWorkspace | null = null;
        const legacy = localStorage.getItem(LEGACY_KEY);
        if (legacy && !localStorage.getItem(LEGACY_MIGRATED_KEY)) {
          try {
            const parsedRaw = JSON.parse(legacy) as unknown;
            const document = parseLegacyIdeationDraft(parsedRaw);
            if (document) {
              if (!localStorage.getItem(LEGACY_RECOVERY_KEY)) {
                localStorage.setItem(LEGACY_RECOVERY_KEY, legacy);
              }
              const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
                '/api/ideation/workspaces',
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    name: 'Recovered Ideation',
                    document,
                    migrationSource: LEGACY_KEY,
                  }),
                },
              );
              migrated = result.workspace;
              localStorage.setItem(LEGACY_MIGRATED_KEY, result.workspace.id);
              localStorage.removeItem(LEGACY_KEY);
              toast.success('Local Ideation draft migrated to a server workspace');
            }
          } catch {
            toast.error('The local Ideation draft could not be migrated; its recovery copy was retained.');
          }
        }
        const library = await jsonRequest<{ workspaces: IdeationWorkspaceSummary[] }>(
          '/api/ideation/workspaces?includeArchived=true',
        );
        if (cancelled) return;
        setWorkspaces(library.workspaces);
        const activeWorkspaces = library.workspaces.filter((workspace) => !workspace.archivedAt);
        let selectedId = migrated?.id;
        if (!selectedId) {
          const remembered = localStorage.getItem(ACTIVE_WORKSPACE_KEY);
          selectedId = activeWorkspaces.some((workspace) => workspace.id === remembered)
            ? remembered!
            : activeWorkspaces[0]?.id;
        }
        if (selectedId) {
          const result = migrated ?? (
            await jsonRequest<{ workspace: IdeationWorkspace }>(
              `/api/ideation/workspaces/${selectedId}`,
            )
          ).workspace;
          if (!cancelled) applyWorkspace(result);
          return;
        }
        const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
          '/api/ideation/workspaces',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: 'New Project', document: createBlankDocument() }),
          },
        );
        if (!cancelled) applyWorkspace(result.workspace);
      } catch (error) {
        if (cancelled) return;
        setStatus('error');
        toast.error(error instanceof Error ? error.message : 'Failed to initialize workspaces');
      }
    };
    void bootstrap();
    return () => {
      cancelled = true;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [applyWorkspace]);

  useEffect(() => {
    if (!active || active.archivedAt || blockedRef.current) return;
    const parsed = ideationWorkspaceDocumentSchema.safeParse({
      schemaVersion: 1,
      type: 'ideation',
      nodes,
    });
    if (!parsed.success) {
      const timeout = window.setTimeout(() => setStatus('error'), 0);
      return () => window.clearTimeout(timeout);
    }
    const document = parsed.data;
    const serialized = JSON.stringify(document);
    if (serialized === lastSavedRef.current) return;
    pendingRef.current = document;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void drainSaves();
    }, AUTOSAVE_DELAY_MS);
  }, [active, drainSaves, nodes]);

  const submitNameDialog = async () => {
    if (!nameDialog) return;
    setBusy(true);
    try {
      if (active && !await flushPending()) return;
      let result: { workspace: IdeationWorkspace };
      if (nameDialog.mode === 'create') {
        result = await jsonRequest('/api/ideation/workspaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameDialog.value, document: createBlankDocument() }),
        });
      } else if (nameDialog.mode === 'duplicate' && active) {
        result = await jsonRequest(`/api/ideation/workspaces/${active.id}/duplicate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameDialog.value }),
        });
      } else if (active) {
        result = await jsonRequest(`/api/ideation/workspaces/${active.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: nameDialog.value }),
        });
      } else {
        return;
      }
      setNameDialog(null);
      if (nameDialog.mode === 'rename') {
        updateWorkspaceState(result.workspace);
      } else {
        applyWorkspace(result.workspace);
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Workspace action failed');
    } finally {
      setBusy(false);
    }
  };

  const setArchived = async (workspace: IdeationWorkspaceSummary, archived: boolean) => {
    setBusy(true);
    try {
      if (workspace.id === active?.id && !await flushPending()) return;
      const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
        `/api/ideation/workspaces/${workspace.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ archived }),
        },
      );
      setWorkspaces((current) => current.map((candidate) => (
        candidate.id === workspace.id ? result.workspace : candidate
      )));
      if (!archived) {
        applyWorkspace(result.workspace);
      } else if (workspace.id === active?.id) {
        activeRef.current = null;
        setActive(null);
        setWorkspaceContext(null, null);
        const next = workspaces.find((candidate) => (
          candidate.id !== workspace.id && !candidate.archivedAt
        ));
        if (next) await loadWorkspace(next.id);
        else setNameDialog({ mode: 'create', value: 'New Project' });
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Archive action failed');
    } finally {
      setBusy(false);
    }
  };

  const deleteWorkspace = async (workspace: IdeationWorkspaceSummary) => {
    if (!window.confirm(`Permanently delete "${workspace.name}" and its version history?`)) return;
    setBusy(true);
    try {
      await jsonRequest(`/api/ideation/workspaces/${workspace.id}`, { method: 'DELETE' });
      setWorkspaces((current) => current.filter((candidate) => candidate.id !== workspace.id));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  };

  const openHistory = async () => {
    if (!active || !await flushPending()) return;
    setBusy(true);
    try {
      const result = await jsonRequest<{ versions: VersionSummary[] }>(
        `/api/ideation/workspaces/${active.id}/versions?limit=30`,
      );
      setVersions(result.versions);
      setInspected(null);
      setHistoryOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load history');
    } finally {
      setBusy(false);
    }
  };

  const inspectVersion = async (revision: number) => {
    if (!active) return;
    setBusy(true);
    try {
      const result = await jsonRequest<{ version: IdeationWorkspaceVersion }>(
        `/api/ideation/workspaces/${active.id}/versions/${revision}`,
      );
      setInspected(result.version);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load checkpoint');
    } finally {
      setBusy(false);
    }
  };

  const restoreVersion = async (revision: number) => {
    if (!active || !window.confirm(`Restore revision ${revision} as the latest workspace state?`)) {
      return;
    }
    setBusy(true);
    try {
      const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
        `/api/ideation/workspaces/${active.id}/versions/${revision}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ baseRevision: active.contentRevision }),
        },
      );
      applyWorkspace(result.workspace);
      setHistoryOpen(false);
      toast.success(`Restored revision ${revision}`);
    } catch (error) {
      const failure = error as Error & { status?: number; body?: ApiFailure };
      if (failure.status === 409 && failure.body?.current) {
        setRecovery({
          kind: 'conflict',
          message: failure.message,
          localDocument: createIdeationWorkspaceDocument(nodes),
          remote: failure.body.current,
        });
      } else {
        toast.error(failure.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const exportJson = () => {
    if (!active) return;
    const parsed = ideationWorkspaceDocumentSchema.safeParse({
      schemaVersion: 1,
      type: 'ideation',
      nodes,
    });
    if (!parsed.success) {
      toast.error('Finish editing invalid or empty node titles before exporting.');
      return;
    }
    const document = parsed.data;
    downloadFile(
      `${fileName(active.name)}.ideation.json`,
      JSON.stringify({
        format: 'mission-control.ideation-workspace',
        exportedAt: new Date().toISOString(),
        workspace: { name: active.name, document },
      }, null, 2),
      'application/json',
    );
  };

  const exportText = () => {
    if (!active) return;
    downloadFile(
      `${fileName(active.name)}.ideation.txt`,
      serializeIdeationOutline(nodes),
      'text/plain',
    );
    toast.warning('Text export preserves hierarchy, node types, priority, and tags. Use JSON for complete fidelity.');
  };

  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const contents = await file.text();
      let name = file.name.replace(/\.(ideation\.)?(json|txt|md)$/i, '') || 'Imported Ideation';
      let document: IdeationWorkspaceDocument;
      if (file.name.toLowerCase().endsWith('.json')) {
        const raw = JSON.parse(contents) as {
          workspace?: { name?: unknown; document?: unknown };
          document?: unknown;
        };
        const candidate = raw.workspace?.document ?? raw.document ?? raw;
        document = ideationWorkspaceDocumentSchema.parse(candidate);
        if (typeof raw.workspace?.name === 'string') name = raw.workspace.name;
      } else {
        const root = createBlankDocument().nodes;
        const importedNodes = reconcileIdeationOutline(root, contents);
        document = createIdeationWorkspaceDocument(importedNodes);
        toast.warning('Text import cannot restore notes, dates, effort, assignees, or relationships. JSON is lossless.');
      }
      const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
        '/api/ideation/workspaces',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, document, import: true }),
        },
      );
      applyWorkspace(result.workspace);
      setLibraryOpen(false);
      toast.success('Workspace imported');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Import failed');
    } finally {
      setBusy(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const reloadRemote = () => {
    if (!recovery?.remote) return;
    applyWorkspace(recovery.remote);
    toast.success('Loaded the server version');
  };

  const saveRecoveryCopy = async () => {
    if (!active || !recovery) return;
    setBusy(true);
    try {
      const result = await jsonRequest<{ workspace: IdeationWorkspace }>(
        '/api/ideation/workspaces',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name: `${active.name} (recovered copy)`,
            document: recovery.localDocument,
          }),
        },
      );
      applyWorkspace(result.workspace);
      toast.success('Saved local changes as a new workspace');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to save recovery copy');
    } finally {
      setBusy(false);
    }
  };

  const activeOptions = useMemo(
    () => workspaces.filter((workspace) => !workspace.archivedAt),
    [workspaces],
  );

  return (
    <>
      <div className="relative flex items-center gap-2">
        <button
          type="button"
          onClick={() => setLibraryOpen((open) => !open)}
          className="flex h-8 max-w-56 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2.5 text-xs text-[var(--text-primary)] hover:bg-[var(--surface-2)]"
          aria-expanded={libraryOpen}
        >
          <span className="truncate">{active?.name ?? 'Loading workspace...'}</span>
          <ChevronDown className="ml-auto size-3.5" />
        </button>
        <span
          className="flex items-center gap-1 text-xs text-[var(--text-tertiary)]"
          role="status"
        >
          {status === 'saving' || status === 'loading'
            ? <LoaderCircle className="size-3 animate-spin" />
            : status === 'saved'
              ? <Check className="size-3 text-emerald-400" />
              : <X className="size-3 text-red-400" />}
          {status === 'loading' ? 'Loading' : status === 'saving' ? 'Saving' : status === 'saved' ? 'Saved' : 'Needs attention'}
        </span>
        {libraryOpen ? (
          <div className="absolute left-0 top-10 z-50 w-[min(30rem,90vw)] rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3 shadow-2xl">
            <div className="flex flex-wrap gap-2 border-b border-[var(--border)] pb-3">
              <Button size="sm" onClick={() => setNameDialog({ mode: 'create', value: 'New Project' })}>
                <Plus /> New
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => active && setNameDialog({ mode: 'rename', value: active.name })}
                disabled={!active}
              >
                <Pencil /> Rename
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => active && setNameDialog({ mode: 'duplicate', value: `${active.name} copy` })}
                disabled={!active}
              >
                <Copy /> Duplicate
              </Button>
              <Button size="sm" variant="secondary" onClick={openHistory} disabled={!active}>
                <History /> History
              </Button>
            </div>
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="ghost" onClick={exportJson} disabled={!active}>
                <FileJson /> Export JSON
              </Button>
              <Button size="sm" variant="ghost" onClick={exportText} disabled={!active}>
                <Download /> Export text
              </Button>
              <Button size="sm" variant="ghost" onClick={() => fileInputRef.current?.click()}>
                <Upload /> Import
              </Button>
              <input
                ref={fileInputRef}
                type="file"
                accept=".json,.txt,.md,application/json,text/plain"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void importFile(file);
                }}
              />
            </div>
            <div className="mt-3 max-h-72 space-y-1 overflow-y-auto">
              {activeOptions.map((workspace) => (
                <div
                  key={workspace.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-[var(--surface-2)]"
                >
                  <button
                    type="button"
                    className="min-w-0 flex-1 truncate text-left text-xs text-[var(--text-primary)]"
                    onClick={() => void loadWorkspace(workspace.id)}
                  >
                    {workspace.name}
                  </button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => void setArchived(workspace, true)}
                    aria-label={`Archive ${workspace.name}`}
                    title="Archive"
                  >
                    <Archive />
                  </Button>
                </div>
              ))}
              {workspaces.some((workspace) => workspace.archivedAt) ? (
                <p className="px-2 pt-2 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
                  Archived
                </p>
              ) : null}
              {workspaces.filter((workspace) => workspace.archivedAt).map((workspace) => (
                <div
                  key={workspace.id}
                  className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-[var(--text-tertiary)]"
                >
                  <span className="min-w-0 flex-1 truncate text-xs">{workspace.name}</span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7"
                    onClick={() => void setArchived(workspace, false)}
                    aria-label={`Restore ${workspace.name}`}
                    title="Restore"
                  >
                    <ArchiveRestore />
                  </Button>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 text-red-400"
                    onClick={() => void deleteWorkspace(workspace)}
                    aria-label={`Delete ${workspace.name}`}
                    title="Delete permanently"
                  >
                    <Trash2 />
                  </Button>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </div>
      {nameDialog ? (
        <NameDialog
          state={nameDialog}
          busy={busy}
          onChange={(value) => setNameDialog({ ...nameDialog, value })}
          onClose={() => setNameDialog(null)}
          onSubmit={() => void submitNameDialog()}
        />
      ) : null}
      {historyOpen && active ? (
        <HistoryDialog
          workspace={active}
          versions={versions}
          inspected={inspected}
          busy={busy}
          onClose={() => setHistoryOpen(false)}
          onInspect={(revision) => void inspectVersion(revision)}
          onRestore={(revision) => void restoreVersion(revision)}
        />
      ) : null}
      {recovery ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 p-4">
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="workspace-recovery-title"
            className="w-full max-w-md rounded-xl border border-amber-500/30 bg-[var(--surface-1)] p-5 shadow-2xl"
          >
            <h2 id="workspace-recovery-title" className="text-sm font-semibold text-[var(--text-primary)]">
              {recovery.kind === 'conflict' ? 'Workspace changed elsewhere' : 'Workspace could not be saved'}
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-[var(--text-secondary)]">
              {recovery.message} Your local changes remain in this tab. Save them as a new
              workspace before loading the server copy.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {recovery.remote ? (
                <Button variant="ghost" onClick={reloadRemote}>Load server copy</Button>
              ) : null}
              <Button onClick={() => void saveRecoveryCopy()} disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Copy />}
                Save local copy
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
