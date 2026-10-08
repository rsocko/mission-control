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
      <ConnectorIcon
        connectorType="paperclip"
        size={size}
        className={className}
      />
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
