'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Bell, Target } from 'lucide-react';
import { NotificationsPanel } from '@/components/notifications/NotificationsPanel';
import { TodaySidebar } from '@/components/today/TodaySidebar';
import { NavigationBadge } from '@/components/layout/NavigationBadge';
import { useNotifications } from '@/lib/hooks/useNotifications';
import { getNotificationBadgeState } from '@/lib/navigation/badges';
import { cn } from '@/lib/utils';
import { resolveTodayUtilityLayout } from './today-utility-layout';

type UtilityPanel = 'plan' | 'notifications';

const ACTIVE_PANEL_STORAGE_KEY = 'mission-control:my-day-utility-panel';
const ACTIVE_PANEL_CHANGE_EVENT = 'mission-control:my-day-utility-panel-change';
let inMemoryPanel: UtilityPanel = 'plan';

interface TodayUtilityPanelsProps {
  detailOpen: boolean;
  todaySidebarProps: ComponentProps<typeof TodaySidebar>;
}

function readStoredPanel(): UtilityPanel {
  if (typeof window === 'undefined') return inMemoryPanel;
  try {
    const panel = window.localStorage.getItem(ACTIVE_PANEL_STORAGE_KEY) === 'notifications'
      ? 'notifications'
      : 'plan';
    inMemoryPanel = panel;
    return panel;
  } catch {
    return inMemoryPanel;
  }
}

function storePanel(panel: UtilityPanel) {
  if (panel === readStoredPanel()) return;
  inMemoryPanel = panel;
  try {
    window.localStorage.setItem(ACTIVE_PANEL_STORAGE_KEY, panel);
  } catch {
    // The preference is optional when storage is unavailable.
  }
  window.dispatchEvent(new Event(ACTIVE_PANEL_CHANGE_EVENT));
}

function subscribeToStoredPanel(onStoreChange: () => void) {
  const handleChange = () => onStoreChange();
  window.addEventListener('storage', handleChange);
  window.addEventListener(ACTIVE_PANEL_CHANGE_EVENT, handleChange);
  return () => {
    window.removeEventListener('storage', handleChange);
    window.removeEventListener(ACTIVE_PANEL_CHANGE_EVENT, handleChange);
  };
}

