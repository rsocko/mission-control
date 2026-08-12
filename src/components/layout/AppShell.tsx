'use client';

import { useState, useEffect, useRef, ViewTransition } from 'react';
import { usePathname } from 'next/navigation';
import { motion } from 'motion/react';
import { dropdownVariants } from '@/lib/motion';
import { uiLogger } from '@/lib/client-logger';
import {
  Zap,
  Moon,
  ExternalLink,
} from 'lucide-react';
import { QuickAddBar } from '@/components/add-task';
import { SyncButton } from '@/components/toolbar';
import { KeyboardShortcuts } from '@/components/KeyboardShortcuts';
import { DemoModeBanner } from '@/components/DemoModeBanner';
import { DailyCompletionCounter } from '@/components/DailyCompletionCounter';
import { SearchCommand } from '@/components/search/SearchCommand';
import { SyncProgressBanner } from '@/components/layout/SyncProgressBanner';
import { MobileBottomNav } from '@/components/layout/MobileBottomNav';
import { MobileDrawer } from '@/components/layout/MobileDrawer';
import { MobileHeader } from '@/components/layout/MobileHeader';
import { MobileRouteGate } from '@/components/layout/MobileRouteGate';
import { MobileDrawerProvider, useMobileDrawer } from '@/lib/hooks/useMobileDrawer';
import { NavRail } from '@/components/layout/NavRail';
import { PriorityWizardGate } from '@/components/smart-score/PriorityWizardGate';
import { SyncStreamContext, useSyncStreamConnection } from '@/lib/hooks/useSyncStream';
import { SidebarExpandedProvider, useSidebarExpanded } from '@/lib/hooks/useSidebarExpanded';
import { QuickAddProvider } from '@/lib/hooks/useQuickAddContext';
import { useBackgroundAiTasks } from '@/lib/ai/useBackgroundAiTasks';
import { ViewModeProvider, useViewMode } from '@/lib/hooks/useViewMode';
import { ZenMode } from '@/components/ZenMode';
import { CalmMode } from '@/components/CalmMode';
import { DopamineMenu } from '@/components/DopamineMenu';
import { Tooltip } from '@/components/ui/Tooltip';
import { cn } from '@/lib/utils';
import { getMobileTitle, getRouteMetadata } from '@/lib/navigation/route-metadata';
import { getHealthIndicatorTone } from '@/lib/telemetry/health-indicator';
import {
  useSystemHealth,
  type SystemHealthData as HealthData,
} from '@/lib/hooks/useSystemHealth';

interface FeatureFlags {
  taskCreation: boolean;
  aiEnabled: boolean;
  financeEnabled: boolean;
}

