import { IconRenderer } from '@rsocko/icon-picker/renderer';
import { Repeat } from 'lucide-react';
import { cn } from '@/lib/utils';

interface RoutineIconProps {
  routine: {
    icon: string | null;
    iconColor: string | null;
  };
  size?: number;
  className?: string;
}

export function RoutineIcon({ routine, size = 18, className }: RoutineIconProps) {
  return (
    <span
      className={cn('inline-flex shrink-0 items-center justify-center leading-none', className)}
      aria-hidden="true"
    >
      <IconRenderer
        value={routine.icon}
        size={size}
        color={routine.iconColor || undefined}
        label=""
        fallback={<Repeat size={size} className="text-emerald-400" />}
      />
    </span>
  );
}
