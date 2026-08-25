'use client';

import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import Link from 'next/link';
import { ChevronRight, type LucideIcon } from 'lucide-react';
import { NavigationBadge, NavigationRailMorph } from '@/components/layout/NavigationBadge';
import type { NavigationBadgePreferences } from '@/lib/hooks/useNavigationBadges';
import type {
  NavBadgeKey,
  NavBadgeTone,
  NavigationCounts,
} from '@/lib/navigation/badges';
import { cn } from '@/lib/utils';

import type { ComponentType } from 'react';

export interface AdaptiveNavItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor?: string;
  iconSize?: number;
  requiresFeature?: 'aiEnabled' | 'financeEnabled';
  badgeKey?: NavBadgeKey;
  badgeTone?: NavBadgeTone;
}

export interface AdaptiveNavAction {
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  iconClassName?: string;
}

interface ItemBadge {
  count: number;
  tone: NavBadgeTone;
  pulse: boolean;
}

function getItemBadge(item: AdaptiveNavItem, counts: NavigationCounts): ItemBadge | null {
  if (!item.badgeKey) return null;
  const tone = item.badgeKey === 'notifications'
    ? counts.notificationTone
    : item.badgeTone;
  if (!tone) return null;

  return {
    count: counts[item.badgeKey],
    tone,
    pulse: item.badgeKey === 'notifications' && counts.notificationTone === 'red',
  };
}

function aggregateBadges(
  items: AdaptiveNavItem[],
  counts: NavigationCounts,
  preferences: NavigationBadgePreferences,
): ItemBadge | null {
  const badges = items
    .filter((item) => item.badgeKey && preferences.items[item.badgeKey])
    .map((item) => getItemBadge(item, counts))
    .filter((badge): badge is ItemBadge => badge !== null && badge.count > 0);

  if (!preferences.enabled || badges.length === 0) return null;

  const tone = badges.some((badge) => badge.tone === 'red')
    ? 'red'
    : badges.some((badge) => badge.tone === 'amber')
      ? 'amber'
      : 'blue';

  return {
    count: badges.reduce((total, badge) => total + badge.count, 0),
    tone,
    pulse: badges.some((badge) => badge.pulse),
  };
}

export function AdaptiveNavGroup({
  groupKey,
  label,
  icon: GroupIcon,
  items,
  expanded,
  counts,
  preferences,
  isActive,
  open,
  onOpenChange,
  actions = [],
}: {
  groupKey: string;
  label: string;
  icon: LucideIcon;
  items: AdaptiveNavItem[];
  expanded: boolean;
  counts: NavigationCounts;
  preferences: NavigationBadgePreferences;
  isActive: (href: string) => boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions?: AdaptiveNavAction[];
}) {
  const active = items.some((item) => isActive(item.href));
  const aggregateBadge = aggregateBadges(items, counts, preferences);

  return (
    <DropdownMenu.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          aria-label={`Open ${label} navigation`}
          title={expanded ? undefined : label}
          data-active-child={active || undefined}
          className={cn(
            'relative mx-2 flex h-10 w-[calc(100%_-_1rem)] items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition-colors duration-200 focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-1 focus-visible:ring-offset-[var(--surface-1)]',
            active
              ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
              : 'text-[var(--text-secondary)] hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)]',
          )}
        >
            {active && (
              <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-r-sm bg-[var(--accent)]" />
            )}
            <span className="relative flex h-[22px] w-[22px] flex-shrink-0 items-center justify-center">
              <GroupIcon size={20} className="flex-shrink-0 text-[var(--text-tertiary)]" />
            </span>
            <span
              className={cn(
                'overflow-hidden text-ellipsis whitespace-nowrap transition-[opacity,max-width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]',
                expanded ? 'max-w-[112px] opacity-100' : 'max-w-0 opacity-0',
              )}
            >
              {label}
            </span>
            {expanded && !aggregateBadge && (
              <ChevronRight
                size={14}
                aria-hidden="true"
                className="ml-auto flex-shrink-0 text-[var(--text-muted)]"
              />
            )}
            {aggregateBadge && (
              <NavigationRailMorph
                count={aggregateBadge.count}
                tone={aggregateBadge.tone}
                expanded={expanded}
                pulse={aggregateBadge.pulse}
                morphId={`group-${groupKey}`}
              />
            )}
        </button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="start"
          sideOffset={8}
          collisionPadding={12}
          aria-label={`${label} navigation`}
          aria-labelledby={undefined}
          className="z-50 w-60 rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-1.5 shadow-2xl"
        >
          <DropdownMenu.Label className="px-2.5 pb-1.5 pt-1 text-xs font-semibold uppercase tracking-wide text-[var(--text-tertiary)]">
            {label}
          </DropdownMenu.Label>
          {actions.map((action) => {
            const ActionIcon = action.icon;
            return (
              <DropdownMenu.Item key={action.label} asChild onSelect={action.onSelect}>
                <button
                  type="button"
                  className="flex w-full cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm text-[var(--text-secondary)] outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]"
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <ActionIcon
                      size={18}
                      className={cn('flex-shrink-0', action.iconClassName)}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{action.label}</span>
                </button>
              </DropdownMenu.Item>
            );
          })}
          {items.map((item) => {
            const itemActive = isActive(item.href);
            const badge = getItemBadge(item, counts);
            const showBadge = preferences.enabled
              && item.badgeKey
              && preferences.items[item.badgeKey]
              && badge;
            const Icon = item.icon;

            return (
              <DropdownMenu.Item key={item.href} asChild>
                <Link
                  href={item.href}
                  aria-current={itemActive ? 'page' : undefined}
                  className={cn(
                    'flex cursor-default items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm outline-none data-[highlighted]:bg-[var(--surface-2)] data-[highlighted]:text-[var(--text-primary)]',
                    itemActive
                      ? 'bg-[var(--surface-2)] text-[var(--text-primary)]'
                      : 'text-[var(--text-secondary)]',
                  )}
                >
                  <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                    <Icon
                      size={item.iconSize ?? 18}
                      className={cn(
                        'flex-shrink-0',
                        item.iconColor
                          && (itemActive ? item.iconColor.replace('400', '300') : item.iconColor),
                      )}
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {showBadge && (
                    <NavigationBadge
                      count={badge.count}
                      tone={badge.tone}
                      pulse={badge.pulse}
                    />
                  )}
                </Link>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
