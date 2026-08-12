import Image from 'next/image';
import { cn } from '@/lib/utils';

const AGENT_ICONS = {
  OWL: '/icons/agents/owl.svg',
  Tyrion: '/icons/agents/tyrion.svg',
} as const;

interface AgentAttributionProps {
  agent: keyof typeof AGENT_ICONS;
  className?: string;
}

export function AgentAttribution({ agent, className }: AgentAttributionProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] py-1 pl-1.5 pr-2.5 text-[11px] text-[var(--text-muted)]',
        className,
      )}
    >
      <Image src={AGENT_ICONS[agent]} alt="" width={18} height={18} aria-hidden="true" />
      <span>Powered by</span>
      <strong className="font-semibold text-[var(--text-secondary)]">{agent}</strong>
    </span>
  );
}