function ToolbarRow({
  health,
  showHealthTooltip,
  setShowHealthTooltip,
}: {
  health: HealthData | null;
  showHealthTooltip: boolean;
  setShowHealthTooltip: (v: boolean) => void;
}) {
  const { sidebarMode } = useSidebarExpanded();
  const widthClass = sidebarMode === 'expanded' ? 'w-80' : 'w-56';

  const healthTone = getHealthIndicatorTone(health);
  const healthDotClass = healthTone === 'healthy'
    ? 'bg-[var(--success)]'
    : healthTone === 'critical'
      ? 'bg-[var(--danger)]'
      : healthTone === 'warning'
        ? 'bg-[var(--warning)]'
        : 'bg-[var(--text-tertiary)]';

  return (
    <div className="bg-[var(--surface-0)] border-b border-[var(--border-subtle)] py-2 flex items-center">
      {/* Left: Search command (desktop) */}
      <div className={`${widthClass} flex-shrink-0 pl-4 transition-[width] duration-200`}>
        <SearchCommand />
      </div>
      {/* Center: QuickAddBar */}
      <div className="flex-1 min-w-0 flex justify-center px-4">
        <div className="w-full max-w-2xl">
          <QuickAddBar />
        </div>
      </div>
      {/* Right: actions */}
      <div className="flex items-center gap-1.5 pr-3 flex-shrink-0">
        {/* Open New Window */}
        <Tooltip content="Open in new window">
          <button
            onClick={() => window.open(window.location.href, '_blank')}
            className="flex p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors"
            aria-label="Open new window"
          >
            <ExternalLink size={14} />
          </button>
        </Tooltip>

        <ViewModeButtons />
        <DailyCompletionCounter />

        {/* Health Indicator */}
        <div
          className="relative"
          onMouseEnter={() => setShowHealthTooltip(true)}
          onMouseLeave={() => setShowHealthTooltip(false)}
          onFocus={() => setShowHealthTooltip(true)}
          onBlur={() => setShowHealthTooltip(false)}
        >
          <button
            className="p-1.5 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] rounded-[var(--radius-sm)] hover:bg-[var(--surface-2)] transition-colors focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            aria-label={health?.message || 'System health'}
            aria-describedby={showHealthTooltip ? 'health-tooltip' : undefined}
          >
            <span className={cn("w-2.5 h-2.5 rounded-full inline-block ring-2 ring-[var(--surface-0)]", healthDotClass)} aria-hidden="true" />
          </button>
          {showHealthTooltip && health && (
            <motion.div
              id="health-tooltip"
              role="tooltip"
              className="absolute right-0 top-full mt-1.5 w-64 bg-[var(--surface-2)] border border-[var(--border-strong)] rounded-[var(--radius-lg)] shadow-[var(--shadow-lg)] z-50 p-3"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <div className="flex items-center gap-2 mb-2">
                <span className={cn("w-2 h-2 rounded-full", healthDotClass)} />
                <span className="text-xs font-medium text-[var(--text-primary)]">{health.message}</span>
              </div>
              {health.connectors.filter(c => c.status === 'error' || c.status === 'degraded').length > 0 && (
                <div className="border-t border-[var(--border)] pt-2 mt-2">
                  <p className="text-xs font-medium text-[var(--warning)] uppercase mb-1">Connector Sync Issues</p>
                  <div className="flex flex-col gap-1">
                    {health.connectors
                      .filter(c => c.status === 'error' || c.status === 'degraded')
                      .map(c => (
                        <div key={c.id} className="flex items-center gap-1.5">
                          <span className={cn("w-1.5 h-1.5 rounded-full shrink-0", c.status === 'error' ? 'bg-red-500' : 'bg-yellow-500')} />
                          <span className="text-xs text-[var(--text-primary)]">{c.name}</span>
                          {c.lastSyncAt && (
                            <span className="text-[11px] text-[var(--text-tertiary)] ml-auto">
                              {new Date(c.lastSyncAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </span>
                          )}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {health.disabledFeatures.length > 0 && (
                <div className="border-t border-[var(--border)] pt-2 mt-2">
                  <p className="text-xs font-medium text-[var(--text-tertiary)] uppercase mb-1">Disabled Features</p>
                  <div className="flex flex-wrap gap-1">
                    {health.disabledFeatures.map(f => (
                      <span key={f} className="text-xs px-1.5 py-0.5 rounded-[var(--radius-sm)] bg-[var(--surface-3)] text-[var(--text-tertiary)]">
                        {f}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}
        </div>

        <SyncButton />
      </div>
    </div>
  );
}

function ViewModeButtons() {
  const { viewMode, toggleZen, toggleCalm } = useViewMode();
  return (
    <div className="flex items-center gap-1">
      <Tooltip content="Zen Mode" shortcut="Z">
        <button
          onClick={toggleZen}
          className={cn(
            "flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-[var(--radius-md)] transition-colors duration-100",
            viewMode === 'zen'
              ? "text-blue-400 bg-blue-900/30"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          )}
        >
          <Zap size={13} />
          <span className="hidden lg:inline">Zen</span>
        </button>
      </Tooltip>
      <Tooltip content="Calm Mode" shortcut="C">
        <button
          onClick={() => toggleCalm()}
          className={cn(
            "flex items-center gap-1 px-2 py-1.5 text-xs font-medium rounded-[var(--radius-md)] transition-colors duration-100",
            viewMode === 'calm'
              ? "text-purple-400 bg-purple-900/30"
              : "text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--surface-2)]"
          )}
        >
          <Moon size={13} />
          <span className="hidden lg:inline">Calm</span>
        </button>
      </Tooltip>
    </div>
  );
}

// Routes that render without the AppShell chrome (standalone pages)
const STANDALONE_ROUTES = ['/icons'];

export function AppShell({ children }: { children: React.ReactNode }) {
  const syncContextValue = useSyncStreamConnection();
  const pathname = usePathname();
  const [features, setFeatures] = useState<FeatureFlags | null>(null);
  const { isAiActive } = useBackgroundAiTasks();
  const [showHealthTooltip, setShowHealthTooltip] = useState(false);
  const isStandalone = STANDALONE_ROUTES.some(r => pathname.startsWith(r));
  const health = useSystemHealth(!isStandalone);

  // Mark first client-side navigation so view-transition animations only
  // play after the initial load (prevents the "flash" on hard reload).
  const initialPathRef = useRef(pathname);
  useEffect(() => {
    if (pathname !== initialPathRef.current) {
      document.documentElement.setAttribute('data-navigated', '');
    }
  }, [pathname]);

  useEffect(() => {
    if (isStandalone) return;
    fetch('/api/features').then(r => r.json()).then(setFeatures).catch((err) => { uiLogger.error('Failed to fetch feature flags', { err }); });
  }, [isStandalone]);

  // Standalone routes bypass the shell entirely
  if (isStandalone) {
    return <>{children}</>;
  }

  return (
    <ViewModeProvider>
    <SidebarExpandedProvider>
    <QuickAddProvider>
    <SyncStreamContext.Provider value={syncContextValue}>
    <MobileDrawerProvider>
    <AppShellInner
      features={features}
      isAiActive={isAiActive}
      health={health}
      showHealthTooltip={showHealthTooltip}
      setShowHealthTooltip={setShowHealthTooltip}
      syncProgress={syncContextValue.progress}
    >
      {children}
    </AppShellInner>
    </MobileDrawerProvider>
    </SyncStreamContext.Provider>
    </QuickAddProvider>
    </SidebarExpandedProvider>
    </ViewModeProvider>
  );
}

function AppShellInner({
  features,
  isAiActive,
  health,
  showHealthTooltip,
  setShowHealthTooltip,
  syncProgress,
  children,
}: {
  features: FeatureFlags | null;
  isAiActive: boolean;
  health: HealthData | null;
  showHealthTooltip: boolean;
  setShowHealthTooltip: (v: boolean) => void;
  syncProgress: import('@/lib/hooks/useSyncStream').SyncProgress;
  children: React.ReactNode;
}) {
  const { isDrawerOpen, openDrawer, closeDrawer } = useMobileDrawer();
  const pathname = usePathname();
  const mobileTitle = getMobileTitle(pathname);
  const routeMetadata = getRouteMetadata(pathname);
  const mobileMenuButtonRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-screen bg-[var(--background)]">
      <PriorityWizardGate />
      <KeyboardShortcuts />
      <DopamineMenu />

      {/* Left Nav Rail (desktop only) */}
      <NavRail features={features} isAiActive={isAiActive} />

      {/* Right area: toolbar + content */}
      <div className="flex flex-col flex-1 min-w-0 min-h-0 overflow-hidden">
        <DemoModeBanner />

        {/* Mobile Header (F-11/F-12/F-13/F-14) */}
        <MobileHeader
          title={mobileTitle}
          onMenuPress={openDrawer}
          menuButtonRef={mobileMenuButtonRef}
          isDrawerOpen={isDrawerOpen}
        />

        {/* Toolbar: Search + Quick Add + Actions (desktop only) */}
        {features?.taskCreation !== false && (
          <div className="relative z-40 hidden sm:block">
            <ToolbarRow
              health={health}
              showHealthTooltip={showHealthTooltip}
              setShowHealthTooltip={setShowHealthTooltip}
            />
          </div>
        )}

        {/* Sync Progress Banner */}
        <SyncProgressBanner progress={syncProgress} />

        {/* Main Content — wrapped in ViewTransition for smooth tab navigation */}
        <ViewTransition name="main-content">
          <main
            id="main-content"
            className="flex-1 overflow-hidden bg-[var(--background)] pb-[calc(3.5rem+var(--safe-area-inset-bottom)+1px)] sm:pb-0"
          >
            <MobileRouteGate route={routeMetadata}>
              {children}
            </MobileRouteGate>
          </main>
        </ViewTransition>

        {/* Mobile Bottom Navigation */}
        <MobileBottomNav />

      </div>

      {/* Mobile Slide-out Drawer */}
      <MobileDrawer
        isOpen={isDrawerOpen}
        onClose={closeDrawer}
        returnFocusRef={mobileMenuButtonRef}
        features={features}
      />

      {/* Zen & Calm Mode Overlays */}
      <ZenMode />
      <CalmMode />
    </div>
  );
}