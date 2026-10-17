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
import {
  resolveTodayUtilityVisibility,
  type TodayUtilityPanel,
  type TodayUtilityPreferences,
} from './today-utility-layout';

const UTILITY_PREFERENCES_STORAGE_KEY = 'mission-control:my-day-utility-panes';
const UTILITY_PREFERENCES_CHANGE_EVENT = 'mission-control:my-day-utility-panes-change';
const DEFAULT_UTILITY_STATE = '10:plan';
const VALID_UTILITY_STATE = /^[01][01]:(plan|notifications)$/;
let inMemoryUtilityState = DEFAULT_UTILITY_STATE;

interface TodayUtilityPanelsProps {
  detailOpen: boolean;
  todaySidebarProps: ComponentProps<typeof TodaySidebar>;
}

function readStoredUtilityState(): string {
  if (typeof window === 'undefined') return inMemoryUtilityState;
  try {
    const stored = window.localStorage.getItem(UTILITY_PREFERENCES_STORAGE_KEY);
    inMemoryUtilityState = stored && VALID_UTILITY_STATE.test(stored)
      ? stored
      : DEFAULT_UTILITY_STATE;
  } catch {
    // Preferences remain available for this page load when storage is unavailable.
  }
  return inMemoryUtilityState;
}

function decodeUtilityState(state: string): TodayUtilityPreferences {
  const [visibility, activePanel] = state.split(':') as [
    string,
    TodayUtilityPanel,
  ];
  return {
    planOpen: visibility[0] === '1',
    notificationsOpen: visibility[1] === '1',
    activePanel,
  };
}

function encodeUtilityState(preferences: TodayUtilityPreferences): string {
  return `${preferences.planOpen ? '1' : '0'}${preferences.notificationsOpen ? '1' : '0'}:${preferences.activePanel}`;
}

function storeUtilityPreferences(preferences: TodayUtilityPreferences) {
  const state = encodeUtilityState(preferences);
  if (state === readStoredUtilityState()) return;
  inMemoryUtilityState = state;
  try {
    window.localStorage.setItem(UTILITY_PREFERENCES_STORAGE_KEY, state);
  } catch {
    // The preference is optional when storage is unavailable.
  }
  window.dispatchEvent(new Event(UTILITY_PREFERENCES_CHANGE_EVENT));
}

function subscribeToUtilityPreferences(onStoreChange: () => void) {
  const handleChange = () => onStoreChange();
  window.addEventListener('storage', handleChange);
  window.addEventListener(UTILITY_PREFERENCES_CHANGE_EVENT, handleChange);
  return () => {
    window.removeEventListener('storage', handleChange);
    window.removeEventListener(UTILITY_PREFERENCES_CHANGE_EVENT, handleChange);
  };
}

export function TodayUtilityPanels({
  detailOpen,
  todaySidebarProps,
}: TodayUtilityPanelsProps) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const notificationsHook = useNotifications();
  const storedState = useSyncExternalStore(
    subscribeToUtilityPreferences,
    readStoredUtilityState,
    () => DEFAULT_UTILITY_STATE,
  );
  const preferences = decodeUtilityState(storedState);
  const [availableWidth, setAvailableWidth] = useState(0);
  const visibility = resolveTodayUtilityVisibility(
    preferences,
    availableWidth,
    detailOpen,
  );
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

  const setPanelOpen = (panel: TodayUtilityPanel, open: boolean) => {
    const otherPanel: TodayUtilityPanel = panel === 'plan' ? 'notifications' : 'plan';
    const otherOpen = otherPanel === 'plan'
      ? preferences.planOpen
      : preferences.notificationsOpen;
    storeUtilityPreferences({
      ...preferences,
      planOpen: panel === 'plan' ? open : preferences.planOpen,
      notificationsOpen: panel === 'notifications' ? open : preferences.notificationsOpen,
      activePanel: open ? panel : otherOpen ? otherPanel : preferences.activePanel,
    });
  };

  const togglePanel = (panel: TodayUtilityPanel) => {
    const isOpen = panel === 'plan'
      ? preferences.planOpen
      : preferences.notificationsOpen;
    const bothOpen = preferences.planOpen && preferences.notificationsOpen;

    if (detailOpen && !visibility.constrainedDetail && bothOpen && preferences.activePanel !== panel) {
      storeUtilityPreferences({ ...preferences, activePanel: panel });
      return;
    }

    setPanelOpen(panel, !isOpen);
  };

  const planPanel = (className?: string, onCollapse?: () => void) => (
    <TodaySidebar
      {...todaySidebarProps}
      className={className}
      onCollapse={onCollapse}
    />
  );
  const notificationsPanel = (className?: string, onCollapse?: () => void) => (
    <NotificationsPanel
      hook={notificationsHook}
      className={className}
      showHideButton={false}
      onCollapse={onCollapse}
    />
  );

  return (
    <>
      <span ref={anchorRef} className="hidden" aria-hidden="true" />

      {visibility.plan && (
        <div
          className="hidden h-full min-h-0 shrink-0 sm:block"
          onFocusCapture={() => storeUtilityPreferences({ ...preferences, activePanel: 'plan' })}
          onPointerDownCapture={() => storeUtilityPreferences({ ...preferences, activePanel: 'plan' })}
        >
          {planPanel(undefined, () => setPanelOpen('plan', false))}
        </div>
      )}

      {visibility.notifications && (
        <div
          className="hidden h-full min-h-0 shrink-0 sm:block"
          onFocusCapture={() => storeUtilityPreferences({ ...preferences, activePanel: 'notifications' })}
          onPointerDownCapture={() => storeUtilityPreferences({ ...preferences, activePanel: 'notifications' })}
        >
          {notificationsPanel(undefined, () => setPanelOpen('notifications', false))}
        </div>
      )}

      <UtilityRail
        key={visibility.constrainedDetail ? 'temporary' : 'persistent'}
        constrainedDetail={visibility.constrainedDetail}
        notificationBadge={notificationBadge}
        notificationsOpen={preferences.notificationsOpen}
        onTogglePanel={togglePanel}
        planOpen={preferences.planOpen}
        renderNotificationsPanel={(onCollapse) => notificationsPanel('w-full border-l-0', onCollapse)}
        renderPlanPanel={(onCollapse) => planPanel('w-full border-l-0', onCollapse)}
      />
    </>
  );
}

