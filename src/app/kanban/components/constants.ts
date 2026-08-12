export const DEFAULT_COLUMNS = [
  { id: 'backlog', name: 'Backlog', color: '#6b7280', statusMapping: ['todo'] },
  { id: 'in-progress', name: 'In Progress', color: '#3b82f6', statusMapping: ['in_progress'] },
  { id: 'review', name: 'Review', color: '#8b5cf6', statusMapping: [] as string[] },
  { id: 'done', name: 'Done', color: '#22c55e', statusMapping: ['done'] },
];

export const CONNECTOR_BRAND_ICONS: Record<string, string> = {
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
};

export const SOURCES = [
  { id: 'microsoft-todo', name: 'Microsoft Todo', icon: '/icons/connectors/microsoft-todo.svg' },
  { id: 'github-issues', name: 'GitHub Issues', icon: '/icons/connectors/github.svg' },
  { id: 'outlook-email', name: 'Outlook Email', icon: '/icons/connectors/outlook.svg' },
  { id: 'outlook-calendar', name: 'Outlook Calendar', icon: '/icons/connectors/outlook-calendar.svg' },
  { id: 'rymessage', name: 'RyMessage', icon: '/icons/connectors/rymessage.svg' },
  { id: 'document-intelligence', name: 'OWL', icon: '/icons/agents/owl.svg' },
  { id: 'custom-rest', name: 'Custom REST', icon: '/icons/connectors/custom-rest.svg' },
];

export const PRIORITY_DOTS: Record<string, string> = {
  critical: 'bg-rose-500',
  high: 'bg-orange-400',
  medium: 'bg-amber-400',
  low: 'bg-sky-400',
  none: '',
};

export const PRIORITY_LABELS: Record<string, string> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  none: '',
};

export const VISIBLE_LIMIT = 15;
