import { useEffect, useState } from 'react';

export type SettingsSection =
  | 'general'
  | 'connectors'
  | 'listGroups'
  | 'sync'
  | 'tags'
  | 'mode'
  | 'ai'
  | 'integrations'
  | 'triageSources'
  | 'contentTypes'
  | 'priorityEntities'
  | 'dashboard'
  | 'storage'
  | 'shortcuts'
  | 'notifications'
  | 'runtime'
  | 'about';

export interface SettingsSearchItem {
  title: string;
  section: SettingsSection;
  sectionLabel: string;
  target?: string;
  description?: string;
  keywords?: string[];
}

export const SETTINGS_SECTION_NAMES: Record<SettingsSection, string> = {
  connectors: 'Connectors',
  sync: 'Sync History',
  integrations: 'Integrations',
  notifications: 'Notifications',
  listGroups: 'List Groups',
  tags: 'Tags',
  contentTypes: 'Content Types',
  triageSources: 'Triage Sources',
  priorityEntities: 'Priority Entities',
  dashboard: 'Dashboard',
  shortcuts: 'Taskbar Shortcuts',
  ai: 'AI Provider',
  storage: 'Storage & Cache',
  mode: 'App Mode',
  general: 'Other',
  runtime: 'Runtime Telemetry',
  about: 'About',
};

