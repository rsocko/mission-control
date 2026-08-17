'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ClipboardList, Search } from 'lucide-react';
import { CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';
import { dropdownVariants } from '@/lib/motion';
import type { QuickAddDestination } from './quick-add-types';

export interface QuickAddDestinationGroup {
  label: string;
  connectorType?: string;
  destinations: QuickAddDestination[];
}

export function groupQuickAddDestinations(
  destinations: QuickAddDestination[],
  search: string,
): QuickAddDestinationGroup[] {
  const query = search.toLowerCase().trim();
  const filtered = query
    ? destinations.filter((destination) =>
        [
          destination.shortLabel,
          destination.label,
          destination.listName,
          destination.groupName,
          destination.connectorType,
        ]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(query)
      )
    : destinations;
  const sources = filtered.filter((destination) => !destination.listId);
  const lists = filtered.filter((destination) => destination.listId);
  const groups: QuickAddDestinationGroup[] = [];

  if (sources.length > 0) {
    groups.push({
      label: 'Sources',
      destinations: [...sources].sort((a, b) =>
        (a.shortLabel ?? a.label).localeCompare(b.shortLabel ?? b.label)
      ),
    });
  }

  const byConnector = new Map<string, QuickAddDestination[]>();
  for (const destination of lists) {
    const entries = byConnector.get(destination.id) ?? [];
    entries.push(destination);
    byConnector.set(destination.id, entries);
  }

  for (const [connectorId, connectorLists] of byConnector) {
    const parentSource = destinations.find(
      (destination) => destination.id === connectorId && !destination.listId,
    );
    const connectorLabel = parentSource?.shortLabel || parentSource?.label || connectorId;
    const connectorType = parentSource?.connectorType || connectorLists[0]?.connectorType;
    const byGroup = new Map<string, QuickAddDestination[]>();
    const ungrouped: QuickAddDestination[] = [];

    for (const destination of connectorLists) {
      if (destination.groupName) {
        const entries = byGroup.get(destination.groupName) ?? [];
        entries.push(destination);
        byGroup.set(destination.groupName, entries);
      } else {
        ungrouped.push(destination);
      }
    }

    const sortedGroupNames = [...byGroup.keys()].sort((a, b) => {
      const aOrder = byGroup.get(a)?.[0]?.groupSortOrder ?? Infinity;
      const bOrder = byGroup.get(b)?.[0]?.groupSortOrder ?? Infinity;
      return aOrder === bOrder ? a.localeCompare(b) : aOrder - bOrder;
    });
    for (const groupName of sortedGroupNames) {
      groups.push({
        label: `${connectorLabel} › ${groupName}`,
        connectorType,
        destinations: [...(byGroup.get(groupName) ?? [])].sort(
          (a, b) => (a.shortLabel ?? a.label).localeCompare(b.shortLabel ?? b.label),
        ),
      });
    }
    if (ungrouped.length > 0) {
      groups.push({
        label: sortedGroupNames.length > 0 ? `${connectorLabel} › Other` : connectorLabel,
        connectorType,
        destinations: [...ungrouped].sort(
          (a, b) => (a.shortLabel ?? a.label).localeCompare(b.shortLabel ?? b.label),
        ),
      });
    }
  }

  return groups;
}

function ConnectorIcon({ type, size = 14 }: { type: string; size?: number }) {
  const source = CONNECTOR_ICON_PATHS[type];
  return source
    ? <Image src={source} alt={type} width={size} height={size} className="flex-shrink-0" />
    : <ClipboardList size={size} className="flex-shrink-0 text-[var(--text-muted)]" />;
}

export function DestinationPicker({
  open,
  destinations,
  selectedDestination,
  onSelect,
  onClose,
}: {
  open: boolean;
  destinations: QuickAddDestination[];
  selectedDestination: QuickAddDestination;
  onSelect: (destination: QuickAddDestination) => void;
  onClose: () => void;
}) {
  const [search, setSearch] = useState('');
  const [navigationIndex, setNavigationIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const groups = useMemo(
    () => groupQuickAddDestinations(destinations, search),
    [destinations, search],
  );
  const flatDestinations = useMemo(
    () => groups.flatMap((group) => group.destinations),
    [groups],
  );
  const groupStartIndices = useMemo(() => {
    return groups.map((_, groupIndex) =>
      groups
        .slice(0, groupIndex)
        .reduce((offset, group) => offset + group.destinations.length, 0)
    );
  }, [groups]);
  const safeNavigationIndex = Math.min(
    navigationIndex,
    Math.max(flatDestinations.length - 1, 0),
  );

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      setSearch('');
      setNavigationIndex(0);
      searchRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    scrollRef.current
      ?.querySelector(`[data-dest-idx="${safeNavigationIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [safeNavigationIndex, open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="absolute right-0 top-full z-50 mt-1.5 flex max-h-[min(420px,calc(100vh-120px))] w-72 flex-col overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--surface-1)] shadow-[var(--shadow-lg)]"
          variants={dropdownVariants}
          initial="hidden"
          animate="show"
          exit="exit"
        >
          <div className="px-2.5 pt-2.5 pb-1.5">
            <div className="input-glow flex items-center gap-2 px-2.5 py-1.5 bg-[var(--surface-0)] border border-[var(--border)] rounded-lg">
              <Search size={13} className="text-[var(--text-muted)] flex-shrink-0" />
              <input
                ref={searchRef}
                type="text"
                value={search}
                onChange={(event) => {
                  setSearch(event.target.value);
                  setNavigationIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    setNavigationIndex(
                      Math.min(safeNavigationIndex + 1, flatDestinations.length - 1),
                    );
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    setNavigationIndex(Math.max(safeNavigationIndex - 1, 0));
                  } else if (event.key === 'Enter' && flatDestinations.length > 0) {
                    event.preventDefault();
                    const destination = flatDestinations[safeNavigationIndex];
                    if (destination) onSelect(destination);
                  } else if (event.key === 'Escape') {
                    event.preventDefault();
                    onClose();
                  }
                }}
                placeholder="Search destinations..."
                className="flex-1 bg-transparent text-xs text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none shadow-none border-none"
              />
            </div>
          </div>

          <div ref={scrollRef} className="overflow-y-auto flex-1 min-h-0">
            {groups.length === 0 && (
              <div className="px-3 py-4 text-xs text-[var(--text-muted)] text-center">
                No matching destinations
              </div>
            )}
            {groups.map((group, groupIndex) => {
              const groupStartIndex = groupStartIndices[groupIndex] ?? 0;
              return (
                <div key={group.label}>
                  <div className="px-3 pt-2 pb-1 text-[12px] font-semibold text-[var(--text-muted)] uppercase tracking-wider flex items-center gap-1.5 sticky top-0 bg-[var(--surface-1)]">
                    {group.connectorType && (
                      <ConnectorIcon type={group.connectorType} size={11} />
                    )}
                    <span className="truncate">{group.label}</span>
                  </div>
                  {group.destinations.map((destination, index) => {
                    const flatIndex = groupStartIndex + index;
                    const isNavigationTarget = flatIndex === safeNavigationIndex;
                    const isSelected =
                      selectedDestination.id === destination.id
                      && selectedDestination.listId === destination.listId;
                    return (
                      <button
                        key={`${destination.id}-${destination.listId || 'default'}`}
                        data-dest-idx={flatIndex}
                        onClick={() => onSelect(destination)}
                        onMouseEnter={() => setNavigationIndex(flatIndex)}
                        className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-sm text-left transition-colors ${
                          isNavigationTarget
                            ? 'bg-[var(--accent)]/10 text-[var(--text-primary)]'
                            : isSelected
                              ? 'bg-[var(--surface-2)]'
                              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-0)]'
                        }`}
                      >
                        <ConnectorIcon type={destination.connectorType} size={14} />
                        <span className="flex-1 min-w-0">
                          <span className="block text-xs text-[var(--text-primary)] truncate">
                            {destination.shortLabel ?? destination.label}
                          </span>
                          {destination.shortLabel && destination.shortLabel !== destination.label && (
                            <span className="block text-[12px] text-[var(--text-muted)] truncate">
                              {destination.label}
                            </span>
                          )}
                        </span>
                        {isSelected && (
                          <span className="text-blue-400 text-xs flex-shrink-0">
                            <Check size={12} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })}
          </div>

          <div className="border-t border-[var(--border-subtle)] px-3 py-2 text-xs text-[var(--text-muted)]">
            💡 Type <code className="text-blue-400">@work</code> or <code className="text-green-400">@github</code> to auto-select · <code className="text-purple-400">/list</code> to pick a list
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
