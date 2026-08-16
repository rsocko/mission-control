import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentIntake } from '@/components/projects/document-intake/useDocumentIntake';
import type { ExecuteResult, PreviewData } from '@/components/projects/document-intake/types';

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

function stubFetch(handler: (input: string, init?: RequestInit) => unknown) {
  const fetchMock = vi.fn((input: string | URL | Request, init?: RequestInit) => (
    Promise.resolve(handler(String(input), init))
  ));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function makePreview(overrides: Partial<PreviewData> = {}): PreviewData {
  return {
    document: {
      title: 'Audit',
      findings: [
        { id: 'F1', area: 'Auth', issue: 'Missing rate limit', impact: 'High', suggestedFix: 'Add limiter', effort: 'M', priorityOrder: 1, priorityLabel: 'P1' },
        { id: 'F2', area: 'DB', issue: 'No index', impact: 'Medium', suggestedFix: 'Add index', effort: 'S', priorityOrder: 2, priorityLabel: 'P2' },
      ],
      phases: [],
      priorityGroups: [],
    },
    proposedProjectName: 'Security Audit',
    proposedPhases: [],
    proposedIssueCount: 2,
    proposedTags: ['security'],
    ...overrides,
  };
}

function makeResult(overrides: Partial<ExecuteResult> = {}): ExecuteResult {
  return {
    dryRun: false,
    projectId: 'project-1',
    phases: [],
    issues: [],
    assignments: [],
    tags: [],
    errors: [],
    ...overrides,
  };
}

const noMetadataFetch = (input: string) => {
  if (input === '/api/connectors/github-repos') return jsonResponse({ repos: [] });
  if (input === '/api/hub-projects') return jsonResponse({ projects: [] });
  return jsonResponse({});
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('useDocumentIntake — metadata load', () => {
  it('loads connectors and existing project/category metadata when opened', async () => {
    stubFetch((input) => {
      if (input === '/api/connectors/github-repos') {
        return jsonResponse({ repos: [{ connectorId: 'c1', connectorName: 'GitHub', repo: 'org/repo', displayName: 'org/repo' }] });
      }
      if (input === '/api/hub-projects') {
        return jsonResponse({ projects: [{ id: 'p1', name: 'Alpha', category: 'Ops' }, { id: 'p2', name: 'Beta', category: null }] });
      }
      return jsonResponse({});
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));

    await waitFor(() => expect(result.current.connectedRepos).toHaveLength(1));
    expect(result.current.connectedRepos[0]).toEqual({ connectorId: 'c1', connectorName: 'GitHub', repo: 'org/repo', displayName: 'org/repo' });
    await waitFor(() => expect(result.current.existingProjects).toHaveLength(2));
    expect(result.current.existingCategories).toEqual(['Ops']);
  });

  it('treats metadata fetch failures as empty, non-fatal lists', async () => {
    stubFetch(() => { throw new Error('network down'); });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));

    await waitFor(() => expect(result.current.connectedRepos).toEqual([]));
    expect(result.current.existingProjects).toEqual([]);
    expect(result.current.existingCategories).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('does not fetch metadata while closed', () => {
    const fetchMock = stubFetch(noMetadataFetch);
    renderHook(() => useDocumentIntake({ isOpen: false, onClose: vi.fn() }));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useDocumentIntake — analyze (preview)', () => {
  it('advances to preview and seeds findings/tags on success', async () => {
    const preview = makePreview();
    stubFetch((input, init) => {
      if (input === '/api/ai/intake-document') {
        expect(JSON.parse(String(init?.body)).mode).toBe('preview');
        return jsonResponse({ preview });
      }
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('# Audit\n- finding'));

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.step).toBe('preview');
    expect(result.current.preview).toEqual(preview);
    expect(result.current.selectedFindingIds).toEqual(new Set(['F1', 'F2']));
    expect(result.current.editableTags).toEqual(['security']);
    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it('does nothing when both document and documentUrl are empty', async () => {
    const fetchMock = stubFetch(noMetadataFetch);
    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));

    await act(async () => {
      await result.current.analyze();
    });

    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai/intake-document', expect.anything());
    expect(result.current.step).toBe('input');
  });

  it('surfaces the API error message and stays on the input step on failure', async () => {
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ error: 'Model unavailable' }, false, 503);
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc content'));

    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.step).toBe('input');
    expect(result.current.error).toBe('Model unavailable');
    expect(result.current.loading).toBe(false);
    expect(result.current.preview).toBeNull();
  });

  it('rejects a malformed preview response instead of advancing with invalid state', async () => {
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ preview: {} });
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => {
      result.current.setDocument('doc content');
      result.current.setInputMode('file');
    });
    await act(async () => {
      await result.current.analyze();
    });

    expect(result.current.step).toBe('input');
    expect(result.current.error).toBe('Invalid preview response');
    expect(result.current.preview).toBeNull();
  });
});

