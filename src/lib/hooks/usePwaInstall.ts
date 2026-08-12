'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

const DISMISSED_KEY = 'mission-control:pwa-install-dismissed';
const DISMISS_DURATION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

type Platform = 'chromium' | 'ios' | null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<{ outcome: 'accepted' | 'dismissed' }>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface PwaInstallState {
  /** Whether we can show an install prompt */
  canPrompt: boolean;
  /** Detected platform for the prompt */
  platform: Platform;
  /** Whether the app is already installed / running standalone */
  isInstalled: boolean;
  /** Trigger the native Chrome install prompt */
  promptInstall: () => Promise<boolean>;
  /** Dismiss the prompt for 30 days */
  dismiss: () => void;
}

function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function isIosSafari(): boolean {
  if (typeof window === 'undefined') return false;
  const ua = window.navigator.userAgent;
  const isIos = /iPad|iPhone|iPod/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document);
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|OPiOS|EdgiOS/.test(ua);
  return isIos && isSafari;
}

function isDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  const raw = localStorage.getItem(DISMISSED_KEY);
  if (!raw) return false;
  const ts = parseInt(raw, 10);
  if (Date.now() - ts < DISMISS_DURATION_MS) return true;
  localStorage.removeItem(DISMISSED_KEY);
  return false;
}

export function usePwaInstall(): PwaInstallState {
  const deferredPrompt = useRef<BeforeInstallPromptEvent | null>(null);
  const [canPrompt, setCanPrompt] = useState(false);
  const [platform, setPlatform] = useState<Platform>(null);
  const [isInstalledState, setIsInstalledState] = useState(true); // default true to avoid flash

  useEffect(() => {
    const installed = isStandalone();
    setIsInstalledState(installed);
    if (installed || isDismissed()) return;

    // Chrome / Chromium-based browsers
    const handler = (e: Event) => {
      e.preventDefault();
      deferredPrompt.current = e as BeforeInstallPromptEvent;
      setPlatform('chromium');
      setCanPrompt(true);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // iOS Safari fallback — no native event, just show manual instructions
    if (isIosSafari()) {
      setPlatform('ios');
      setCanPrompt(true);
    }

    // Detect install after prompt accepted
    const mediaQuery = window.matchMedia('(display-mode: standalone)');
    const onDisplayChange = () => {
      if (mediaQuery.matches) {
        setIsInstalledState(true);
        setCanPrompt(false);
      }
    };
    mediaQuery.addEventListener('change', onDisplayChange);

    return () => {
      window.removeEventListener('beforeinstallprompt', handler);
      mediaQuery.removeEventListener('change', onDisplayChange);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<boolean> => {
    if (!deferredPrompt.current) return false;
    try {
      const result = await deferredPrompt.current.prompt();
      deferredPrompt.current = null;
      if (result.outcome === 'accepted') {
        setIsInstalledState(true);
        setCanPrompt(false);
        return true;
      }
      return false;
    } catch {
      deferredPrompt.current = null;
      return false;
    }
  }, []);

  const dismiss = useCallback(() => {
    localStorage.setItem(DISMISSED_KEY, Date.now().toString());
    setCanPrompt(false);
  }, []);

  return {
    canPrompt,
    platform,
    isInstalled: isInstalledState,
    promptInstall,
    dismiss,
  };
}