export const SETTINGS_SEARCH_ITEMS: SettingsSearchItem[] = [
  { title: 'Connectors', section: 'connectors', sectionLabel: 'Data Sources', keywords: ['accounts', 'services', 'sources'] },
  { title: 'Add connector', section: 'connectors', sectionLabel: 'Data Sources', target: 'Connectors', keywords: ['connect account', 'new source'] },
  { title: 'Sync History', section: 'sync', sectionLabel: 'Data Sources', keywords: ['activity', 'runs', 'errors'] },
  { title: 'Integrations', section: 'integrations', sectionLabel: 'Data Sources', keywords: ['automation'] },
  { title: 'n8n', section: 'integrations', sectionLabel: 'Data Sources', keywords: ['automation', 'workflow'] },
  { title: 'Outbound Webhooks', section: 'integrations', sectionLabel: 'Data Sources', keywords: ['events', 'callback'] },
  { title: 'Inbound Webhooks', section: 'integrations', sectionLabel: 'Data Sources', keywords: ['events', 'capture'] },
  { title: 'Notification enrichment', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['re-enrichment', 'ai enrichment'] },
  { title: 'Push Notifications', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['alerts', 'browser'] },
  { title: 'Do Not Disturb', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['dnd', 'mute'] },
  { title: 'Scheduled Summaries', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['schedule', 'notification scheduler'] },
  { title: 'Morning Summary', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['digest'] },
  { title: 'Triage Nudge', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['reminder'] },
  { title: 'Carry-Forward Reminder', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['reminder'] },
  { title: 'Quiet Hours', section: 'notifications', sectionLabel: 'Data Sources', keywords: ['schedule', 'mute'] },

  { title: 'List Groups', section: 'listGroups', sectionLabel: 'Organization', keywords: ['lists', 'folders'] },
  { title: 'Tags', section: 'tags', sectionLabel: 'Organization', keywords: ['labels', 'review'] },
  { title: 'Content Types', section: 'contentTypes', sectionLabel: 'Organization', keywords: ['classification', 'types'] },
  { title: 'Triage Sources', section: 'triageSources', sectionLabel: 'Organization', keywords: ['capture', 'imports'] },
  { title: 'GitHub Stars', section: 'triageSources', sectionLabel: 'Organization', keywords: ['starred repositories'] },
  { title: 'Reddit Saved', section: 'triageSources', sectionLabel: 'Organization', keywords: ['saved posts'] },
  { title: 'YouTube Playlists', section: 'triageSources', sectionLabel: 'Organization', keywords: ['videos'] },
  { title: 'OWL', section: 'triageSources', sectionLabel: 'Organization', keywords: ['documents', 'ocr', 'paperless', 'paperless-ngx', 'document intelligence'] },
  { title: 'Karakeep', section: 'triageSources', sectionLabel: 'Organization', keywords: ['bookmarks'] },
  { title: 'Priority Entities', section: 'priorityEntities', sectionLabel: 'Organization', keywords: ['smart score', 'people', 'projects'] },

  { title: 'Dashboard KPIs', section: 'dashboard', sectionLabel: 'Appearance', keywords: ['metrics', 'cards'] },
  { title: 'KPI Rotation', section: 'dashboard', sectionLabel: 'Appearance', target: 'Rotation', keywords: ['cycle', 'dashboard'] },
  { title: 'KPI Auto-surface', section: 'dashboard', sectionLabel: 'Appearance', target: 'Auto-surface', keywords: ['dashboard', 'automatic'] },
  { title: 'Taskbar Shortcuts', section: 'shortcuts', sectionLabel: 'Appearance', keywords: ['pwa', 'quick launch'] },
  { title: 'Launch Behavior', section: 'shortcuts', sectionLabel: 'Appearance', keywords: ['reuse window', 'new window'] },

  { title: 'AI Provider', section: 'ai', sectionLabel: 'System', keywords: ['openai', 'ollama', 'azure'] },
  { title: 'AI Model', section: 'ai', sectionLabel: 'System', target: 'Model', keywords: ['llm'] },
  { title: 'AI Base URL', section: 'ai', sectionLabel: 'System', target: 'Base URL', keywords: ['endpoint', 'host'] },
  { title: 'AI sensitivity routing', section: 'ai', sectionLabel: 'System', target: 'Sensitivity routing policies', keywords: ['privacy', 'fallback', 'local only', 'restricted', 'bifrost'] },
  {
    title: 'AI API Key',
    section: 'ai',
    sectionLabel: 'System',
    target: 'Provider',
    description: 'Choose OpenAI or Azure OpenAI to configure an API key.',
    keywords: ['token', 'secret'],
  },
  { title: 'Storage & Cache', section: 'storage', sectionLabel: 'System', keywords: ['database', 'disk'] },
  { title: 'Runtime Telemetry', section: 'runtime', sectionLabel: 'System', keywords: ['memory', 'heap', 'rss', 'alerts', 'diagnostics'] },
  { title: 'Thumbnail Cache', section: 'storage', sectionLabel: 'System', keywords: ['images', 'files'] },
  { title: 'Maintenance Actions', section: 'storage', sectionLabel: 'System', keywords: ['storage', 'cleanup', 'purge'] },
  { title: 'Dismissed item retention', section: 'storage', sectionLabel: 'System', target: 'Retention period for dismissed items:', keywords: ['days', 'delete', 'cache retention'] },
  { title: 'Clear Items by Source', section: 'storage', sectionLabel: 'System', keywords: ['delete', 'cleanup'] },
  { title: 'App Mode', section: 'mode', sectionLabel: 'System', keywords: ['demo', 'live'] },
  { title: 'Demo Mode', section: 'mode', sectionLabel: 'System', keywords: ['sample data', 'testing'] },
  { title: 'Live Mode', section: 'mode', sectionLabel: 'System', keywords: ['real data', 'write-back'] },
  { title: 'Data Management', section: 'mode', sectionLabel: 'System', keywords: ['reset', 'clear sample data'] },
  { title: 'Other settings', section: 'general', sectionLabel: 'System', target: 'General', keywords: ['general', 'preferences'] },
  { title: 'Timezone', section: 'general', sectionLabel: 'System', keywords: ['calendar', 'dates', 'schedule'] },
  { title: 'Completion animation', section: 'general', sectionLabel: 'System', keywords: ['particles', 'reduced motion'] },
  { title: 'Sync icon animation', section: 'general', sectionLabel: 'System', keywords: ['satellite', 'particles', 'alternating', 'random'] },
  { title: 'Quick Add parsing', section: 'general', sectionLabel: 'System', keywords: ['nlp', 'dates', 'tokens', 'preserve text'] },
  { title: 'Natural-language date suggestions', section: 'general', sectionLabel: 'System', target: 'Natural-language date suggestions', keywords: ['nlp', 'quick add', 'dates'] },
  { title: 'Preserve metadata tokens', section: 'general', sectionLabel: 'System', keywords: ['quick add', 'title', 'tokens'] },
  { title: 'App badge count', section: 'general', sectionLabel: 'System', keywords: ['icon', 'unread count'] },
  { title: 'Navigation badges', section: 'general', sectionLabel: 'System', target: 'Navigation tab badges', keywords: ['tabs', 'counts'] },
  { title: 'Dopamine Menu', section: 'general', sectionLabel: 'System', keywords: ['rewards', 'completion'] },
  { title: 'About Mission Control', section: 'about', sectionLabel: 'System', keywords: ['app', 'version', 'release', 'project'] },
  { title: 'Version', section: 'about', sectionLabel: 'System', keywords: ['release', 'build'] },
  { title: 'Build', section: 'about', sectionLabel: 'System', keywords: ['revision', 'commit', 'sha', 'release'] },
  { title: 'Documentation', section: 'about', sectionLabel: 'System', keywords: ['help', 'guides', 'setup'] },
  { title: 'Support and feedback', section: 'about', sectionLabel: 'System', keywords: ['github', 'issues', 'bug'] },
  { title: 'Licensing status', section: 'about', sectionLabel: 'System', keywords: ['license', 'legal'] },
];