describe('useDocumentIntake — back/forward navigation', () => {
  it('backToInput returns to the input step while preserving document, preview, and selections', async () => {
    const preview = makePreview();
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ preview });
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc content'));
    await act(async () => { await result.current.analyze(); });
    expect(result.current.step).toBe('preview');

    act(() => result.current.backToInput());

    expect(result.current.step).toBe('input');
    expect(result.current.document).toBe('doc content');
    expect(result.current.inputMode).toBe('file');
    expect(result.current.preview).toEqual(preview);
    expect(result.current.selectedFindingIds).toEqual(new Set(['F1', 'F2']));

    await act(async () => { await result.current.analyze(); });
    expect(result.current.step).toBe('preview');
  });
});

describe('useDocumentIntake — reprocess', () => {
  it('replaces the document and preview on success, resolving true', async () => {
    const firstPreview = makePreview();
    const secondPreview = makePreview({ proposedProjectName: 'Revised Audit', proposedTags: ['revised'] });
    let call = 0;
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') {
        call += 1;
        return jsonResponse({ preview: call === 1 ? firstPreview : secondPreview });
      }
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('original doc'));
    await act(async () => { await result.current.analyze(); });

    let success = false;
    await act(async () => {
      success = await result.current.reprocess('edited doc text');
    });

    expect(success).toBe(true);
    expect(result.current.document).toBe('edited doc text');
    expect(result.current.preview).toEqual(secondPreview);
    expect(result.current.editableTags).toEqual(['revised']);
  });

  it('keeps the prior preview and reports the error when reprocessing fails, but still updates the document', async () => {
    const firstPreview = makePreview();
    let call = 0;
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') {
        call += 1;
        if (call === 1) return jsonResponse({ preview: firstPreview });
        return jsonResponse({ error: 'Reprocess exploded' }, false, 500);
      }
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('original doc'));
    await act(async () => { await result.current.analyze(); });

    let success = true;
    await act(async () => {
      success = await result.current.reprocess('broken edit');
    });

    expect(success).toBe(false);
    expect(result.current.error).toBe('Reprocess exploded');
    // Document is updated eagerly (matches legacy behavior) even though reprocessing failed.
    expect(result.current.document).toBe('broken edit');
    expect(result.current.preview).toEqual(firstPreview);
    expect(result.current.reprocessing).toBe(false);
  });

  it('resolves false and makes no request for blank input', async () => {
    const fetchMock = stubFetch(noMetadataFetch);
    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));

    let success = true;
    await act(async () => {
      success = await result.current.reprocess('   ');
    });

    expect(success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai/intake-document', expect.anything());
  });
});

describe('useDocumentIntake — toggleFinding', () => {
  it('adds and removes finding ids from the selection', async () => {
    const preview = makePreview();
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ preview });
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc'));
    await act(async () => { await result.current.analyze(); });

    act(() => result.current.toggleFinding('F1', false));
    expect(result.current.selectedFindingIds).toEqual(new Set(['F2']));

    act(() => result.current.toggleFinding('F1', true));
    expect(result.current.selectedFindingIds).toEqual(new Set(['F1', 'F2']));
  });
});

