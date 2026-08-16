'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  SETTINGS_SECTION_NAMES,
  focusSettingsTarget,
  searchSettings,
  type SettingsSearchItem,
  type SettingsSection,
  useSettingsUrlTarget,
} from './settings-search';

export function useSettingsSearchFocus({
  activeSection,
  navigate,
}: {
  activeSection: SettingsSection;
  navigate: (section: SettingsSection, target: string) => void;
}) {
  const [query, setQuery] = useState('');
  const [pendingItem, setPendingItem] = useState<SettingsSearchItem | null>(null);
  const [urlTarget, setUrlTarget] = useSettingsUrlTarget();
  const mainContentRef = useRef<HTMLElement | null>(null);

  const selectResult = useCallback((item: SettingsSearchItem) => {
    const target = item.target ?? item.title;
    setPendingItem(item);
    setQuery('');
    setUrlTarget(target);
    navigate(item.section, target);
  }, [navigate, setUrlTarget]);

  useEffect(() => {
    const selectedSection = pendingItem?.section ?? activeSection;
    const selectedTarget = pendingItem?.target ?? pendingItem?.title ?? urlTarget;
    if (!selectedTarget || selectedSection !== activeSection) return;

    let stopTimeoutId: number | undefined;
    let observer: MutationObserver | undefined;

    const locateTarget = () => {
      const root = mainContentRef.current;
      if (!root) return false;
      const found = focusSettingsTarget(
        root,
        selectedTarget,
        SETTINGS_SECTION_NAMES[selectedSection],
      );
      if (found) {
        observer?.disconnect();
        if (stopTimeoutId !== undefined) window.clearTimeout(stopTimeoutId);
        setPendingItem(null);
      }
      return found;
    };

    const startTimeoutId = window.setTimeout(() => {
      if (locateTarget()) return;
      const root = mainContentRef.current;
      if (!root) return;
      observer = new MutationObserver(locateTarget);
      observer.observe(root, { childList: true, subtree: true });
      stopTimeoutId = window.setTimeout(() => {
        observer?.disconnect();
        setPendingItem(null);
      }, 10_000);
    }, 220);

    return () => {
      window.clearTimeout(startTimeoutId);
      if (stopTimeoutId !== undefined) window.clearTimeout(stopTimeoutId);
      observer?.disconnect();
    };
  }, [activeSection, pendingItem, urlTarget]);

  return {
    mainContentRef,
    query,
    setQuery,
    results: searchSettings(query),
    selectResult,
  };
}
