export type ShortcutIconKey =
  | 'dashboard'
  | 'today'
  | 'projects'
  | 'kanban'
  | 'goals'
  | 'timeline'
  | 'notifications'
  | 'routines'
  | 'triage'
  | 'quick-sort'
  | 'insights'
  | 'icon-finder'
  | 'houston'
  | 'settings';

export interface ShortcutPage {
  id: string;
  url: string;
  name: string;
  description: string;
  icon: string;
  iconKey: ShortcutIconKey;
  iconColor: string;
  iconBackground: string;
}

export const TASKBAR_SHORTCUT_LIMIT = 4;
export const TASKBAR_ICON_VERSION = 2;

export const SHORTCUT_PAGES: readonly ShortcutPage[] = [
  {
    id: 'dashboard',
    url: '/',
    name: 'Dashboard',
    description: 'Open the main dashboard',
    icon: 'shortcut-dashboard.svg',
    iconKey: 'dashboard',
    iconColor: 'text-blue-400',
    iconBackground: 'bg-blue-400/15',
  },
  {
    id: 'today',
    url: '/today',
    name: 'My Day',
    description: 'View today\'s tasks',
    icon: 'shortcut-today.svg',
    iconKey: 'today',
    iconColor: 'text-amber-400',
    iconBackground: 'bg-amber-400/15',
  },
  {
    id: 'projects',
    url: '/projects',
    name: 'Projects',
    description: 'View all projects',
    icon: 'shortcut-projects.svg',
    iconKey: 'projects',
    iconColor: 'text-violet-400',
    iconBackground: 'bg-violet-400/15',
  },
  {
    id: 'kanban',
    url: '/kanban',
    name: 'Kanban',
    description: 'Open the Kanban board',
    icon: 'shortcut-kanban.svg',
    iconKey: 'kanban',
    iconColor: 'text-cyan-400',
    iconBackground: 'bg-cyan-400/15',
  },
  {
    id: 'goals',
    url: '/goals',
    name: 'Goals',
    description: 'Track your goals',
    icon: 'shortcut-goals.svg',
    iconKey: 'goals',
    iconColor: 'text-rose-400',
    iconBackground: 'bg-rose-400/15',
  },
  {
    id: 'timeline',
    url: '/timeline',
    name: 'Timeline',
    description: 'View work on a calendar timeline',
    icon: 'shortcut-timeline.svg',
    iconKey: 'timeline',
    iconColor: 'text-sky-400',
    iconBackground: 'bg-sky-400/15',
  },
  {
    id: 'notifications',
    url: '/notifications',
    name: 'Notifications',
    description: 'Review notifications',
    icon: 'shortcut-notifications.svg',
    iconKey: 'notifications',
    iconColor: 'text-yellow-400',
    iconBackground: 'bg-yellow-400/15',
  },
  {
    id: 'routines',
    url: '/routines',
    name: 'Routines',
    description: 'Open daily routines',
    icon: 'shortcut-routines.svg',
    iconKey: 'routines',
    iconColor: 'text-emerald-400',
    iconBackground: 'bg-emerald-400/15',
  },
  {
    id: 'triage',
    url: '/triage',
    name: 'Triage',
    description: 'Triage incoming items',
    icon: 'shortcut-triage.svg',
    iconKey: 'triage',
    iconColor: 'text-purple-400',
    iconBackground: 'bg-purple-400/15',
  },
  {
    id: 'quick-sort',
    url: '/quick-sort',
    name: 'Quick Sort',
    description: 'Rapidly organize pending work',
    icon: 'shortcut-quick-sort.svg',
    iconKey: 'quick-sort',
    iconColor: 'text-amber-400',
    iconBackground: 'bg-amber-400/15',
  },
  {
    id: 'insights',
    url: '/insights',
    name: 'Insights',
    description: 'Review productivity insights',
    icon: 'shortcut-insights.svg',
    iconKey: 'insights',
    iconColor: 'text-pink-400',
    iconBackground: 'bg-pink-400/15',
  },
  {
    id: 'icon-finder',
    url: '/icons',
    name: 'Icon Finder',
    description: 'Search and copy icons',
    icon: 'shortcut-icon-finder.svg',
    iconKey: 'icon-finder',
    iconColor: 'text-indigo-400',
    iconBackground: 'bg-indigo-400/15',
  },
  {
    id: 'ai',
    url: '/ai',
    name: 'Houston',
    description: 'Open the AI assistant',
    icon: 'shortcut-ai.svg',
    iconKey: 'houston',
    iconColor: 'text-indigo-400',
    iconBackground: 'bg-indigo-400/15',
  },
  {
    id: 'settings',
    url: '/settings',
    name: 'Settings',
    description: 'Configure Mission Control',
    icon: 'shortcut-settings.svg',
    iconKey: 'settings',
    iconColor: 'text-slate-400',
    iconBackground: 'bg-slate-400/15',
  },
] as const;

export const SHORTCUT_PAGES_BY_URL = new Map(
  SHORTCUT_PAGES.map(page => [page.url, page]),
);

export function getShortcutPage(url: string): ShortcutPage | undefined {
  return SHORTCUT_PAGES_BY_URL.get(url);
}
