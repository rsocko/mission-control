'use client';

import { useRef, useState } from 'react';
import { FolderInput, ChevronDown, Search } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useClickOutside } from '@/lib/hooks/useClickOutside';

export interface SourceList {
  id: string;
  name: string;
  sourceId?: string;
}

export interface MoveToListDropdownProps {
  /** Available source lists to move to. */
  sourceLists: SourceList[];
  /** Current task's source list ID (excluded from options). */
  currentSourceListId?: string | null;
  /** Called when user selects a target list. */
  onMoveToList: (targetListId: string) => void;
}

/**
 * Dropdown for moving a task to a different list.
 * Shows a searchable list of available destinations.
 */
export function MoveToListDropdown({
  sourceLists,
  currentSourceListId,
  onMoveToList,
}: MoveToListDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useClickOutside(ref, () => { setIsOpen(false); setSearch(''); }, isOpen);

  const filtered = search
    ? sourceLists.filter((l) => l.name.toLowerCase().includes(search.toLowerCase()))
    : sourceLists;
  const listsToShow = filtered.filter((l) => l.sourceId !== currentSourceListId);

  return (
    <div className="relative" ref={ref}>
      <div className="min-w-0">
        <button
          onClick={() => { setIsOpen(!isOpen); setSearch(''); }}
          className="flex min-h-9 items-center gap-1.5 rounded-lg border border-[var(--border-subtle)] px-2.5 text-xs text-[var(--text-muted)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-secondary)]"
        >
          <FolderInput size={13} />
          Move list
          <ChevronDown size={11} className={`transition-transform duration-100 ${isOpen ? 'rotate-180' : ''}`} />
        </button>

        <AnimatePresence>
          {isOpen && (
            <motion.div
              className="absolute left-0 top-full mt-1 w-56 bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-2xl z-20 overflow-hidden"
              initial={{ opacity: 0, y: -4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -4, scale: 0.98 }}
              transition={{ duration: 0.12 }}
            >
              <div className="px-2 pt-2 pb-1.5">
                <div className="input-glow flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-0)] px-2 py-1">
                  <Search size={12} className="shrink-0 text-[var(--text-muted)]" />
                  <input
                    type="text"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search lists…"
                    className="w-full bg-transparent text-xs text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
                    autoFocus
                  />
                </div>
              </div>
              <div className="max-h-52 overflow-y-auto py-1">
                {listsToShow.length === 0 ? (
                  <div className="px-3 py-2 text-xs text-[var(--text-muted)]">No lists found</div>
                ) : (
                  listsToShow.map((list) => (
                    <button
                      key={list.id}
                      onClick={() => {
                        onMoveToList(list.id);
                        setIsOpen(false);
                        setSearch('');
                      }}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-xs text-[var(--text-primary)] text-left hover:bg-[var(--surface-2)] transition-colors duration-75"
                    >
                      {list.name}
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
