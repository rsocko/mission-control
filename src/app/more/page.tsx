'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { HoustonIcon } from '@/components/ui/HoustonIcon';
import {
  LayoutDashboard,
  Sun,
  ChartNetwork,
  Columns3,
  Target,
  Repeat,
  Activity,
  Inbox,
  CalendarDays,
  FileText,
  Coins,
  Bell,
  Settings,
  RefreshCw,
  ChevronRight,
} from 'lucide-react';
import { cn } from '@/lib/utils';

import type { ComponentType } from 'react';

interface MoreItem {
  href: string;
  label: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  iconColor: string;
}

interface MoreSection {
  label: string;
  items: MoreItem[];
}

const sections: MoreSection[] = [
  {
    label: 'Views',
    items: [
      { href: '/', label: 'Dashboard', icon: LayoutDashboard, iconColor: 'text-blue-400 bg-blue-400/15' },
      { href: '/today', label: 'My Day', icon: Sun, iconColor: 'text-amber-400 bg-amber-400/15' },
      { href: '/projects', label: 'Projects', icon: ChartNetwork, iconColor: 'text-violet-400 bg-violet-400/15' },
      { href: '/kanban', label: 'Kanban', icon: Columns3, iconColor: 'text-cyan-400 bg-cyan-400/15' },
      { href: '/goals', label: 'Goals', icon: Target, iconColor: 'text-rose-400 bg-rose-400/15' },
      { href: '/timeline', label: 'Timeline', icon: CalendarDays, iconColor: 'text-sky-400 bg-sky-400/15' },
    ],
  },
  {
    label: 'Workflow',
    items: [
      { href: '/notifications', label: 'Notifications', icon: Bell, iconColor: 'text-yellow-400 bg-yellow-400/15' },
      { href: '/routines', label: 'Routines', icon: Repeat, iconColor: 'text-emerald-400 bg-emerald-400/15' },
      { href: '/insights', label: 'Insights', icon: Activity, iconColor: 'text-pink-400 bg-pink-400/15' },
      { href: '/triage', label: 'Triage', icon: Inbox, iconColor: 'text-orange-400 bg-orange-400/15' },
    ],
  },
  {
    label: 'Domains',
    items: [
      { href: '/doc-intelligence', label: 'Docs', icon: FileText, iconColor: 'text-teal-400 bg-teal-400/15' },
      { href: '/finance', label: 'Money', icon: Coins, iconColor: 'text-amber-400 bg-amber-400/15' },
    ],
  },
  {
    label: 'Tools',
    items: [
      { href: '/ai', label: 'Houston', icon: HoustonIcon as ComponentType<{ size?: number; className?: string }>, iconColor: 'text-indigo-400 bg-indigo-400/15' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/settings', label: 'Settings', icon: Settings, iconColor: 'text-slate-400 bg-slate-400/15' },
      { href: '/settings/sync', label: 'Sync Status', icon: RefreshCw, iconColor: 'text-blue-400 bg-blue-400/15' },
    ],
  },
];

export default function MorePage() {
  const router = useRouter();

  // On desktop, redirect to Settings since the NavRail has full navigation
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 640px)');
    if (mq.matches) {
      router.replace('/settings');
      return;
    }
    const handler = (e: MediaQueryListEvent) => {
      if (e.matches) router.replace('/settings');
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [router]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <h1 className="text-lg font-semibold text-[var(--text-primary)]">More</h1>

        {sections.map((section) => (
          <div key={section.label}>
            <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-tertiary)] mb-2 px-1">
              {section.label}
            </h2>
            <div className="bg-[var(--surface-1)] rounded-[var(--radius-lg)] border border-[var(--border)] overflow-hidden divide-y divide-[var(--border)]">
              {section.items.map((item) => {
                const Icon = item.icon;
                const [iconText, iconBg] = item.iconColor.split(' ');
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3 hover:bg-[var(--surface-2)] transition-colors active:bg-[var(--surface-3)]"
                  >
                    <span className={cn('w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0', iconBg)}>
                      <Icon size={18} className={iconText} />
                    </span>
                    <span className="flex-1 text-sm font-medium text-[var(--text-primary)]">
                      {item.label}
                    </span>
                    <ChevronRight size={16} className="text-[var(--text-tertiary)] flex-shrink-0" />
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
