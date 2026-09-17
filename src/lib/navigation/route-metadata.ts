import {
  NAVIGATION_DESTINATIONS,
  type MobileRouteAccess,
} from '@/lib/navigation/global-search';

export type { MobileRouteAccess } from '@/lib/navigation/global-search';

interface RouteMetadataBase {
  pathname: string;
  title: string;
}

export type RouteMetadata = RouteMetadataBase & (
  | {
      mobileAccess: Exclude<MobileRouteAccess, 'unsupported'>;
      unsupportedReason?: never;
    }
  | {
      mobileAccess: 'unsupported';
      unsupportedReason: string;
    }
);

const ROUTE_METADATA: readonly RouteMetadata[] = NAVIGATION_DESTINATIONS.map(destination => (
  destination.mobileAccess === 'unsupported'
    ? {
        pathname: destination.pathname,
        title: destination.title,
        mobileAccess: destination.mobileAccess,
        unsupportedReason: destination.unsupportedReason
          ?? `${destination.title} is unavailable on mobile.`,
      }
    : {
        pathname: destination.pathname,
        title: destination.title,
        mobileAccess: destination.mobileAccess,
      }
));

export function getRouteMetadata(pathname: string): RouteMetadata | undefined {
  const exactMatch = ROUTE_METADATA.find((route) => route.pathname === pathname);
  if (exactMatch) return exactMatch;

  return ROUTE_METADATA
    .filter((route) => route.pathname !== '/' && pathname.startsWith(`${route.pathname}/`))
    .sort((a, b) => b.pathname.length - a.pathname.length)[0];
}

export function getMobileTitle(pathname: string): string {
  return getRouteMetadata(pathname)?.title ?? 'Mission Control';
}
