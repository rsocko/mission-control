export type MobileRouteAccess = 'listed' | 'hidden' | 'unsupported';

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

const ROUTE_METADATA: readonly RouteMetadata[] = [
  { pathname: '/today', title: 'Today', mobileAccess: 'listed' },
  { pathname: '/triage', title: 'Triage', mobileAccess: 'listed' },
  { pathname: '/scout/reconciliation', title: 'Reconciliation', mobileAccess: 'listed' },
  { pathname: '/capture', title: 'Capture', mobileAccess: 'listed' },
  { pathname: '/quick-sort', title: 'Sort', mobileAccess: 'listed' },
  { pathname: '/ai', title: 'Houston', mobileAccess: 'listed' },
  { pathname: '/matrix', title: 'Priority Matrix', mobileAccess: 'hidden' },
  { pathname: '/all-tasks', title: 'All Tasks', mobileAccess: 'listed' },
  { pathname: '/projects', title: 'Projects', mobileAccess: 'listed' },
  { pathname: '/graph', title: 'Graph', mobileAccess: 'listed' },
  { pathname: '/goals', title: 'Goals', mobileAccess: 'listed' },
  { pathname: '/notifications', title: 'Notifications', mobileAccess: 'listed' },
  { pathname: '/routines', title: 'Routines', mobileAccess: 'listed' },
  { pathname: '/insights', title: 'Insights', mobileAccess: 'listed' },
  { pathname: '/settings', title: 'Settings', mobileAccess: 'listed' },
  { pathname: '/more', title: 'More', mobileAccess: 'listed' },
  {
    pathname: '/kanban',
    title: 'Kanban',
    mobileAccess: 'unsupported',
    unsupportedReason: 'Kanban needs the extra screen space for columns and drag-and-drop.',
  },
  {
    pathname: '/timeline',
    title: 'Timeline',
    mobileAccess: 'unsupported',
    unsupportedReason: 'Timeline needs the extra screen space for its calendar and upcoming-task panels.',
  },
  {
    pathname: '/doc-intelligence',
    title: 'Docs',
    mobileAccess: 'hidden',
  },
  { pathname: '/finance', title: 'Money', mobileAccess: 'listed' },
  { pathname: '/', title: 'Dashboard', mobileAccess: 'listed' },
];

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
