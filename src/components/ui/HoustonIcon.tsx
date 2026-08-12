import type { SVGProps } from 'react';

interface HoustonIconProps extends SVGProps<SVGSVGElement> {
  size?: number | string;
}

/**
 * Custom Houston AI icon — headset with blue→purple gradient stroke
 * and white 4-point star sparkles. Drop-in replacement for Lucide icons
 * (accepts size + className).
 */
export function HoustonIcon({ size = 24, className, ...props }: HoustonIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 -3 27 27"
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      {...props}
    >
      <defs>
        <linearGradient id="houston-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#60a5fa" />
          <stop offset="100%" stopColor="#a855f7" />
        </linearGradient>
      </defs>
      {/* Headset with brand gradient */}
      <path
        d="M3 11h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Zm0 0a9 9 0 1 1 18 0m0 0v5a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3Z"
        stroke="url(#houston-grad)"
        strokeWidth="2"
      />
      <path
        d="M21 16v2a4 4 0 0 1-4 4h-5"
        stroke="url(#houston-grad)"
        strokeWidth="2"
      />
      {/* Large sparkle — overlaps right arc */}
      <path
        d="M19 2.5 L20.5 7 L25 8.5 L20.5 10 L19 14.5 L17.5 10 L13 8.5 L17.5 7 Z"
        fill="white"
      />
      {/* Medium sparkle — above center */}
      <path
        d="M13.5 -1.5 L14.2 1.5 L17.2 2.2 L14.2 2.9 L13.5 5.9 L12.8 2.9 L9.8 2.2 L12.8 1.5 Z"
        fill="white"
      />
      {/* Small sparkle — upper right */}
      <path
        d="M23.5 1 L24 2.8 L25.8 3.3 L24 3.8 L23.5 5.6 L23 3.8 L21.2 3.3 L23 2.8 Z"
        fill="white"
      />
    </svg>
  );
}
