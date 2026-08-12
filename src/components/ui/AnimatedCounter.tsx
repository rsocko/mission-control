'use client';

import { useEffect, useState } from 'react';
import NumberFlow from '@number-flow/react';

interface AnimatedCounterProps {
  value: number;
  className?: string;
  formatFn?: (n: number) => string;
}

/**
 * Animated number counter using number-flow for smooth per-digit transitions.
 * Each digit slides into place independently (odometer style) rather than
 * counting through every intermediate value.
 */
export function AnimatedCounter({
  value,
  className,
}: AnimatedCounterProps) {
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setDisplayValue(value));
    return () => cancelAnimationFrame(frame);
  }, [value]);

  return (
    <NumberFlow
      value={displayValue}
      className={className}
      format={{ useGrouping: true }}
      transformTiming={{ duration: 750, easing: 'ease-out' }}
      spinTiming={{ duration: 750, easing: 'ease-out' }}
      opacityTiming={{ duration: 350, easing: 'ease-out' }}
    />
  );
}
