'use client';

import { useCallback, useRef, useState } from 'react';

export type CredentialSource = 'github' | 'reddit' | 'youtube' | 'karakeep';
export type CredentialSourceStatus = 'idle' | 'saving' | 'saved' | 'deleting' | 'error';

interface CredentialSourceOptions<T extends Record<string, string>> {
  source: CredentialSource;
  initialCredentials: T;
  configured?: boolean;
  optionalConfiguredKeys?: Array<keyof T>;
  onChanged?: () => void | Promise<void>;
}

export function useCredentialSource<T extends Record<string, string>>({
  source,
  initialCredentials,
  configured = false,
  optionalConfiguredKeys = [],
  onChanged,
}: CredentialSourceOptions<T>) {
  const [credentials, setCredentials] = useState(initialCredentials);
  const [status, setStatus] = useState<CredentialSourceStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const credentialsRef = useRef(initialCredentials);
  const draftVersionRef = useRef(0);
  const pendingSavesRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const deletionRequestedRef = useRef(false);
  const deletionPromiseRef = useRef<Promise<void> | null>(null);

  const setCredential = useCallback(<K extends keyof T>(key: K, value: T[K]) => {
    const next = { ...credentialsRef.current, [key]: value };
    credentialsRef.current = next;
    draftVersionRef.current += 1;
    setCredentials(next);
    setDirty(true);
    setStatus(current => current === 'saving' || current === 'deleting' ? current : 'idle');
    setError(null);
  }, []);

  const save = useCallback(async () => {
    if (deletionRequestedRef.current) {
      throw new Error(`Cannot save ${source} credentials while removal is in progress`);
    }

    const snapshot = { ...credentialsRef.current };
    const version = draftVersionRef.current;
    const payload = Object.fromEntries(
      Object.entries(snapshot).filter(([key, value]) => (
        value !== '' || !configured || !optionalConfiguredKeys.includes(key as keyof T)
      )),
    );

    pendingSavesRef.current += 1;
    setStatus('saving');
    setError(null);

    const runSave = async () => {
      try {
        const response = await fetch('/api/triage/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source, credentials: payload }),
        });
        if (!response.ok) throw new Error(`Failed to save ${source} credentials`);
        const isCurrentDraft = version === draftVersionRef.current;
        const isLastQueuedSave = pendingSavesRef.current === 1;
        if (isCurrentDraft && isLastQueuedSave && !deletionRequestedRef.current) {
          if (optionalConfiguredKeys.length > 0) {
            const next = { ...credentialsRef.current };
            for (const key of optionalConfiguredKeys) next[key] = '' as T[typeof key];
            credentialsRef.current = next;
            setCredentials(next);
          }
          setDirty(false);
          setStatus('saved');
          await onChanged?.();
        }
      } catch (saveError) {
        if (
          version === draftVersionRef.current
          && pendingSavesRef.current === 1
          && !deletionRequestedRef.current
        ) {
          const message = saveError instanceof Error ? saveError.message : `Failed to save ${source} credentials`;
          setError(message);
          setStatus('error');
        }
        throw saveError;
      } finally {
        pendingSavesRef.current -= 1;
        if (deletionRequestedRef.current) {
          setStatus('deleting');
        } else if (pendingSavesRef.current > 0) {
          setStatus('saving');
        } else if (version !== draftVersionRef.current) {
          setStatus('idle');
        }
      }
    };

    const queuedSave = saveQueueRef.current.then(runSave, runSave);
    saveQueueRef.current = queuedSave.then(() => undefined, () => undefined);
    return queuedSave;
  }, [configured, onChanged, optionalConfiguredKeys, source]);

  const remove = useCallback(() => {
    if (deletionPromiseRef.current) return deletionPromiseRef.current;

    deletionRequestedRef.current = true;
    setStatus('deleting');
    setError(null);

    const runDelete = async () => {
      try {
        const response = await fetch('/api/triage/sources', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ source }),
        });
        if (!response.ok) throw new Error(`Failed to remove ${source} credentials`);

        const cleared = Object.fromEntries(
          Object.keys(credentialsRef.current).map(key => [key, '']),
        ) as T;
        credentialsRef.current = cleared;
        draftVersionRef.current += 1;
        setCredentials(cleared);
        setDirty(false);
        setStatus('idle');
        await onChanged?.();
      } catch (deleteError) {
        const message = deleteError instanceof Error ? deleteError.message : `Failed to remove ${source} credentials`;
        setError(message);
        setStatus('error');
        throw deleteError;
      } finally {
        deletionRequestedRef.current = false;
        deletionPromiseRef.current = null;
      }
    };

    const deletion = saveQueueRef.current.then(runDelete, runDelete);
    deletionPromiseRef.current = deletion;
    return deletion;
  }, [onChanged, source]);

  return {
    credentials,
    setCredential,
    status,
    dirty,
    isSaving: status === 'saving',
    error,
    save,
    remove,
  };
}
