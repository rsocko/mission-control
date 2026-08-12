import { useSyncExternalStore } from 'react';
import Link from 'next/link';
import { Monitor } from 'lucide-react';
import type { RouteMetadata } from '@/lib/navigation/route-metadata';

const PHONE_VIEWPORT_QUERY = '(max-width: 639px)';

function subscribeToPhoneViewport(onChange: () => void) {
  const mediaQuery = window.matchMedia(PHONE_VIEWPORT_QUERY);
  mediaQuery.addEventListener('change', onChange);
  return () => mediaQuery.removeEventListener('change', onChange);
}

function getPhoneViewportSnapshot() {
  return window.matchMedia(PHONE_VIEWPORT_QUERY).matches;
}

function getServerPhoneViewportSnapshot() {
  return null;
}

export interface MobileRouteGateProps {
  route: RouteMetadata | undefined;
  children: React.ReactNode;
}

function PhoneUnsupportedRoute({
  route,
  children,
}: {
  route: RouteMetadata & { mobileAccess: 'unsupported' };
  children: React.ReactNode;
}) {
  const isPhone = useSyncExternalStore<boolean | null>(
    subscribeToPhoneViewport,
    getPhoneViewportSnapshot,
    getServerPhoneViewportSnapshot,
  );

  const titleId = `mobile-route-${route.pathname.slice(1).replaceAll('/', '-')}`;
  const descriptionId = `${titleId}-description`;

  return (
    <>
      <section
        className="flex h-full min-h-[320px] flex-col items-center justify-center overflow-y-auto px-6 py-10 text-center sm:hidden"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
      >
        <Monitor
          size={32}
          className="mb-5 text-[var(--text-secondary)]"
          aria-hidden="true"
        />
        <h2
          id={titleId}
          className="text-xl font-semibold text-[var(--text-primary)]"
        >
          {`${route.title} isn't available on this phone`}
        </h2>
        <p
          id={descriptionId}
          className="mt-3 max-w-sm text-sm leading-6 text-[var(--text-secondary)]"
        >
          {route.unsupportedReason} Open this view on a desktop or tablet.
        </p>
        <div className="mt-6 flex w-full max-w-xs flex-col gap-3">
          <Link
            href="/today"
            className="flex min-h-11 items-center justify-center rounded-[var(--radius-md)] bg-[var(--accent)] px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
          >
            Open Today
          </Link>
          <Link
            href="/all-tasks"
            className="flex min-h-11 items-center justify-center rounded-[var(--radius-md)] border border-[var(--border-strong)] px-4 py-2.5 text-sm font-medium text-[var(--text-secondary)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--background)]"
          >
            View all tasks
          </Link>
        </div>
      </section>
      {isPhone === false ? (
        <div className="hidden h-full min-h-0 sm:block">
          {children}
        </div>
      ) : (
        <div
          className="hidden h-full items-center justify-center text-sm text-[var(--text-muted)] sm:flex"
          role="status"
        >
          Loading {route.title}...
        </div>
      )}
    </>
  );
}

export function MobileRouteGate({ route, children }: MobileRouteGateProps) {
  if (route?.mobileAccess !== 'unsupported') {
    return <>{children}</>;
  }

  return (
    <PhoneUnsupportedRoute route={route}>
      {children}
    </PhoneUnsupportedRoute>
  );
}
