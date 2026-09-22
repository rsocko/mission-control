'use client';

import Image from 'next/image';
import { Globe, List } from 'lucide-react';
import { IconRenderer } from '@/components/ui/icon-picker';
import { CONNECTOR_ICON_PATHS } from '@/lib/constants/colors';
import { canonicalTaskSourceType } from '@/lib/tasks/source-hierarchy';
import { cn } from '@/lib/utils';
import type { SourceList } from '@/types/dashboard';

interface ConnectorIconProps {
  connectorType: string;
  size?: number;
  className?: string;
}

export function ConnectorIcon({
  connectorType,
  size = 14,
  className,
}: ConnectorIconProps) {
  const iconPath = CONNECTOR_ICON_PATHS[canonicalTaskSourceType(connectorType)];
  if (!iconPath) {
    return <Globe aria-hidden="true" size={size} className={cn('shrink-0', className)} />;
  }

  return (
    <Image
      src={iconPath}
      alt=""
      width={size}
      height={size}
      className={cn('shrink-0 object-contain', className)}
    />
  );
}

interface SourceListIconProps {
  connectorType: string;
  list: Pick<SourceList, 'type' | 'icon' | 'iconColor'>;
  size?: number;
  className?: string;
}

export function resolveSourceListIconValue({
  icon,
}: {
  icon?: string | null;
}): string | null {
  const definedIcon = icon?.trim();
  return definedIcon || null;
}

export function SourceListIcon({
  connectorType,
  list,
  size = 11,
  className,
}: SourceListIconProps) {
  const fallback = (
    <List
      aria-hidden="true"
      size={size}
      className={cn('shrink-0', className)}
    />
  );
  const icon = resolveSourceListIconValue({
    icon: list.icon,
  });

  if (!icon) {
    return canonicalTaskSourceType(connectorType) === 'github-issues' && list.type === 'repo'
      ? (
          <Image
            src={CONNECTOR_ICON_PATHS['github-issues']}
            alt=""
            width={size}
            height={size}
            className={cn('shrink-0 object-contain', className)}
          />
        )
      : fallback;
  }
  return (
    <span aria-hidden="true" className={cn('inline-flex shrink-0', className)}>
      <IconRenderer
        value={icon}
        size={size}
        color={list.iconColor || undefined}
        fallback={fallback}
      />
    </span>
  );
}
