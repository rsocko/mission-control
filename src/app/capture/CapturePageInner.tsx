'use client';

import { useState, useEffect, useCallback, useLayoutEffect, useRef, type FormEvent } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { PlusCircle, Loader2, MapPin, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { addDays, format, endOfWeek } from 'date-fns';

import { VoiceButton } from '@/components/capture/VoiceButton';
import { ImageCaptureButton } from '@/components/capture/ImageCaptureButton';
import { ContextChips, type CaptureContext } from '@/components/capture/ContextChips';
import { RecentCaptures } from '@/components/capture/RecentCaptures';
import { useOfflineQueue } from '@/lib/hooks/useOfflineQueue';
import { PendingSyncIndicator } from '@/components/PendingSyncIndicator';
import { TaskDetailPanel } from '@/components/task-detail/TaskDetailPanel';
import { MobileSheet } from '@/components/ui/MobileSheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  DEFAULT_CAPTURE_IMAGE_MAX_BYTES,
  isCaptureImageMimeType,
} from '@/lib/capture-image';
import { OfflineImageQueueLimitError } from '@/lib/offline-queue';

class ImageUploadHttpError extends Error {}

interface CaptureDestination {
  connectorType: string;
  connectorInstanceId?: string;
  sourceListId?: string;
  sourceListName?: string;
}

interface CaptureSource {
  id: string;
  type: string;
  name: string;
  listSelectionMode: 'required' | 'optional' | 'not-applicable';
}

interface CaptureSourceList {
  connectorInstanceId: string;
  sourceId: string;
  name: string;
}

interface CachedConfiguredCaptureDestination {
  destination: CaptureDestination;
  source: CaptureSource;
}

const LOCAL_CAPTURE_SOURCE: CaptureSource = {
  id: 'local',
  type: 'local',
  name: 'Local',
  listSelectionMode: 'not-applicable',
};
const DEFAULT_LIST_VALUE = '__default__';
const LEGACY_CAPTURE_DESTINATION_STORAGE_KEY = 'mission-control:capture-destination';
const CONFIGURED_CAPTURE_DESTINATION_STORAGE_KEY = 'mission-control:configured-capture-destination:v1';

function readCachedConfiguredDestination(): CachedConfiguredCaptureDestination | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(CONFIGURED_CAPTURE_DESTINATION_STORAGE_KEY);
    if (!raw) return null;
    const cached = JSON.parse(raw) as Partial<CachedConfiguredCaptureDestination>;
    if (
      typeof cached.destination?.connectorType !== 'string'
      || typeof cached.source?.id !== 'string'
      || typeof cached.source.type !== 'string'
      || typeof cached.source.name !== 'string'
      || cached.source.type !== cached.destination.connectorType
      || !['required', 'optional', 'not-applicable'].includes(cached.source.listSelectionMode ?? '')
    ) {
      return null;
    }
    return cached as CachedConfiguredCaptureDestination;
  } catch (error) {
    console.error('Failed to read cached configured capture destination:', error);
    return null;
  }
}

function cacheConfiguredDestination(destination: CaptureDestination, source: CaptureSource): void {
  try {
    window.localStorage.setItem(
      CONFIGURED_CAPTURE_DESTINATION_STORAGE_KEY,
      JSON.stringify({ destination, source } satisfies CachedConfiguredCaptureDestination),
    );
    window.localStorage.removeItem(LEGACY_CAPTURE_DESTINATION_STORAGE_KEY);
  } catch (error) {
    console.error('Failed to cache configured capture destination:', error);
  }
}

async function fetchCaptureLists(
  source: CaptureSource,
  signal?: AbortSignal,
): Promise<CaptureSourceList[]> {
  const response = await fetch(`/api/connectors/${source.id}/lists`, { signal });
  if (!response.ok) {
    throw new Error(`Lists for ${source.name} could not be loaded`);
  }
  const data = await response.json() as {
    sourceLists?: Array<{ sourceId: string; name: string }>;
    lists?: Array<{ sourceId: string; name: string }>;
  };
  return (data.sourceLists ?? data.lists ?? []).map((list) => ({
    connectorInstanceId: source.id,
    sourceId: list.sourceId,
    name: list.name,
  }));
}