describe('useDocumentIntake — execute', () => {
  async function analyzeToPreview() {
    const preview = makePreview();
    const fetchMock = stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ preview });
      return noMetadataFetch(input);
    });
    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => { result.current.setDocument('doc'); result.current.setRepo('org/repo'); });
    await act(async () => { await result.current.analyze(); });
    return { result, fetchMock, preview };
  }

  it('advances to done with the result on success, sending skipFindingIds/tags/repo', async () => {
    const { result } = await analyzeToPreview();
    act(() => result.current.toggleFinding('F2', false));
    act(() => result.current.setEditableTags(['security', 'p1']));

    const executeResult = makeResult({ issues: [{ findingId: 'F1', title: 'x', issueNumber: 10, htmlUrl: 'https://x' }] });
    stubFetch((input, init) => {
      if (input === '/api/ai/intake-document') {
        const body = JSON.parse(String(init?.body));
        expect(body.mode).toBe('execute');
        expect(body.repo).toBe('org/repo');
        expect(body.skipFindingIds).toEqual(['F2']);
        expect(body.tags).toEqual(['security', 'p1']);
        return jsonResponse({ result: executeResult });
      }
      return noMetadataFetch(input);
    });

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.step).toBe('done');
    expect(result.current.result).toEqual(executeResult);
    expect(result.current.error).toBeNull();
  });

  it('falls back to the preview step with an error message on failure', async () => {
    const { result } = await analyzeToPreview();

    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ error: 'GitHub rate limited' }, false, 429);
      return noMetadataFetch(input);
    });

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.step).toBe('preview');
    expect(result.current.error).toBe('GitHub rate limited');
    expect(result.current.result).toBeNull();
  });

  it('retries execution from preview after a failure and advances to done', async () => {
    const { result } = await analyzeToPreview();

    stubFetch((input) => {
      if (input === '/api/ai/intake-document') {
        return jsonResponse({ error: 'GitHub rate limited' }, false, 429);
      }
      return noMetadataFetch(input);
    });
    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.step).toBe('preview');
    expect(result.current.error).toBe('GitHub rate limited');

    const retriedResult = makeResult({ projectId: 'retry-project' });
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ result: retriedResult });
      return noMetadataFetch(input);
    });
    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.step).toBe('done');
    expect(result.current.result).toEqual(retriedResult);
    expect(result.current.error).toBeNull();
  });

  it('ignores an execute response that arrives after reset cancellation', async () => {
    const { result } = await analyzeToPreview();
    const pending = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/ai/intake-document') return pending.promise;
      return Promise.resolve(noMetadataFetch(String(input)));
    });
    vi.stubGlobal('fetch', fetchMock);

    let executePromise!: Promise<void>;
    act(() => {
      executePromise = result.current.execute();
    });
    expect(result.current.step).toBe('executing');

    const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === '/api/ai/intake-document')!;
    const signal = (init as RequestInit).signal as AbortSignal;
    act(() => result.current.reset());
    expect(signal.aborted).toBe(true);

    await act(async () => {
      pending.resolve(jsonResponse({ result: makeResult({ projectId: 'stale-project' }) }));
      await executePromise;
    });

    expect(result.current.step).toBe('input');
    expect(result.current.result).toBeNull();
  });

  it('clears reprocessing when execution supersedes an in-flight reprocess', async () => {
    const { result } = await analyzeToPreview();
    const pendingReprocess = deferred<Response>();
    let intakeCall = 0;
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) !== '/api/ai/intake-document') {
        return Promise.resolve(noMetadataFetch(String(input)));
      }
      intakeCall += 1;
      if (intakeCall === 1) return pendingReprocess.promise;
      return Promise.resolve(jsonResponse({ error: 'Execution failed' }, false, 500));
    });
    vi.stubGlobal('fetch', fetchMock);

    let reprocessPromise!: Promise<boolean>;
    act(() => {
      reprocessPromise = result.current.reprocess('edited doc');
    });
    expect(result.current.reprocessing).toBe(true);

    await act(async () => {
      await result.current.execute();
    });
    expect(result.current.step).toBe('preview');
    expect(result.current.reprocessing).toBe(false);

    await act(async () => {
      pendingReprocess.resolve(jsonResponse({ preview: makePreview({ proposedProjectName: 'Stale' }) }));
      await reprocessPromise;
    });
    expect(result.current.reprocessing).toBe(false);
  });

  it('does nothing without a repo or preview', async () => {
    const fetchMock = stubFetch(noMetadataFetch);
    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc'));

    await act(async () => {
      await result.current.execute();
    });

    expect(result.current.step).toBe('input');
    expect(fetchMock).not.toHaveBeenCalledWith('/api/ai/intake-document', expect.anything());
  });
});

describe('useDocumentIntake — reset/close', () => {
  it('reset clears document, target selections, preview, and result back to defaults', async () => {
    const preview = makePreview();
    stubFetch((input) => {
      if (input === '/api/ai/intake-document') return jsonResponse({ preview });
      return noMetadataFetch(input);
    });

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => {
      result.current.setDocument('doc');
      result.current.setRepo('org/repo');
      result.current.setProjectName('My Project');
      result.current.setCategory('Ops');
      result.current.setInputMode('file');
    });
    await act(async () => { await result.current.analyze(); });

    act(() => result.current.reset());

    expect(result.current.step).toBe('input');
    expect(result.current.document).toBe('');
    expect(result.current.inputMode).toBe('paste');
    expect(result.current.repo).toBe('');
    expect(result.current.projectName).toBe('');
    expect(result.current.category).toBe('');
    expect(result.current.preview).toBeNull();
    expect(result.current.result).toBeNull();
    expect(result.current.error).toBeNull();
    expect(result.current.selectedFindingIds).toEqual(new Set());
    expect(result.current.editableTags).toEqual([]);
  });

  it('close resets state and notifies the host to dismiss the modal', async () => {
    const onClose = vi.fn();
    stubFetch(noMetadataFetch);
    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose }));
    act(() => result.current.setDocument('doc'));

    act(() => result.current.close());

    expect(onClose).toHaveBeenCalledOnce();
    expect(result.current.document).toBe('');
    expect(result.current.step).toBe('input');
  });

  it('aborts an in-flight preview request on reset', async () => {
    const pending = deferred<Response>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/ai/intake-document') return pending.promise;
      return Promise.resolve(noMetadataFetch(String(input)));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc'));

    let analyzePromise!: Promise<void>;
    act(() => {
      analyzePromise = result.current.analyze();
    });
    expect(result.current.loading).toBe(true);

    const [, init] = fetchMock.mock.calls.find(([url]) => String(url) === '/api/ai/intake-document')!;
    const signal = (init as RequestInit).signal as AbortSignal;
    expect(signal.aborted).toBe(false);

    act(() => result.current.reset());
    expect(signal.aborted).toBe(true);

    // The late (aborted) response should not resurrect loading or preview state.
    await act(async () => {
      pending.resolve(jsonResponse({ preview: makePreview() }));
      await analyzePromise;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.preview).toBeNull();
    expect(result.current.step).toBe('input');
  });
});

