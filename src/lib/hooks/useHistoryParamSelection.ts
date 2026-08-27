'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type SetStateAction,
} from 'react';
import {
  currentAppHistoryDetail,
  getAppHistorySnapshot,
  pushAppHistoryDetail,
  replaceAppHistoryDetail,
  subscribeToAppHistory,
} from '@/lib/navigation/app-history';

function currentHref(): string {
  return `${window.location.pathname}${window.location.search}${window.location.hash}`;
}

function selectedValue(param: string): string | null {
  return new URL(window.location.href).searchParams.get(param);
}

export function useHistoryParamSelection(param: string) {
  const [selected, setSelected] = useState<string | null>(() => (
    typeof window === 'undefined' ? null : selectedValue(param)
  ));
  const selectedRef = useRef(selected);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);

  useEffect(() => subscribeToAppHistory(() => {
    const previous = selectedRef.current;
    const next = selectedValue(param);
    closingRef.current = false;
    selectedRef.current = next;
    setSelected(next);
    if (previous && !next) {
      const returnTarget = returnFocusRef.current;
      returnFocusRef.current = null;
      requestAnimationFrame(() => {
        if (returnTarget?.isConnected) returnTarget.focus({ preventScroll: true });
      });
    }
  }), [param]);

  const updateSelection = useCallback((action: SetStateAction<string | null>) => {
    const next = typeof action === 'function'
      ? action(selectedRef.current)
      : action;
    if (next === selectedRef.current) return;

    const url = new URL(window.location.href);
    const existingDetail = currentAppHistoryDetail();

    if (next) {
      if (!selectedRef.current) {
        returnFocusRef.current = document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      }
      url.searchParams.set(param, next);
      const detail = {
        kind: 'detail' as const,
        param,
        parentHref: existingDetail?.param === param
          ? existingDetail.parentHref
          : currentHref(),
      };
      if (selectedRef.current) {
        replaceAppHistoryDetail(
          `${url.pathname}${url.search}${url.hash}`,
          detail,
        );
      } else {
        pushAppHistoryDetail(
          `${url.pathname}${url.search}${url.hash}`,
          detail,
        );
      }
    } else {
      if (closingRef.current) return;
      url.searchParams.delete(param);
      const parentHref = `${url.pathname}${url.search}${url.hash}`;
      const openedHere = existingDetail?.param === param
        && existingDetail.parentHref === parentHref
        && getAppHistorySnapshot().canGoBack;
      if (openedHere) {
        closingRef.current = true;
        window.history.back();
        return;
      }

      replaceAppHistoryDetail(
        parentHref,
        null,
      );
    }

    selectedRef.current = next;
    setSelected(next);
  }, [param]);

  return [selected, updateSelection] as const;
}