function uploadImageCapture(
  file: File,
  title: string,
  description: string,
  idempotencyKey: string,
  onProgress: (progress: number) => void,
): Promise<{ imageUrl: string }> {
  return new Promise((resolve, reject) => {
    const form = new FormData();
    form.set('image', file);
    if (title) form.set('title', title);
    if (description) form.set('description', description);
    form.set('client', 'browser');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/triage/capture/image');
    xhr.setRequestHeader('X-Idempotency-Key', idempotencyKey);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onerror = () => reject(new Error('Network request failed'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body = JSON.parse(xhr.responseText) as { imageUrl?: string };
          if (body.imageUrl) {
            onProgress(100);
            resolve({ imageUrl: body.imageUrl });
            return;
          }
        } catch {
          // Fall through to the stable response error below.
        }
        reject(new ImageUploadHttpError('Upload completed without an image URL'));
        return;
      }
      let message = 'Failed to upload image';
      try {
        const body = JSON.parse(xhr.responseText) as { error?: string };
        if (body.error) message = body.error;
      } catch {
        // Keep the stable fallback for non-JSON proxy errors.
      }
      reject(new ImageUploadHttpError(message));
    };
    xhr.send(form);
  });
}

function resolveDueDate(due: 'today' | 'tomorrow' | 'this_week' | undefined): string | undefined {
  if (!due) return undefined;
  const now = new Date();
  switch (due) {
    case 'today': return format(now, 'yyyy-MM-dd');
    case 'tomorrow': return format(addDays(now, 1), 'yyyy-MM-dd');
    case 'this_week': return format(endOfWeek(now, { weekStartsOn: 1 }), 'yyyy-MM-dd');
  }
}

