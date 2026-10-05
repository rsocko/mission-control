import { ConnectorIcon } from '@/components/sources/SourceIcons';
import { Bot } from 'lucide-react';
import type { ExternalAgentType } from '@/lib/external-agents/contracts';
import { cn } from '@/lib/utils';

interface ExecutionDestinationIconProps {
  type: ExternalAgentType;
  size?: number;
  className?: string;
}

export function ExecutionDestinationIcon({
  type,
  size = 18,
  className,
}: ExecutionDestinationIconProps) {
  if (type === 'copilot-cloud') {
    return (
      <ConnectorIcon
        connectorType="github-issues"
        size={size}
        className={className}
      />
    );
  }

  if (type === 'pull-queue') {
    return (
      <ConnectorIcon
        connectorType="scout"
        size={size}
        className={className}
      />
    );
  }

  if (type === 'paperclip') {
    return (
      <svg
        aria-hidden="true"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={cn('shrink-0', className)}
      >
        <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
      </svg>
    );
  }

  return (
    <Bot
      aria-hidden="true"
      size={size}
      className={cn('shrink-0', className)}
    />
  );
}
