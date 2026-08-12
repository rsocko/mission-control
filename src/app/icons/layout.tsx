import type { Metadata, Viewport } from 'next';

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#0a0a0f',
};

export const metadata: Metadata = {
  title: 'Icon Finder — Mission Control',
  description: 'Search and copy icons from Emoji, Lucide, MDI, Phosphor, Dashboard Icons, and Simple Icons',
  applicationName: 'Icon Finder',
};

export default function IconsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Minimal layout — no AppShell sidebar
  return <>{children}</>;
}