function UtilityRail({
  constrainedDetail,
  notificationBadge,
  notificationsOpen,
  onTogglePanel,
  planOpen,
  renderNotificationsPanel,
  renderPlanPanel,
}: {
  constrainedDetail: boolean;
  notificationBadge: ReturnType<typeof getNotificationBadgeState>;
  notificationsOpen: boolean;
  onTogglePanel: (panel: TodayUtilityPanel) => void;
  planOpen: boolean;
  renderNotificationsPanel: (onCollapse: () => void) => ReactNode;
  renderPlanPanel: (onCollapse: () => void) => ReactNode;
}) {
  const [temporaryPanel, setTemporaryPanel] = useState<TodayUtilityPanel | null>(null);

  useEffect(() => {
    if (!temporaryPanel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTemporaryPanel(null);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [temporaryPanel]);

  const handleToggle = (panel: TodayUtilityPanel) => {
    if (constrainedDetail) {
      setTemporaryPanel((current) => current === panel ? null : panel);
      return;
    }
    onTogglePanel(panel);
  };

  return (
    <aside
      aria-label="My Day utility panes"
      className="relative hidden h-full w-12 shrink-0 flex-col items-center gap-1 border-l border-[var(--border)] bg-[var(--surface-0)] py-3 sm:flex"
    >
      <UtilityRailButton
        active={constrainedDetail ? temporaryPanel === 'plan' : planOpen}
        icon={<Target size={16} aria-hidden="true" />}
        label={constrainedDetail
          ? 'Temporarily show Suggested'
          : planOpen ? 'Collapse Suggested' : 'Open Suggested'}
        onClick={() => handleToggle('plan')}
        pressed={constrainedDetail ? temporaryPanel === 'plan' : planOpen}
      />
      <UtilityRailButton
        active={constrainedDetail ? temporaryPanel === 'notifications' : notificationsOpen}
        badge={notificationBadge}
        icon={<Bell size={16} aria-hidden="true" />}
        label={constrainedDetail
          ? 'Temporarily show Notifications'
          : notificationsOpen ? 'Collapse Notifications' : 'Open Notifications'}
        onClick={() => handleToggle('notifications')}
        pressed={constrainedDetail ? temporaryPanel === 'notifications' : notificationsOpen}
      />

      {constrainedDetail && temporaryPanel && (
        <div className="absolute inset-y-0 right-full z-30 w-[360px] shadow-[var(--shadow-lg)]">
          {temporaryPanel === 'plan'
            ? renderPlanPanel(() => setTemporaryPanel(null))
            : renderNotificationsPanel(() => setTemporaryPanel(null))}
        </div>
      )}
    </aside>
  );
}

function UtilityRailButton({
  active,
  badge,
  icon,
  label,
  onClick,
  pressed,
}: {
  active: boolean;
  badge?: ReturnType<typeof getNotificationBadgeState>;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  pressed: boolean;
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
      aria-pressed={pressed}
      title={label}
    >
      {icon}
      {badge && <NavigationBadge count={badge.count} tone={badge.tone} overlay />}
    </button>
  );
}
