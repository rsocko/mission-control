'use client';

import { useMemo } from 'react';
import Image from 'next/image';
import { ChevronDown, List } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { dropdownVariants } from '@/lib/motion';
import type { SourceItem } from './types';

interface SourcesDropdownProps {
  sources: SourceItem[];
  selectedSources: string[];
  showDropdown: boolean;
  onToggleDropdown: () => void;
  onCloseDropdown: () => void;
  onToggleSource: (sourceId: string) => void;
  onClear: () => void;
}

export function SourcesDropdown({
  sources,
  selectedSources,
  showDropdown,
  onToggleDropdown,
  onCloseDropdown,
  onToggleSource,
  onClear,
}: SourcesDropdownProps) {
  const { connectors, lists, listsByConnector } = useMemo(() => {
    const c = sources.filter(s => s.type === 'connector');
    const l = sources.filter(s => s.type === 'list');

    const byConnector = new Map<string, SourceItem[]>();
    for (const list of l) {
      const existing = byConnector.get(list.connectorType) || [];
      existing.push(list);
      byConnector.set(list.connectorType, existing);
    }

    return { connectors: c, lists: l, listsByConnector: byConnector };
  }, [sources]);

  return (
    <div className="relative">
      <button
        onClick={onToggleDropdown}
        className="text-sm border border-[var(--border)] rounded-md px-3 py-1.5 text-[var(--text-secondary)] hover:bg-[var(--surface-1)] flex items-center gap-2"
      >
        {selectedSources.length === 0 ? 'All Sources' : `${selectedSources.length} Source${selectedSources.length > 1 ? 's' : ''}`}
        <ChevronDown size={12} className={`transition-transform ${showDropdown ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {showDropdown && (
          <>
            <div className="fixed inset-0 z-40" onClick={onCloseDropdown} />
            <motion.div
              className="absolute top-full left-0 mt-1 z-50 bg-[var(--surface-1)] border border-[var(--border)] rounded-lg shadow-xl py-1 w-64 max-h-80 overflow-y-auto"
              variants={dropdownVariants}
              initial="hidden"
              animate="show"
              exit="exit"
            >
              <button
                onClick={() => { onClear(); onCloseDropdown(); }}
                className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--surface-2)] ${
                  selectedSources.length === 0 ? 'text-blue-400 font-medium' : 'text-[var(--text-secondary)]'
                }`}
              >
                All Sources
              </button>
              {connectors.length > 0 && (
                <>
                  <div className="border-t border-[var(--border-subtle)] my-1" />
                  <div className="px-3 py-1 text-[12px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
                    Sources
                  </div>
                  {connectors.map(src => (
                    <button
                      key={src.id}
                      onClick={() => onToggleSource(src.id)}
                      className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
                    >
                      <input
                        type="checkbox"
                        checked={selectedSources.includes(src.id)}
                        readOnly
                        className="w-3.5 h-3.5 rounded border-[var(--border-strong)] text-blue-600 cursor-pointer"
                      />
                      {src.icon ? (
                        <Image src={src.icon} alt={src.name} width={14} height={14} />
                      ) : (
                        <List size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                      )}
                      <span>{src.name}</span>
                    </button>
                  ))}
                </>
              )}
              {lists.length > 0 && (
                <>
                  <div className="border-t border-[var(--border-subtle)] my-1" />
                  <div className="px-3 py-1 text-[12px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
                    Lists
                  </div>
                  {connectors.map(connector => {
                    const connectorLists = listsByConnector.get(connector.connectorType);
                    if (!connectorLists || connectorLists.length === 0) return null;
                    return (
                      <div key={`lists-${connector.id}`}>
                        {connectorLists.map(list => (
                          <button
                            key={list.id}
                            onClick={() => onToggleSource(list.id)}
                            className="w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-[var(--surface-2)] text-[var(--text-secondary)]"
                          >
                            <input
                              type="checkbox"
                              checked={selectedSources.includes(list.id)}
                              readOnly
                              className="w-3.5 h-3.5 rounded border-[var(--border-strong)] text-blue-600 cursor-pointer"
                            />
                            <List size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                            <span className="truncate">{list.name}</span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
              {selectedSources.length > 0 && (
                <>
                  <div className="border-t border-[var(--border-subtle)] my-1" />
                  <button
                    onClick={onClear}
                    className="w-full text-left px-3 py-1.5 text-xs text-[var(--text-muted)] hover:bg-[var(--surface-2)]"
                  >
                    Clear filters
                  </button>
                </>
              )}
            </motion.div>
          </>
        )}
      </AnimatePresence>
    </div>
  );
}