function normalize(value: string) {
  return value.toLocaleLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '').trim();
}

export function searchSettings(query: string, limit = 12): SettingsSearchItem[] {
  const normalizedQuery = normalize(query);
  if (!normalizedQuery) return [];

  const terms = normalizedQuery.split(/\s+/);

  return SETTINGS_SEARCH_ITEMS
    .map((item, index) => {
      const title = normalize(item.title);
      const section = normalize(item.sectionLabel);
      const sectionName = normalize(SETTINGS_SECTION_NAMES[item.section]);
      const keywords = normalize(item.keywords?.join(' ') ?? '');
      const searchable = `${title} ${section} ${sectionName} ${keywords}`;

      if (!terms.every(term => searchable.includes(term))) return null;

      let score = 0;
      if (title === normalizedQuery) score += 100;
      else if (title.startsWith(normalizedQuery)) score += 60;
      else if (title.includes(normalizedQuery)) score += 40;
      score += terms.filter(term => title.includes(term)).length * 10;
      score += terms.filter(term => sectionName.includes(term)).length * 6;
      score += terms.filter(term => section.includes(term)).length * 4;

      return { item, index, score };
    })
    .filter((result): result is { item: SettingsSearchItem; index: number; score: number } => result !== null)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit)
    .map(result => result.item);
}

export function findSettingsTarget(root: ParentNode, targetText: string, sectionName: string) {
  const candidates = Array.from(
    root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, label, button, [aria-label]'),
  );
  const normalizedTarget = normalize(targetText);
  const getText = (element: HTMLElement) =>
    normalize(element.getAttribute('aria-label') || element.textContent || '');

  const target = candidates.find(element => getText(element) === normalizedTarget)
    ?? candidates.find(element => getText(element).includes(normalizedTarget));
  const normalizedSection = normalize(sectionName);
  const sectionHeading = candidates.find(element => getText(element) === normalizedSection);

  return { target, sectionHeading };
}

export function focusSettingsTarget(root: ParentNode, targetText: string, sectionName: string) {
  const { target, sectionHeading } = findSettingsTarget(root, targetText, sectionName);
  const element = target ?? sectionHeading;
  if (!element) return false;

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const hadTabIndex = element.hasAttribute('tabindex');
  if (!hadTabIndex) element.tabIndex = -1;
  element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
  element.focus({ preventScroll: true });
  if (!reduceMotion) {
    element.animate(
      [
        { outline: '2px solid rgb(59 130 246 / 0.9)', outlineOffset: '6px', backgroundColor: 'rgb(59 130 246 / 0.12)' },
        { outline: '2px solid transparent', outlineOffset: '10px', backgroundColor: 'transparent' },
      ],
      { duration: 1800, easing: 'ease-out' },
    );
  }
  if (!hadTabIndex) {
    element.addEventListener('blur', () => element.removeAttribute('tabindex'), { once: true });
  }
  return Boolean(target);
}

function getUrlSettingTarget() {
  if (typeof window === 'undefined') return null;
  return new URLSearchParams(window.location.search).get('setting');
}

export function useSettingsUrlTarget() {
  const [target, setTarget] = useState<string | null>(getUrlSettingTarget);

  useEffect(() => {
    const handlePopState = () => setTarget(getUrlSettingTarget());
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  return [target, setTarget] as const;
}
