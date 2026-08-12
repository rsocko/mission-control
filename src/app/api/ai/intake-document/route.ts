import { NextResponse } from 'next/server';
import {
  previewIntakeAsync,
  executeIntake,
  parseDocumentAsync,
  type IntakeConfig,
} from '@/lib/intake/document-intake';
import logger from '@/lib/logger';
import { ApiErrors, apiError } from '@/lib/api-error';
import {
  approvedDocumentRoots,
  decodeUtf8,
  INGESTION_LIMITS,
  IngestionLimitError,
  IngestionTimeoutError,
  IngestionValidationError,
  readLimitedFile,
  readLimitedRequest,
  timeoutSignal,
} from '@/lib/ingestion/bounded-reader';
import { fetchBounded } from '@/lib/ingestion/bounded-fetch';
import { recordIngestionOutcome } from '@/lib/ingestion/telemetry';

/**
 * POST /api/ai/intake-document — Parse and ingest a structured document
 *
 * Body (provide ONE of document, documentUrl, or filePath):
 *   document?: string      — Markdown content directly
 *   documentUrl?: string   — URL to fetch the document from (public or authenticated)
 *   filePath?: string      — Local filesystem path to read the document from
 *   repo: string           — Target GitHub repo (owner/repo) for issue creation
 *   mode: 'preview' | 'execute'  — Preview shows what would be created; execute does it
 *   projectName?: string   — Optional custom project name
 *   projectColor?: string  — Optional project color hex
 *   skipFindingIds?: string[] — Optional finding IDs to skip during execute mode
 *   tags?: string[]        — Optional tag override list to use during execute mode
 *
 * Preview mode returns the parsed structure without creating anything.
 * Execute mode creates MC tasks (synced to GitHub as issues), project, phases, tags, and assignments.
 */
export async function POST(request: Request) {
  const processing = timeoutSignal(INGESTION_LIMITS.intakeProcessingTimeoutMs, request.signal);
  let processingActive = true;
  try {
    const body = JSON.parse(decodeUtf8(await readLimitedRequest(
      request,
      INGESTION_LIMITS.requestBytes,
      'Intake request',
      processing.signal,
    )));
    const { document, documentUrl, filePath, repo, mode, projectName, projectColor, category, skipFindingIds, tags, existingProjectId } = body as {
      document?: string;
      documentUrl?: string;
      filePath?: string;
      repo?: string;
      mode?: 'preview' | 'execute';
      projectName?: string;
      projectColor?: string;
      category?: string;
      skipFindingIds?: string[];
      tags?: string[];
      existingProjectId?: string;
    };

    // Resolve document content from one of the three sources
    const content = await resolveDocumentContent(document, documentUrl, filePath, processing.signal);
    if (!content) {
      return ApiErrors.badRequest('Provide one of: document (string content), documentUrl (URL to fetch), or filePath (local path)');
    }

    if (!content.trim()) {
      return ApiErrors.badRequest('Document is empty');
    }

    // Preview mode — parse only, no side effects
    if (mode === 'preview' || !mode) {
      const preview = await previewIntakeAsync(content, { projectName, signal: processing.signal });
      return NextResponse.json({ preview });
    }

    // Execute mode — requires repo
    if (!repo || !/^[^/]+\/[^/]+$/.test(repo)) {
      return ApiErrors.badRequest('repo (owner/repo format) is required for execute mode');
    }

    const parsedDocument = await parseDocumentAsync(content, processing.signal);
    processing.cleanup();
    processingActive = false;

    const config: IntakeConfig = {
      mcUrl: getInternalMcUrl(request),
      repo,
      dryRun: false,
      projectName,
      projectColor,
      category,
      skipFindingIds: Array.isArray(skipFindingIds) ? skipFindingIds.filter(id => typeof id === 'string') : undefined,
      tags: Array.isArray(tags) ? tags.filter(tag => typeof tag === 'string') : undefined,
      existingProjectId: typeof existingProjectId === 'string' ? existingProjectId : undefined,
      parsedDocument,
    };

    const result = await executeIntake(content, config);

    if (result.errors.length > 0) {
      logger.warn({ errors: result.errors, projectId: result.projectId }, 'Intake completed with errors');
    }

    return NextResponse.json({ result });
  } catch (error) {
    if (error instanceof IngestionLimitError) return apiError(error.message, 'PAYLOAD_TOO_LARGE', 413);
    if (error instanceof IngestionTimeoutError || (error instanceof Error && error.name === 'AbortError')) {
      return apiError('Document ingestion timed out', 'INGESTION_TIMEOUT', 408);
    }
    if (error instanceof IngestionValidationError) return ApiErrors.validation(error.message);
    logger.error({ err: error }, 'Document intake failed');
    return ApiErrors.internal('Document intake failed', error);
  } finally {
    if (processingActive) processing.cleanup();
  }
}