export function TodayUtilityPanels({
  detailOpen,
  todaySidebarProps,
}: TodayUtilityPanelsProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const notificationsHook = useNotifications();
  const activePanel = useSyncExternalStore<UtilityPanel>(
    subscribeToStoredPanel,
    readStoredPanel,
    () => 'plan',
  );
  const [availableWidth, setAvailableWidth] = useState(0);
  const layout = resolveTodayUtilityLayout(availableWidth, detailOpen);
  const notificationBadge = getNotificationBadgeState(notificationsHook.stats);

  useLayoutEffect(() => {
    const workspace = anchorRef.current?.parentElement;
    if (!workspace || typeof ResizeObserver === 'undefined') return;

    const updateWidth = (width: number) => {
      const roundedWidth = Math.floor(width);
      if (roundedWidth > 0) {
        setAvailableWidth((current) => current === roundedWidth ? current : roundedWidth);
      }
    };
    const observer = new ResizeObserver(([entry]) => {
      updateWidth(entry?.contentRect.width ?? workspace.getBoundingClientRect().width);
    });

    updateWidth(workspace.getBoundingClientRect().width);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  const selectPanel = (panel: UtilityPanel) => {
    storePanel(panel);
  };

  const planPanel = (className?: string) => (
    <TodaySidebar {...todaySidebarProps} className={className} />
  );
  const notificationsPanel = (className?: string) => (
    <NotificationsPanel
      hook={notificationsHook}
      className={className}
      showHideButton={false}
    />
  );

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />

      {layout === 'dual' && (
        <>
          <div
            className="hidden h-full min-h-0 shrink-0 sm:block"
            onFocusCapture={() => selectPanel('plan')}
            onPointerDownCapture={() => selectPanel('plan')}
          >
            {planPanel()}
          </div>
          <div
            className="hidden h-full min-h-0 shrink-0 sm:block"
            onFocusCapture={() => selectPanel('notifications')}
            onPointerDownCapture={() => selectPanel('notifications')}
          >
            {notificationsPanel()}
          </div>
        </>
      )}

      {(layout === 'single' || layout === 'detail-single') && (
        <section
          aria-label="My Day utility panels"
          className="hidden h-full min-h-0 w-[360px] shrink-0 flex-col border-l border-[var(--border)] bg-[var(--surface-1)] sm:flex"
        >
          <div
            role="tablist"
            aria-label="My Day utility panel"
            className="flex h-11 shrink-0 border-b border-[var(--border)] px-2"
          >
            <UtilityTab
              active={activePanel === 'plan'}
              icon={<Target size={14} aria-hidden="true" />}
              label="Plan & Focus"
              onSelect={() => selectPanel('plan')}
            />
            <UtilityTab
              active={activePanel === 'notifications'}
              badge={notificationBadge}
              icon={<Bell size={14} aria-hidden="true" />}
              label="Notifications"
              onSelect={() => selectPanel('notifications')}
            />
          </div>
          <div className="min-h-0 flex-1">
            {activePanel === 'plan'
              ? planPanel('w-full border-l-0')
              : notificationsPanel('w-full border-l-0')}
          </div>
        </section>
      )}

      {layout === 'rail' && (
        <CollapsedUtilityRail
          activePanel={activePanel}
          notificationBadge={notificationBadge}
          onSelectPanel={selectPanel}
          planPanel={() => planPanel('w-full')}
          notificationsPanel={() => notificationsPanel('w-full')}
        />
      )}
    </>
  );
}

function CollapsedUtilityRail({
  activePanel,
  notificationBadge,
  notificationsPanel,
  onSelectPanel,
  planPanel,
}: {
  activePanel: UtilityPanel;
  notificationBadge: ReturnType<typeof getNotificationBadgeState>;
  notificationsPanel: () => ReactNode;
  onSelectPanel: (panel: UtilityPanel) => void;
  planPanel: () => ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [expanded]);

  const togglePanel = (panel: UtilityPanel) => {
    if (expanded && activePanel === panel) {
      setExpanded(false);
      return;
    }
    onSelectPanel(panel);
    setExpanded(true);
  };

  return (
    <aside
      aria-label="My Day utility panels (collapsed)"
      className="relative hidden h-full w-12 shrink-0 flex-col items-center gap-1 border-l border-[var(--border)] bg-[var(--surface-1)] py-3 sm:flex"
    >
      <UtilityRailButton
        active={activePanel === 'plan' && expanded}
        icon={<Target size={16} />}
        label="Show Plan & Focus"
        onClick={() => togglePanel('plan')}
      />
      <UtilityRailButton
        active={activePanel === 'notifications' && expanded}
        badge={notificationBadge}
        icon={<Bell size={16} />}
        label="Show notifications"
        onClick={() => togglePanel('notifications')}
      />
      {expanded && (
        <div className="absolute inset-y-0 right-full z-30 w-[360px] shadow-[var(--shadow-lg)]">
          {activePanel === 'plan' ? planPanel() : notificationsPanel()}
        </div>
      )}
    </aside>
  );
}

function UtilityTab({
  active,
  badge,
  icon,
  label,
  onSelect,
}: {
  active: boolean;
  badge?: ReturnType<typeof getNotificationBadgeState>;
  icon: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={cn(
        'relative flex flex-1 items-center justify-center gap-1.5 border-b-2 px-2 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--accent)]',
        active
          ? 'border-[var(--accent)] text-[var(--text-primary)]'
          : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-secondary)]',
      )}
    >
      {icon}
      <span>{label}</span>
      {badge && <NavigationBadge count={badge.count} tone={badge.tone} />}
    </button>
  );
}

function UtilityRailButton({
  active,
  badge,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  badge?: ReturnType<typeof getNotificationBadgeState>;
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'relative rounded-[var(--radius-md)] p-2 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]',
        active
          ? 'bg-[var(--accent)]/10 text-[var(--accent)]'
          : 'text-[var(--text-muted)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
      )}
      aria-label={label}
      title={label}
    >
      {icon}
      {badge && <NavigationBadge count={badge.count} tone={badge.tone} overlay />}
    </button>
  );
}
