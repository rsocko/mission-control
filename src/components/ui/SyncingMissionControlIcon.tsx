import { BRAND_GRADIENT_END, BRAND_GRADIENT_START } from '@/lib/brand';
import styles from './SyncingMissionControlIcon.module.css';

interface SyncingMissionControlIconProps {
  size?: number;
  className?: string;
}

const signalPaths = {
  medium: 'M3.2 16.3c3.2 0 5.5 2 5.5 4.7',
  short: 'M3.4 19.1c1.4 0 2.3.7 2.3 1.9',
  long: 'M3.2 13.6c5 0 8.4 3.1 8.4 7.4',
};

export function SyncingMissionControlIcon({
  size = 32,
  className,
}: SyncingMissionControlIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      aria-hidden="true"
      className={className}
      data-testid="mission-control-sync-icon"
    >
      <defs>
        <linearGradient id="mission-control-sync-gradient" x1="7" y1="7" x2="25" y2="25" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor={BRAND_GRADIENT_START} />
          <stop offset="100%" stopColor={BRAND_GRADIENT_END} />
        </linearGradient>
      </defs>

      <g
        transform="translate(4 4) scale(.98)"
        stroke="url(#mission-control-sync-gradient)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="m13.5 6.5-3.148-3.148a1.205 1.205 0 0 0-1.704 0L6.352 5.648a1.205 1.205 0 0 0 0 1.704L9.5 10.5" />
        <path d="M16.5 7.5 19 5" />
        <path d="m17.5 10.5 3.148 3.148a1.205 1.205 0 0 1 0 1.704l-2.296 2.296a1.205 1.205 0 0 1-1.704 0L13.5 14.5" />
        <path d="M9.352 10.648a1.205 1.205 0 0 0 0 1.704l2.296 2.296a1.205 1.205 0 0 0 1.704 0l4.296-4.296a1.205 1.205 0 0 0 0-1.704l-2.296-2.296a1.205 1.205 0 0 0-1.704 0z" />
      </g>

      <g
        className={styles.outbound}
        data-signal-direction="outbound"
        transform="translate(4 4) scale(.98)"
        stroke="url(#mission-control-sync-gradient)"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <path className={styles.outboundMedium} d={signalPaths.medium} />
        <path className={styles.outboundShort} d={signalPaths.short} />
        <path className={styles.outboundLong} d={signalPaths.long} />
      </g>

      <g
        className={styles.inbound}
        data-signal-direction="inbound"
        transform="translate(4 4) scale(.98)"
        stroke="url(#mission-control-sync-gradient)"
        strokeWidth="1.8"
        strokeLinecap="round"
      >
        <g transform="matrix(-1 0 0 -1 14.8 34.6)">
          <path className={styles.inboundMedium} d={signalPaths.medium} />
          <path className={styles.inboundShort} d={signalPaths.short} />
          <path className={styles.inboundLong} d={signalPaths.long} />
        </g>
      </g>
    </svg>
  );
}