describe('useDocumentIntake — cancellation and stale-response safety', () => {
  it('ignores a superseded analyze() response that resolves after a newer request', async () => {
    const previewA = makePreview({ proposedProjectName: 'Doc A preview' });
    const previewB = makePreview({ proposedProjectName: 'Doc B preview' });
    const first = deferred<Response>();
    const second = deferred<Response>();
    let call = 0;

    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/ai/intake-document') {
        call += 1;
        return call === 1 ? first.promise : second.promise;
      }
      return Promise.resolve(noMetadataFetch(String(input)));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));

    let promiseA!: Promise<void>;
    act(() => {
      result.current.setDocument('Doc A');
    });
    act(() => {
      promiseA = result.current.analyze();
    });

    act(() => {
      result.current.setDocument('Doc B');
    });
    let promiseB!: Promise<void>;
    act(() => {
      promiseB = result.current.analyze();
    });

    // The second analyze() call aborts the first request's controller.
    // (Metadata fetches from the isOpen effect may have been recorded first,
    // so filter down to calls against the intake endpoint specifically.)
    const intakeCalls = fetchMock.mock.calls.filter(([url]) => String(url) === '/api/ai/intake-document');
    expect(intakeCalls).toHaveLength(2);
    const [, initA] = intakeCalls[0];
    expect(((initA as RequestInit).signal as AbortSignal).aborted).toBe(true);

    // Resolve the newer (current) request first, as would normally happen.
    await act(async () => {
      second.resolve(jsonResponse({ preview: previewB }));
      await promiseB;
    });
    expect(result.current.step).toBe('preview');
    expect(result.current.preview).toEqual(previewB);

    // Now the stale first request resolves late — it must not clobber state set by B.
    await act(async () => {
      first.resolve(jsonResponse({ preview: previewA }));
      await promiseA;
    });

    expect(result.current.preview).toEqual(previewB);
    expect(result.current.document).toBe('Doc B');
  });

  it('ignores a superseded reprocess() response and does not flip reprocessing back on', async () => {
    const preview = makePreview();
    const previewFromStaleReprocess = makePreview({ proposedProjectName: 'Stale' });
    const previewFromFreshReprocess = makePreview({ proposedProjectName: 'Fresh' });
    const staleCall = deferred<Response>();
    const freshCall = deferred<Response>();
    let call = 0;

    const fetchMock = vi.fn((input: string | URL | Request) => {
      if (String(input) === '/api/ai/intake-document') {
        call += 1;
        if (call === 1) return Promise.resolve(jsonResponse({ preview }));
        return call === 2 ? staleCall.promise : freshCall.promise;
      }
      return Promise.resolve(noMetadataFetch(String(input)));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useDocumentIntake({ isOpen: true, onClose: vi.fn() }));
    act(() => result.current.setDocument('doc'));
    await act(async () => { await result.current.analyze(); });

    let staleReprocess!: Promise<boolean>;
    act(() => {
      staleReprocess = result.current.reprocess('stale edit');
    });
    let freshReprocess!: Promise<boolean>;
    act(() => {
      freshReprocess = result.current.reprocess('fresh edit');
    });

    await act(async () => {
      freshCall.resolve(jsonResponse({ preview: previewFromFreshReprocess }));
      await freshReprocess;
    });
    expect(result.current.preview).toEqual(previewFromFreshReprocess);
    expect(result.current.document).toBe('fresh edit');

    await act(async () => {
      staleCall.resolve(jsonResponse({ preview: previewFromStaleReprocess }));
      await staleReprocess;
    });

    expect(result.current.preview).toEqual(previewFromFreshReprocess);
    expect(result.current.reprocessing).toBe(false);
  });
});
