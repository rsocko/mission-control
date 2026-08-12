import Image from 'next/image';
import { LOCAL_CONNECTOR_ICON_PATH } from '@/lib/constants/colors';

interface LocalSourceIconProps {
  size?: number;
  className?: string;
}

export function LocalSourceIcon({ size = 14, className }: LocalSourceIconProps) {
  return (
    <Image
      src={LOCAL_CONNECTOR_ICON_PATH}
      alt=""
      width={size}
      height={size}
      className={className}
    />
  );
}

LocalSourceIcon.displayName = 'LocalSourceIcon';
