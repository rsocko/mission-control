'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface InlineRenameSource {
  name: string;
  icon?: string | null;
  iconColor?: string | null;
}

export interface InlineRenameSnapshot {
  name: string;
  icon: string;
  iconColor: string;
}

interface RenameRequest {
  snapshot: InlineRenameSnapshot;
  persistedName: string;
  key: string;
  sequence: number;
}

interface UseInlineRenameOptions extends InlineRenameSource {
  onSave: (name: string, icon?: string, iconColor?: string) => Promise<void>;
  onError?: (error: unknown) => void;
  blurDelay?: number;
}

function snapshotKey(snapshot: InlineRenameSnapshot) {
  return JSON.stringify([snapshot.name, snapshot.icon, snapshot.iconColor]);
}

export function useInlineRename({
  name: sourceName,
  icon: sourceIcon,
  iconColor: sourceIconColor,
  onSave,
  onError,
  blurDelay = 200,
}: UseInlineRenameOptions) {
  const source = {
    name: sourceName,
    icon: sourceIcon || '',
    iconColor: sourceIconColor || '',
  };
  const [editing, setEditing] = useState(false);
  const [name, setNameState] = useState(source.name);
  const [icon, setIconState] = useState(source.icon);
  const [iconColor, setIconColorState] = useState(source.iconColor);
  const [saving, setSaving] = useState(false);

  const sourceRef = useRef(source);
  const draftRef = useRef<InlineRenameSnapshot>(source);
  const onSaveRef = useRef(onSave);
  const onErrorRef = useRef(onError);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelledRef = useRef(false);
  const pickerOpenRef = useRef(false);
  const mountedRef = useRef(true);
  const editingRef = useRef(false);
  const dirtyRef = useRef(false);
  const editBaseRef = useRef<InlineRenameSnapshot>(source);
  const saveSequenceRef = useRef(0);
  const activeRequestRef = useRef<RenameRequest | null>(null);
  const queuedRequestRef = useRef<RenameRequest | null>(null);
  const lastSuccessfulSnapshotRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    const nextSource = {
      name: sourceName,
      icon: sourceIcon || '',
      iconColor: sourceIconColor || '',
    };
    sourceRef.current = nextSource;
    if (!editingRef.current || !dirtyRef.current) {
      editBaseRef.current = nextSource;
      draftRef.current = nextSource;
      setNameState(nextSource.name);
      setIconState(nextSource.icon);
      setIconColorState(nextSource.iconColor);
    }
    onSaveRef.current = onSave;
    onErrorRef.current = onError;
  }, [onError, onSave, sourceIcon, sourceIconColor, sourceName]);

  const updateDraft = useCallback((nextDraft: InlineRenameSnapshot) => {
    const isDirty = snapshotKey(nextDraft) !== snapshotKey(editBaseRef.current);
    const currentSource = sourceRef.current;
    const resolvedDraft = !isDirty && snapshotKey(editBaseRef.current) !== snapshotKey(currentSource)
      ? currentSource
      : nextDraft;

    if (resolvedDraft === currentSource) editBaseRef.current = currentSource;
    draftRef.current = resolvedDraft;
    dirtyRef.current = snapshotKey(resolvedDraft) !== snapshotKey(editBaseRef.current);
    setNameState(resolvedDraft.name);
    setIconState(resolvedDraft.icon);
    setIconColorState(resolvedDraft.iconColor);
  }, []);

  const setName = useCallback((value: string) => {
    updateDraft({ ...draftRef.current, name: value });
  }, [updateDraft]);

  const setIcon = useCallback((value: string) => {
    updateDraft({ ...draftRef.current, icon: value });
  }, [updateDraft]);

  const setIconColor = useCallback((value: string) => {
    updateDraft({ ...draftRef.current, iconColor: value });
  }, [updateDraft]);

  const clearBlur = useCallback(() => {
    if (blurTimeoutRef.current) {
      clearTimeout(blurTimeoutRef.current);
      blurTimeoutRef.current = undefined;
    }
  }, []);

  const hasChanges = useCallback((snapshot: InlineRenameSnapshot) => {
    const currentSource = sourceRef.current;
    const finalName = snapshot.name.trim();
    return Boolean(
      (finalName && finalName !== currentSource.name)
      || snapshot.icon !== currentSource.icon
      || snapshot.iconColor !== currentSource.iconColor,
    );
  }, []);

  const processQueue = useCallback(async (initialRequest: RenameRequest) => {
    let request = initialRequest;

    while (true) {
      activeRequestRef.current = request;
      let succeeded = false;

      try {
        await onSaveRef.current(
          request.persistedName,
          request.snapshot.icon || undefined,
          request.snapshot.iconColor || undefined,
        );
        succeeded = true;
        lastSuccessfulSnapshotRef.current = request.key;
      } catch (error) {
        onErrorRef.current?.(error);
      }

      const nextRequest = queuedRequestRef.current;
      queuedRequestRef.current = null;
      if (nextRequest) {
        request = nextRequest;
        continue;
      }

      activeRequestRef.current = null;
      if (mountedRef.current && request.sequence === saveSequenceRef.current) {
        if (succeeded) {
          editingRef.current = false;
          dirtyRef.current = false;
          setEditing(false);
        }
        setSaving(false);
      }
      return;
    }
  }, []);

  const enqueueSave = useCallback((snapshot: InlineRenameSnapshot) => {
    const request: RenameRequest = {
      snapshot,
      persistedName: snapshot.name.trim() || sourceRef.current.name,
      key: snapshotKey(snapshot),
      sequence: ++saveSequenceRef.current,
    };
    if (mountedRef.current) setSaving(true);

    const activeRequest = activeRequestRef.current;
    if (!activeRequest) {
      void processQueue(request);
      return;
    }

    if (activeRequest.key === request.key) {
      activeRequest.sequence = request.sequence;
      queuedRequestRef.current = null;
      return;
    }

    const queuedRequest = queuedRequestRef.current;
    if (queuedRequest?.key === request.key) {
      queuedRequest.sequence = request.sequence;
      return;
    }

    queuedRequestRef.current = request;
  }, [processQueue]);

  const save = useCallback(async (nameOverride?: string) => {
    clearBlur();
    const snapshot = {
      ...draftRef.current,
      name: nameOverride ?? draftRef.current.name,
    };

    if (!hasChanges(snapshot)) {
      editingRef.current = false;
      dirtyRef.current = false;
      if (mountedRef.current) setEditing(false);
      return;
    }

    enqueueSave(snapshot);
  }, [clearBlur, enqueueSave, hasChanges]);

  const scheduleBlur = useCallback(() => {
    cancelledRef.current = false;
    clearBlur();
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = undefined;
      if (cancelledRef.current || pickerOpenRef.current) return;
      void save();
    }, blurDelay);
  }, [blurDelay, clearBlur, save]);

  const startEditing = useCallback(() => {
    clearBlur();
    cancelledRef.current = false;
    const currentSource = sourceRef.current;
    editBaseRef.current = currentSource;
    draftRef.current = currentSource;
    dirtyRef.current = false;
    setNameState(currentSource.name);
    setIconState(currentSource.icon);
    setIconColorState(currentSource.iconColor);
    editingRef.current = true;
    setEditing(true);
  }, [clearBlur]);

  const cancel = useCallback(() => {
    cancelledRef.current = true;
    clearBlur();
    saveSequenceRef.current += 1;
    const currentSource = sourceRef.current;
    editBaseRef.current = currentSource;
    draftRef.current = currentSource;
    dirtyRef.current = false;
    setNameState(currentSource.name);
    setIconState(currentSource.icon);
    setIconColorState(currentSource.iconColor);
    setSaving(false);
    editingRef.current = false;
    setEditing(false);
  }, [clearBlur]);

  const setPickerOpen = useCallback((open: boolean) => {
    pickerOpenRef.current = open;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearBlur();
      saveSequenceRef.current += 1;

      const snapshot = draftRef.current;
      const key = snapshotKey(snapshot);
      if (
        !editingRef.current
        || !dirtyRef.current
        || cancelledRef.current
        || !hasChanges(snapshot)
        || activeRequestRef.current?.key === key
        || queuedRequestRef.current?.key === key
        || lastSuccessfulSnapshotRef.current === key
      ) {
        return;
      }

      enqueueSave(snapshot);
    };
  }, [clearBlur, enqueueSave, hasChanges]);

  return {
    editing,
    name,
    setName,
    icon,
    setIcon,
    iconColor,
    setIconColor,
    saving,
    startEditing,
    cancel,
    save,
    scheduleBlur,
    setPickerOpen,
  };
}
