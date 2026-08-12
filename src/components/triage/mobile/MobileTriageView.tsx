'use client';

import { useState, useCallback, useMemo } from 'react';
import { AnimatePresence, useReducedMotion } from 'motion/react';
import type {
  TriageActionRecord,
  TriageActionType,
  TriageItem,
  TriageSourcePlatform,
} from '@/types';
import MobileTriageFocus from './MobileTriageFocus';
import MobileTriageStream from './MobileTriageStream';
import MobileTriageItemDetail from './MobileTriageItemDetail';
import MobileTriageEmpty from './MobileTriageEmpty';

// ─── Types ──────────────────────────────────────────────────────────────────

type MobileTriageMode = 'stream' | 'focus';

interface MobileTriageViewProps {
  items: TriageItem[];
  loading: boolean;
  onAction: (
    id: string,
    actionType: TriageActionType,
    options?: { showSuccessToast?: boolean },
  ) => Promise<TriageActionRecord | null>;
  onUndoAction: (id: string, action: TriageActionRecord) => Promise<boolean>;
  busyAction: string | null;
  onRefresh?: () => Promise<void>;
  stats?: {
    processedToday: number;
    streak: number;
    totalProcessed: number;
  };
}

// ─── Component ──────────────────────────────────────────────────────────────

export default function MobileTriageView({
  items,
  loading,
  onAction,
  onUndoAction,
  busyAction,
  onRefresh,
  stats,
}: MobileTriageViewProps) {
  const [mode, setMode] = useState<MobileTriageMode>('stream');
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [sourceFilter, setSourceFilter] = useState<TriageSourcePlatform | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const prefersReducedMotion = useReducedMotion() ?? false;

  const selectedItem = useMemo(
    () => items.find((i) => i.id === selectedItemId) ?? null,
    [items, selectedItemId],
  );

  const handleItemTap = useCallback((id: string) => {
    setSelectedItemId(id);
  }, []);

  const handleCloseDetail = useCallback(() => {
    setSelectedItemId(null);
  }, []);

  const handleSwitchToFocus = useCallback(() => {
    setMode('focus');
  }, []);

  const handleSwitchToStream = useCallback(() => {
    setMode('stream');
  }, []);

  // Empty state: no items and not loading
  if (!loading && items.length === 0) {
    return (
      <MobileTriageEmpty
        stats={stats ?? { processedToday: 0, streak: 0, totalProcessed: 0 }}
        onCheckLater={undefined}
        onBrowseArchive={undefined}
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-slate-950">
      {mode === 'stream' ? (
        <MobileTriageStream
          items={items}
          loading={loading}
          onItemTap={handleItemTap}
          onSwitchToFocus={handleSwitchToFocus}
          onRefresh={onRefresh}
          activeSourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          activeTypeFilter={typeFilter}
          onTypeFilterChange={setTypeFilter}
        />
      ) : (
        <MobileTriageFocus
          items={items}
          onAction={onAction}
          onUndoAction={onUndoAction}
          busyAction={busyAction}
          loading={loading}
          onSwitchToStream={handleSwitchToStream}
        />
      )}

      {/* Bottom sheet detail view (F-45: opens on card tap from stream) */}
      <AnimatePresence initial={!prefersReducedMotion}>
        {selectedItem && (
          <MobileTriageItemDetail
            item={selectedItem}
            onClose={handleCloseDetail}
            onAction={onAction}
            busyAction={busyAction}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