/**
 * Resolve document content from one of three sources (in priority order).
 */
async function resolveDocumentContent(
  document?: string,
  documentUrl?: string,
  filePath?: string,
  signal?: AbortSignal,
): Promise<string | null> {
  // Direct content takes priority
  if (document && typeof document === 'string') {
    const startedAt = performance.now();
    const bytes = new TextEncoder().encode(document);
    if (bytes.byteLength > INGESTION_LIMITS.documentBytes) {
      recordIngestionOutcome({
        source: 'direct-document',
        outcome: 'rejected',
        bytes: bytes.byteLength,
        durationMs: performance.now() - startedAt,
        reason: 'limit',
      });
      throw new IngestionLimitError(`Direct document exceeds the ${INGESTION_LIMITS.documentBytes}-byte limit`, INGESTION_LIMITS.documentBytes, bytes.byteLength);
    }
    signal?.throwIfAborted();
    recordIngestionOutcome({
      source: 'direct-document',
      outcome: 'accepted',
      bytes: bytes.byteLength,
      durationMs: performance.now() - startedAt,
    });
    return document;
  }

  // Fetch from URL
  if (documentUrl && typeof documentUrl === 'string') {
    const headers: Record<string, string> = { Accept: 'text/plain, text/markdown, */*' };

    // Support GitHub raw URLs with token auth
    if (documentUrl.includes('github.com') || documentUrl.includes('raw.githubusercontent.com')) {
      const token = process.env.GITHUB_TOKEN;
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }
    }

    const { bytes } = await fetchBounded(documentUrl, {
      headers,
      limit: INGESTION_LIMITS.documentBytes,
      timeoutMs: INGESTION_LIMITS.intakeTimeoutMs,
      signal,
      acceptContentTypes: /^(text\/|application\/(json|xml|pdf)|application\/octet-stream)/i,
      label: 'Remote document',
      source: 'remote-document',
    });
    return decodeUtf8(bytes);
  }

  // Read from local filesystem
  if (filePath && typeof filePath === 'string') {
    return decodeUtf8(await readLimitedFile(filePath, INGESTION_LIMITS.documentBytes, {
      approvedRoots: approvedDocumentRoots(),
      label: 'Local document',
      signal,
    }));
  }

  return null;
}

/**
 * Get the internal MC URL for self-calls.
 * Always uses 127.0.0.1 (never 0.0.0.0 or external hostnames) since this is
 * the server calling its own API endpoints within the same container/process.
 */
function getInternalMcUrl(request?: Request): string {
  if (process.env.MC_INTERNAL_URL) return process.env.MC_INTERNAL_URL;
  if (process.env.NEXTAUTH_URL) return process.env.NEXTAUTH_URL;

  // Derive port from the request URL or env, but always target 127.0.0.1
  // for reliable self-calls (0.0.0.0 is not a valid connection target).
  let port = process.env.PORT || '3000';
  if (request?.url) {
    try {
      const url = new URL(request.url);
      port = url.port || port;
    } catch {
      // fall through
    }
  }

  return `http://127.0.0.1:${port}`;
}
