'use client';

import { useCallback, useEffect, useState, type RefObject } from 'react';
import { ChevronDown } from 'lucide-react';
import type { SettingsSection } from '../settings-search';

export interface SettingsSubsection {
  id: string;
  label: string;
}

export const SETTINGS_SUBSECTIONS: Partial<Record<SettingsSection, SettingsSubsection[]>> = {
  ai: [
    { id: 'execution-destinations', label: 'Execution destinations' },
    { id: 'ai-provider', label: 'AI provider' },
    { id: 'completion-route', label: 'Completion route' },
    { id: 'embedding-route', label: 'Embedding route' },
    { id: 'sensitivity-policies', label: 'Sensitivity policies' },
  ],
  integrations: [
    { id: 'n8n', label: 'n8n' },
    { id: 'webhook-delivery', label: 'Webhook delivery' },
    { id: 'inbound-endpoints', label: 'Inbound endpoints' },
  ],
  notifications: [
    { id: 'notification-enrichment', label: 'Enrichment' },
    { id: 'notification-delivery', label: 'Delivery controls' },
    { id: 'notification-triggers', label: 'Scheduled triggers' },
    { id: 'notification-quiet-hours', label: 'Quiet hours' },
  ],
  storage: [
    { id: 'storage-overview', label: 'Storage overview' },
    { id: 'maintenance-actions', label: 'Maintenance actions' },
    { id: 'clear-by-source', label: 'Clear by source' },
  ],
  general: [
    { id: 'timezone', label: 'Timezone' },
    { id: 'completion-feedback', label: 'Completion & feedback' },
    { id: 'quick-add', label: 'Quick Add' },
    { id: 'badges', label: 'Badges' },
    { id: 'capture', label: 'Capture' },
    { id: 'dopamine-menu', label: 'Dopamine Menu' },
  ],
};

function getSubsectionElement(root: HTMLElement, id: string) {
  return root.querySelector<HTMLElement>(`[data-settings-subsection="${id}"]`);
}

export function focusSettingsSubsection(root: HTMLElement, id: string, smooth = true) {
  const element = getSubsectionElement(root, id);
  if (!element) return false;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hadTabIndex = element.hasAttribute('tabindex');
  if (!hadTabIndex) element.tabIndex = -1;
  element.scrollIntoView({ behavior: smooth && !reduceMotion ? 'smooth' : 'auto', block: 'start' });
  element.focus({ preventScroll: true });
  if (!hadTabIndex) {
    element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
  }
  return true;
}

function replaceLocationHash(id: string) {
  const url = new URL(window.location.href);
  url.hash = id;
  window.history.replaceState(window.history.state, '', url);
}

function useViewportMatches(query: string) {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const updateMatches = () => setMatches(mediaQuery.matches);
    updateMatches();
    mediaQuery.addEventListener('change', updateMatches);
    return () => mediaQuery.removeEventListener('change', updateMatches);
  }, [query]);

  return matches;
}

function useSettingsSubsectionNavigation(
  section: SettingsSection,
  rootRef: RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const subsections = SETTINGS_SUBSECTIONS[section] ?? [];
  const [activeId, setActiveId] = useState(subsections[0]?.id ?? '');

  useEffect(() => {
    setActiveId(subsections[0]?.id ?? '');
  }, [section, subsections]);

  useEffect(() => {
    const root = rootRef.current;
    if (!enabled || !root || subsections.length === 0) return;

    let frameId = 0;
    const updateActiveSubsection = () => {
      window.cancelAnimationFrame(frameId);
      frameId = window.requestAnimationFrame(() => {
        const rootTop = root.getBoundingClientRect().top;
        const threshold = rootTop + Math.min(128, root.clientHeight * 0.2);
        let nextId = subsections[0].id;

        if (Math.ceil(root.scrollTop + root.clientHeight) >= root.scrollHeight - 2) {
          nextId = subsections.at(-1)?.id ?? nextId;
        } else {
          for (const subsection of subsections) {
            const element = getSubsectionElement(root, subsection.id);
            if (element && element.getBoundingClientRect().top <= threshold) {
              nextId = subsection.id;
            }
          }
        }
        setActiveId(nextId);
      });
    };

    root.addEventListener('scroll', updateActiveSubsection, { passive: true });
    window.addEventListener('resize', updateActiveSubsection);
    updateActiveSubsection();

    return () => {
      window.cancelAnimationFrame(frameId);
      root.removeEventListener('scroll', updateActiveSubsection);
      window.removeEventListener('resize', updateActiveSubsection);
    };
  }, [enabled, rootRef, subsections]);

  useEffect(() => {
    if (!enabled) return;
    const hash = window.location.hash.slice(1);
    if (!subsections.some(subsection => subsection.id === hash)) return;

    let attempts = 0;
    let timeoutId: number | undefined;
    const locateHashTarget = () => {
      const root = rootRef.current;
      if (root && focusSettingsSubsection(root, hash, false)) {
        setActiveId(hash);
        return;
      }
      attempts += 1;
      if (attempts < 20) timeoutId = window.setTimeout(locateHashTarget, 50);
    };
    locateHashTarget();
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [enabled, rootRef, section, subsections]);

  const navigate = useCallback((id: string) => {
    const root = rootRef.current;
    if (!root || !focusSettingsSubsection(root, id)) return;
    setActiveId(id);
    replaceLocationHash(id);
  }, [rootRef]);

  return { activeId, navigate, subsections };
}

export function DesktopSettingsSubsections({
  section,
  rootRef,
}: {
  section: SettingsSection;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const enabled = useViewportMatches('(min-width: 640px)');
  const { activeId, navigate, subsections } = useSettingsSubsectionNavigation(section, rootRef, enabled);
  if (subsections.length === 0) return null;

  return (
    <div className="ml-[1.375rem] mt-1 border-l border-[var(--border)] pl-2" aria-label="On this page">
      {subsections.map(subsection => (
        <button
          type="button"
          key={subsection.id}
          onClick={() => navigate(subsection.id)}
          aria-current={activeId === subsection.id ? 'location' : undefined}
          className={`block w-full rounded px-2 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 ${
            activeId === subsection.id
              ? 'bg-blue-900/20 font-medium text-blue-300'
              : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]'
          }`}
        >
          {subsection.label}
        </button>
      ))}
    </div>
  );
}

export function MobileSettingsSubsectionJump({
  section,
  rootRef,
}: {
  section: SettingsSection;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const enabled = useViewportMatches('(max-width: 639px)');
  const { activeId, navigate, subsections } = useSettingsSubsectionNavigation(section, rootRef, enabled);
  if (subsections.length === 0) return null;

  return (
    <div className="relative mb-4 sm:hidden">
      <label htmlFor={`settings-jump-${section}`} className="sr-only">Jump to a section</label>
      <select
        id={`settings-jump-${section}`}
        value={activeId}
        onChange={event => navigate(event.target.value)}
        className="h-10 w-full appearance-none rounded-lg border border-[var(--border)] bg-[var(--surface-1)] px-3 pr-9 text-sm font-medium text-[var(--text-secondary)] outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50"
      >
        {subsections.map(subsection => (
          <option key={subsection.id} value={subsection.id}>
            Jump to: {subsection.label}
          </option>
        ))}
      </select>
      <ChevronDown
        size={14}
        aria-hidden="true"
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)]"
      />
    </div>
  );
}