export default function CapturePageInner() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [imageMaxBytes, setImageMaxBytes] = useState(DEFAULT_CAPTURE_IMAGE_MAX_BYTES);
  const [capturedImageUrl, setCapturedImageUrl] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isShared, setIsShared] = useState(false);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [context, setContext] = useState<CaptureContext>({
    needsTriage: true,
  });
  const { enqueue, enqueueImage, sync } = useOfflineQueue();

  const [defaultDest, setDefaultDest] = useState<CaptureDestination>({ connectorType: 'local' });
  const [captureSources, setCaptureSources] = useState<CaptureSource[]>([LOCAL_CAPTURE_SOURCE]);
  const [captureSourceLists, setCaptureSourceLists] = useState<CaptureSourceList[]>([]);
  const [destinationsLoading, setDestinationsLoading] = useState(true);
  const [destinationLoadError, setDestinationLoadError] = useState<string | null>(null);
  const [failedListSourceIds, setFailedListSourceIds] = useState<string[]>([]);
  const [retryingListSourceId, setRetryingListSourceId] = useState<string | null>(null);
  const configuredDestinationRef = useRef<CaptureDestination>({ connectorType: 'local' });

  useLayoutEffect(() => {
    return () => {
      setDefaultDest(configuredDestinationRef.current);
      setDestinationsLoading(true);
    };
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    const cachedConfiguredDestination = readCachedConfiguredDestination();

    void Promise.all([
      fetch('/api/settings/capture-destination', { signal: abortController.signal }),
      fetch('/api/features', { signal: abortController.signal }),
    ]).then(async ([destinationResponse, featuresResponse]) => {
      if (!destinationResponse.ok || !featuresResponse.ok) {
        throw new Error('Capture destinations could not be loaded');
      }

      const destinationData = await destinationResponse.json() as {
        destination?: CaptureDestination;
      };
      const featuresData = await featuresResponse.json() as {
        taskDestinations?: Array<{
          id: string;
          type: string;
          name: string;
          listSelectionMode?: CaptureSource['listSelectionMode'];
        }>;
      };
      const remoteSources: CaptureSource[] = (featuresData.taskDestinations ?? []).map((source) => ({
        id: source.id,
        type: source.type,
        name: source.name,
        listSelectionMode: source.listSelectionMode ?? 'not-applicable',
      }));
      const sources = [LOCAL_CAPTURE_SOURCE, ...remoteSources];
      const savedDestination = destinationData.destination ?? { connectorType: 'local' };
      const savedSource = sources.find((source) => (
        source.type === savedDestination.connectorType
        && (
          !savedDestination.connectorInstanceId
          || source.id === savedDestination.connectorInstanceId
        )
      ));

      setCaptureSources(sources);
      if (savedSource) {
        const resolvedDestination = {
            ...savedDestination,
            connectorInstanceId: savedSource.type === 'local' ? undefined : savedSource.id,
          };
        configuredDestinationRef.current = resolvedDestination;
        setDefaultDest(resolvedDestination);
        cacheConfiguredDestination(resolvedDestination, savedSource);
      } else {
        configuredDestinationRef.current = { connectorType: 'local' };
        setDefaultDest({ connectorType: 'local' });
        cacheConfiguredDestination({ connectorType: 'local' }, LOCAL_CAPTURE_SOURCE);
      }

      const listResults = await Promise.allSettled(remoteSources.map((source) => (
        fetchCaptureLists(source, abortController.signal)
      )));
      if (abortController.signal.aborted) return;
      const failedSourceIds: string[] = [];
      listResults.forEach((result, index) => {
        if (result.status === 'rejected') {
          failedSourceIds.push(remoteSources[index].id);
          console.error('Failed to load capture destination lists:', result.reason);
        }
      });
      setFailedListSourceIds(failedSourceIds);
      setCaptureSourceLists(listResults.flatMap((result) => (
        result.status === 'fulfilled' ? result.value : []
      )));
      if (failedSourceIds.length > 0) {
        setDestinationLoadError('Some destination lists are temporarily unavailable.');
      } else {
        setDestinationLoadError(null);
      }
    }).catch((error: unknown) => {
      if (abortController.signal.aborted) return;
      console.error('Failed to load capture destinations:', error);
      setDestinationLoadError(cachedConfiguredDestination
        ? 'Using your saved destination while destination data is unavailable.'
        : 'Destinations are temporarily unavailable. Captures will save locally.');
      if (cachedConfiguredDestination) {
        configuredDestinationRef.current = cachedConfiguredDestination.destination;
        setDefaultDest(cachedConfiguredDestination.destination);
        setCaptureSources(cachedConfiguredDestination.source.type === 'local'
          ? [LOCAL_CAPTURE_SOURCE]
          : [LOCAL_CAPTURE_SOURCE, cachedConfiguredDestination.source]);
      } else {
        configuredDestinationRef.current = { connectorType: 'local' };
        setDefaultDest({ connectorType: 'local' });
      }
    }).finally(() => {
      if (!abortController.signal.aborted) setDestinationsLoading(false);
    });

    return () => abortController.abort();
  }, []);

  const selectDestination = useCallback((destination: CaptureDestination) => {
    setDefaultDest(destination);
  }, []);

  const handleCaptureSourceChange = useCallback((sourceId: string) => {
    const source = captureSources.find((candidate) => candidate.id === sourceId);
    if (!source) return;
    selectDestination({
      connectorType: source.type,
      ...(source.type !== 'local' && { connectorInstanceId: source.id }),
    });
  }, [captureSources, selectDestination]);

  const handleCaptureListChange = useCallback((sourceListId: string) => {
    if (sourceListId === DEFAULT_LIST_VALUE) {
      selectDestination({
        connectorType: defaultDest.connectorType,
        connectorInstanceId: defaultDest.connectorInstanceId,
      });
      return;
    }
    const list = captureSourceLists.find((candidate) => (
      candidate.connectorInstanceId === defaultDest.connectorInstanceId
      && candidate.sourceId === sourceListId
    ));
    if (!list) return;
    selectDestination({
      ...defaultDest,
      sourceListId: list.sourceId,
      sourceListName: list.name,
    });
  }, [captureSourceLists, defaultDest, selectDestination]);

  const retryCaptureLists = useCallback(async (source: CaptureSource) => {
    setRetryingListSourceId(source.id);
    try {
      const lists = await fetchCaptureLists(source);
      setCaptureSourceLists((current) => [
        ...current.filter((list) => list.connectorInstanceId !== source.id),
        ...lists,
      ]);
      const remainingFailures = failedListSourceIds.filter((sourceId) => sourceId !== source.id);
      setFailedListSourceIds(remainingFailures);
      if (remainingFailures.length === 0) setDestinationLoadError(null);
    } catch (error) {
      console.error('Failed to retry capture destination lists:', error);
      toast.error(`Lists for ${source.name} are still unavailable`);
    } finally {
      setRetryingListSourceId(null);
    }
  }, [failedListSourceIds]);

  useEffect(() => {
    fetch('/api/triage/capture/image')
      .then((response) => response.ok ? response.json() : Promise.reject(new Error('Config unavailable')))
      .then((data: { maxBytes?: number }) => {
        if (Number.isSafeInteger(data.maxBytes) && data.maxBytes && data.maxBytes > 0) {
          setImageMaxBytes(data.maxBytes);
        }
      })
      .catch(() => {
        // Keep the documented default when configuration cannot be loaded.
      });
  }, []);

  // Handle share target query params
  useEffect(() => {
    const sharedTitle = searchParams.get('shared_title');
    const sharedText = searchParams.get('shared_text');
    const sharedUrl = searchParams.get('shared_url');
    const sharedImageQueued = searchParams.get('shared_image_queued');
    const sharedImageError = searchParams.get('shared_image_error');

    if (sharedTitle || sharedText || sharedUrl || sharedImageQueued) {
      setIsShared(true);
      if (sharedTitle) setTitle(sharedTitle);

      const noteParts: string[] = [];
      if (sharedUrl) noteParts.push(sharedUrl);
      if (sharedText && sharedText !== sharedUrl) noteParts.push(sharedText);
      if (noteParts.length > 0) setNotes(noteParts.join('\n'));

      // Clear sensitive share params from URL/history
      if (sharedImageQueued) {
        void sync().then(() => toast.success('Shared image captured'));
      }
      router.replace('/capture');
    } else if (sharedImageError) {
      toast.error('The shared image could not be captured');
      router.replace('/capture');
    }
  }, [router, searchParams, sync]);

  const handleVoiceTranscript = useCallback((text: string) => {
    setTitle(prev => prev ? `${prev} ${text}` : text);
  }, []);

  const handleImageSelect = useCallback((selected: File) => {
    const mime = selected.type.toLowerCase();
    if (!isCaptureImageMimeType(mime)) {
      setImage(null);
      setImageError('Choose a JPEG, PNG, WebP, or HEIC image.');
      return;
    }
    if (selected.size > imageMaxBytes) {
      setImage(null);
      setImageError(`Image must be ${(imageMaxBytes / (1024 * 1024)).toFixed(1)} MB or smaller.`);
      return;
    }
    setImage(selected);
    setImageError(null);
    setUploadProgress(0);
    setCapturedImageUrl(null);
  }, [imageMaxBytes]);

  const selectedSource = captureSources.find((source) => (
    source.type === defaultDest.connectorType
    && (
      source.type === 'local'
      || source.id === defaultDest.connectorInstanceId
    )
  )) ?? LOCAL_CAPTURE_SOURCE;
  const listsForSelectedSource = captureSourceLists.filter((list) => (
    list.connectorInstanceId === selectedSource.id
  ));
  const destinationListRequired = selectedSource.listSelectionMode === 'required';

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim() && !image) return;
    if (!image && destinationsLoading) return;

    setSaving(true);
    setImageError(null);
    const imageRequestId = image ? `capture-${crypto.randomUUID()}` : undefined;
    try {
      const captureTitle = title.trim()
        || image?.name.replace(/\.[^.]+$/, '').trim()
        || 'Image capture';

      // Offline-first: queue locally if no network
      if (!navigator.onLine) {
        if (image) {
          await enqueueImage(captureTitle, notes.trim() || undefined, {
            blob: image,
            name: image.name,
            type: image.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic',
            size: image.size,
          }, imageRequestId);
        } else {
          await enqueue(captureTitle, notes.trim() || undefined, defaultDest);
        }
        toast.success('Saved offline — will sync when connected');
        setTitle('');
        setNotes('');
        setImage(null);
        setUploadProgress(0);
        setIsShared(false);
        setContext({ needsTriage: true });
        setRefreshKey(k => k + 1);
        window.dispatchEvent(new CustomEvent('mission-control:task-added'));
        return;
      }

      if (image) {
        const uploaded = await uploadImageCapture(
          image,
          captureTitle,
          notes.trim(),
          imageRequestId!,
          setUploadProgress,
        );
        toast.success('Image captured!');
        setTitle('');
        setNotes('');
        setImage(null);
        setUploadProgress(0);
        setCapturedImageUrl(uploaded.imageUrl);
        setIsShared(false);
        setContext({ needsTriage: true });
        setRefreshKey(k => k + 1);
        return;
      }

      const body: Record<string, unknown> = {
        title: title.trim(),
        description: notes.trim() || undefined,
        status: 'todo',
        dueDate: resolveDueDate(context.dueDate),
      };

      if (defaultDest.connectorType !== 'local') {
        body.connectorType = defaultDest.connectorType;
        body.connectorInstanceId = defaultDest.connectorInstanceId;
        if (defaultDest.sourceListId) {
          body.sourceListId = defaultDest.sourceListId;
          body.sourceListName = defaultDest.sourceListName;
        }
      }

      if (context.projectId) {
        body.projectIds = [context.projectId];
      }

      if (context.energyLevel) {
        body.tagSlugs = [`energy-${context.energyLevel}`];
      }

      if (context.needsTriage) {
        body.tagSlugs = [...((body.tagSlugs as string[]) || []), 'needs-triage'];
      }

      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('Failed to save');
      toast.success('Captured!');
      setTitle('');
      setNotes('');
      setIsShared(false);
      setContext({ needsTriage: true });
      setRefreshKey(k => k + 1);
      window.dispatchEvent(new CustomEvent('mission-control:task-added'));
    } catch (error) {
      if (error instanceof OfflineImageQueueLimitError) {
        setImageError(error.message);
        toast.error(error.message);
        return;
      }
      if (error instanceof ImageUploadHttpError) {
        setImageError(error.message);
        toast.error(error.message);
        return;
      }
      // Network failed — queue offline
      const captureTitle = title.trim()
        || image?.name.replace(/\.[^.]+$/, '').trim()
        || 'Image capture';
      if (image) {
        try {
          await enqueueImage(captureTitle, notes.trim() || undefined, {
            blob: image,
            name: image.name,
            type: image.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'image/heic',
            size: image.size,
          }, imageRequestId);
          setImage(null);
          setUploadProgress(0);
        } catch (queueError) {
          const message = queueError instanceof Error
            ? queueError.message
            : 'Image could not be saved offline';
          setImageError(message);
          toast.error(message);
          return;
        }
      } else {
        await enqueue(captureTitle, notes.trim() || undefined, defaultDest);
      }
      toast.success('Saved offline — will sync when connected');
      setTitle('');
      setNotes('');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="h-full overflow-y-auto px-4 py-6 sm:px-8 sm:py-8">
      <div className="max-w-lg mx-auto">
        <div className="flex items-center gap-2 mb-4">
          <PlusCircle size={20} className="text-[var(--accent-400)]" />
          <h1 className="text-lg font-semibold text-[var(--text-primary)]">Quick Capture</h1>
          {isShared && (
            <span className="flex items-center gap-1 text-[10px] bg-blue-500/10 text-blue-500 px-2 py-0.5 rounded-full">
              <Share2 size={10} /> Shared
            </span>
          )}
        </div>
        <div className="mb-4">
          <PendingSyncIndicator />
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] sm:items-start">
            <label
              htmlFor="capture-title"
              className="mb-1 text-xs font-medium text-[var(--text-secondary)] sm:col-start-1 sm:row-start-1"
            >
              Task or note
            </label>
            <input
              id="capture-title"
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What's on your mind?"
              autoFocus
              className="h-11 w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] transition-colors focus:border-[var(--accent)] sm:col-span-2 sm:row-start-2"
            />
            <VoiceButton
              onTranscript={handleVoiceTranscript}
              className="mt-2 sm:col-start-2 sm:row-start-1 sm:ml-2 sm:mt-0"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">
              Image (optional)
            </label>
            <ImageCaptureButton
              file={image}
              disabled={saving}
              error={imageError}
              onSelect={handleImageSelect}
              onRemove={() => {
                setImage(null);
                setImageError(null);
                setUploadProgress(0);
              }}
            />
            {saving && image && uploadProgress > 0 && (
              <div className="mt-2" aria-live="polite">
                <div className="h-1.5 overflow-hidden rounded-full bg-[var(--surface-2)]">
                  <div
                    className="h-full bg-[var(--accent)] transition-[width]"
                    style={{ width: `${uploadProgress}%` }}
                  />
                </div>
                <p className="mt-1 text-xs text-[var(--text-tertiary)]">
                  Uploading image: {uploadProgress}%
                </p>
              </div>
            )}
          </div>

          <div>
            <label htmlFor="capture-notes" className="text-xs font-medium text-[var(--text-secondary)] mb-1 block">
              Notes (optional)
            </label>
            <textarea
              id="capture-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Add context, links, details..."
              rows={4}
              className="w-full rounded-xl border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3 text-sm text-[var(--text-primary)] outline-none placeholder:text-[var(--text-tertiary)] focus:border-[var(--accent)] transition-colors resize-none"
            />
          </div>

          {!image && (
            <>
              <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-3">
                <div className="mb-2 flex items-center gap-1.5">
                  <MapPin size={13} className="text-[var(--accent-400)]" />
                  <span className="text-xs font-medium text-[var(--text-secondary)]">Destination</span>
                  <span className="ml-auto text-[10px] text-[var(--text-tertiary)]">Selected for this session</span>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  <Select
                    value={selectedSource.id}
                    onValueChange={handleCaptureSourceChange}
                    disabled={destinationsLoading}
                  >
                    <SelectTrigger aria-label="Destination source" className="w-full">
                      <SelectValue placeholder="Choose a source" />
                    </SelectTrigger>
                    <SelectContent>
                      {captureSources.map((source) => (
                        <SelectItem key={source.id} value={source.id}>
                          {source.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>

                  {selectedSource.type !== 'local'
                    && (listsForSelectedSource.length > 0 || destinationListRequired) && (
                    <Select
                      value={defaultDest.sourceListId ?? DEFAULT_LIST_VALUE}
                      onValueChange={handleCaptureListChange}
                      disabled={destinationsLoading || listsForSelectedSource.length === 0}
                    >
                      <SelectTrigger aria-label="Destination list" className="w-full">
                        <SelectValue placeholder={destinationListRequired ? 'Choose a list' : 'Source default'} />
                      </SelectTrigger>
                      <SelectContent>
                        {!destinationListRequired && (
                          <SelectItem value={DEFAULT_LIST_VALUE}>Source default</SelectItem>
                        )}
                        {listsForSelectedSource.map((list) => (
                          <SelectItem key={list.sourceId} value={list.sourceId}>
                            {list.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>
                {destinationLoadError && (
                  <p role="status" className="mt-2 text-xs text-[var(--warning)]">
                    {destinationLoadError}
                  </p>
                )}
                {destinationListRequired && !defaultDest.sourceListId && (
                  <p id="capture-destination-required" className="mt-2 text-xs text-amber-500">
                    Choose a list before saving.
                  </p>
                )}
                {failedListSourceIds.includes(selectedSource.id) && (
                  <button
                    type="button"
                    disabled={retryingListSourceId === selectedSource.id}
                    onClick={() => void retryCaptureLists(selectedSource)}
                    className="mt-2 text-xs font-medium text-[var(--accent)] disabled:opacity-50"
                  >
                    {retryingListSourceId === selectedSource.id ? 'Retrying lists...' : 'Retry lists'}
                  </button>
                )}
              </div>
              <ContextChips value={context} onChange={setContext} />
            </>
          )}

          <button
            type="submit"
            disabled={saving
              || (!title.trim() && !image)
              || (!image && destinationsLoading)
              || (!image && destinationListRequired && !defaultDest.sourceListId)}
            aria-describedby={!image && destinationListRequired && !defaultDest.sourceListId
              ? 'capture-destination-required'
              : undefined}
            className="w-full h-12 rounded-xl bg-[var(--success)] text-white font-medium text-sm shadow-sm transition-colors hover:opacity-90 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {saving ? (
              <><Loader2 size={16} className="animate-spin" /> {image ? 'Uploading...' : 'Saving...'}</>
            ) : (
              image
                ? 'Save image to Triage'
                : defaultDest.connectorType === 'local'
                  ? 'Save to Inbox'
                  : `Save to ${defaultDest.sourceListName ?? selectedSource.name}`
            )}
          </button>
        </form>

        {capturedImageUrl && (
          <div className="mt-4 overflow-hidden rounded-xl border border-[var(--success)]/40 bg-[var(--surface-1)]">
            <p className="px-3 py-2 text-xs font-medium text-[var(--success)]">Captured image</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={capturedImageUrl}
              alt="Most recently captured image"
              className="max-h-64 w-full object-contain"
            />
          </div>
        )}

        {/* Recent Captures */}
        <RecentCaptures
          refreshKey={refreshKey}
          onSelectTask={setSelectedTaskId}
        />
      </div>

      <MobileSheet
        isOpen={selectedTaskId !== null}
        onClose={() => setSelectedTaskId(null)}
        ariaLabel="Task details"
        height="full"
      >
        {selectedTaskId && (
          <TaskDetailPanel
            taskId={selectedTaskId}
            mode="mobile"
            onClose={() => setSelectedTaskId(null)}
            onUpdate={() => setRefreshKey((key) => key + 1)}
          />
        )}
      </MobileSheet>
    </div>
  );
}
