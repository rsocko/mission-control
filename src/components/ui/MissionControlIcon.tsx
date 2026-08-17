import { useId } from 'react';
import { Satellite } from 'lucide-react';
import { BRAND_GRADIENT_END, BRAND_GRADIENT_START } from '@/lib/brand';

interface MissionControlIconProps {
  size?: number;
  className?: string;
}

export function MissionControlIcon({ size = 27, className }: MissionControlIconProps) {
  const gradientId = `mission-control-brand-gradient-${useId().replaceAll(':', '')}`;

  return (
    <Satellite
      size={size}
      aria-hidden="true"
      className={className}
      stroke={`url(#${gradientId})`}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={BRAND_GRADIENT_START} />
          <stop offset="100%" stopColor={BRAND_GRADIENT_END} />
        </linearGradient>
      </defs>
    </Satellite>
  );
}
