'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import type { ComponentType } from 'react';
import { Bookmark, ChevronDown, ListChecks, PinOff } from 'lucide-react';
import { IconRenderer } from '@rsocko/icon-picker/renderer';
import { ConnectorIcon } from '@/components/sources/SourceIcons';
import { Tooltip } from '@/components/ui/Tooltip';
import { useTaskShortcuts } from '@/lib/hooks/useTaskShortcuts';
import {
  buildTaskShortcutHref,
  recordRecentTaskShortcut,
  type TaskShortcut,
} from '@/lib/navigation/task-shortcuts';
import { useHoverMenu } from '@/lib/hooks/useHoverMenu';
import { cn } from '@/lib/utils';

interface TaskShortcutsNavItemProps {
  active: boolean;
  expanded: boolean;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor?: string;
  open: boolean;
  onNavigate: () => void;
  onOpenChange: (open: boolean) => void;
}

export function TaskShortcutIcon({
  shortcut,
  size = 16,
}: {
  shortcut: TaskShortcut;
  size?: number;
}) {
  if (shortcut.connectorType) {
    return <ConnectorIcon connectorType={shortcut.connectorType} size={size} />;
  }
  return (
    <IconRenderer
      value={shortcut.icon}
      size={size}
      color={shortcut.iconColor}
      fallback={shortcut.kind === 'saved-view'
        ? <Bookmark size={size} />
        : <ListChecks size={size} />}
    />
  );
}

export function TaskShortcutMenuItem({
  shortcut,
  pinned,
  onNavigate,
  onUnpin,
}: {
  shortcut: TaskShortcut;
  pinned?: boolean;
  onNavigate: () => void;
  onUnpin?: () => void;
}) {
  return (
    <div className="group flex items-center rounded-lg outline-none data-[highlighted]:bg-[var(--surface-2)]">
      <DropdownMenu.Item
        asChild
        onSelect={() => {
          recordRecentTaskShortcut(shortcut);
          onNavigate();
        }}
      >
        <Link
          href={buildTaskShortcutHref(shortcut)}
          className="flex min-w-0 flex-1 cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]"
        >
          <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
            <TaskShortcutIcon shortcut={shortcut} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate">{shortcut.label}</span>
            <span className="block truncate text-xs text-[var(--text-muted)]">{shortcut.detail}</span>
          </span>
        </Link>
      </DropdownMenu.Item>
      {pinned && onUnpin ? (
        <DropdownMenu.Item
          asChild
          onSelect={(event) => {
            event.preventDefault();
            onUnpin();
          }}
        >
          <button
            type="button"
            className="mr-1 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-muted)] opacity-0 outline-none transition-opacity hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:opacity-100 data-[highlighted]:bg-[var(--surface-3)] data-[highlighted]:text-[var(--text-primary)] group-hover:opacity-100"
            aria-label={`Unpin ${shortcut.label}`}
            title={`Unpin ${shortcut.label}`}
          >
            <PinOff size={14} />
          </button>
        </DropdownMenu.Item>
      ) : null}
    </div>
  );
}

export function TaskShortcutsNavItem({
  active,
  expanded,
  icon: Icon,
  iconColor,
  open,
  onNavigate,
  onOpenChange,
}: TaskShortcutsNavItemProps) {
  const { pinned, recent, pinnedIds, togglePinned } = useTaskShortcuts();
  const unpinnedRecent = recent.filter((shortcut) => !pinnedIds.has(shortcut.id));
  const { openOnHover, closeAfterHover } = useHoverMenu({
    enabled: expanded,
    onOpenChange,
  });

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <div
        onMouseEnter={openOnHover}
        onMouseLeave={closeAfterHover}
        className={cn(
          'relative mx-2 flex h-10 items-center rounded-lg text-[13px] font-medium transition-colors duration-200',
          active
            ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
            : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
        )}
      >
        <Tooltip content="All Tasks" placement="right" disabled={expanded}>
          <Link
            href="/all-tasks"
            aria-current={active ? 'page' : undefined}
            className="relative flex h-10 min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2.5 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-1)]"
          >
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-[var(--accent)]" />
            )}
            <span className="relative flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center">
              <Icon
                size={22}
                className={cn(
                  'flex-shrink-0',
                  iconColor && (active ? iconColor.replace('400', '300') : iconColor),
                )}
              />
            </span>
            <span
              className={cn(
                'overflow-hidden text-ellipsis whitespace-nowrap transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                expanded ? 'max-w-[112px] opacity-100' : 'max-w-0 opacity-0',
              )}
            >
              All Tasks
            </span>
          </Link>
        </Tooltip>

        {expanded && (
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              aria-label="Open task shortcuts"
              title="Pinned and recent task lists"
              className="mr-1 flex h-8 w-7 flex-shrink-0 items-center justify-center rounded-md text-[var(--text-tertiary)] hover:bg-[var(--surface-3)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            >
              <ChevronDown size={15} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
        )}
      </div>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label="Task shortcuts"
          aria-labelledby={undefined}
          onMouseEnter={openOnHover}
          onMouseLeave={closeAfterHover}
          className="z-50 w-72 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1.5 shadow-2xl"
        >
          <DropdownMenu.Label className="px-2.5 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Pinned
          </DropdownMenu.Label>
          {pinned.length === 0 ? (
            <div className="px-2.5 py-2 text-xs leading-5 text-[var(--text-muted)]">
              Pin a source, list, or saved view from the task sidebar.
            </div>
          ) : pinned.map((shortcut) => (
            <TaskShortcutMenuItem
              key={shortcut.id}
              shortcut={shortcut}
              pinned
              onNavigate={onNavigate}
              onUnpin={() => togglePinned(shortcut)}
            />
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          <DropdownMenu.Label className="px-2.5 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            Recent
          </DropdownMenu.Label>
          {unpinnedRecent.length === 0 ? (
            <div className="px-2.5 py-2 text-xs leading-5 text-[var(--text-muted)]">
              Task lists and saved views you open will appear here.
            </div>
          ) : unpinnedRecent.map((shortcut) => (
            <TaskShortcutMenuItem
              key={shortcut.id}
              shortcut={shortcut}
              onNavigate={onNavigate}
            />
          ))}

          <DropdownMenu.Separator className="my-1 h-px bg-[var(--border)]" />
          <DropdownMenu.Item onSelect={onNavigate} asChild>
            <Link
              href="/all-tasks"
              className="flex cursor-default items-center rounded-lg px-2.5 py-2 text-xs font-medium text-[var(--accent-400)] outline-none data-[highlighted]:bg-[var(--surface-2)]"
            >
              View all tasks
            </Link>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
