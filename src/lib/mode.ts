/**
 * Application Mode Manager
 * 
 * Supports two modes:
 * - "demo": Uses seed data, write-back to external APIs is disabled, shows banner
 * - "live": Real connectors sync, full write-back enabled
 * 
 * Mode is stored in a local JSON settings file alongside the DB.
 */
import fs from 'fs';
import path from 'path';
import {
  getShortcutPage,
  TASKBAR_SHORTCUT_LIMIT,
  type ShortcutPage,
} from '@/lib/navigation/shortcut-catalog';

const SETTINGS_FILE = path.resolve(process.cwd(), 'data/settings.json');

export type AppMode = 'demo' | 'live';

export interface ShortcutConfig {
  id: string;
  name: string;
  url: string;
  description: string;
  icon: string; // SVG filename in /icons/
  enabled: boolean;
  openInNewWindow?: boolean; // When true, taskbar click opens this page in a new window
}

/** Maximum number of enabled shortcuts browsers reliably support */
export const MAX_ENABLED_SHORTCUTS = TASKBAR_SHORTCUT_LIMIT;
export const SHORTCUT_CONFIG_VERSION = 2;

/**
 * Controls PWA launch behavior when a shortcut is clicked and the app is already open.
 * - 'navigate-existing': reuse the existing window and navigate to the shortcut URL
 * - 'navigate-new': always open a new app window
 */
export type LaunchMode = 'navigate-existing' | 'navigate-new';

function createShortcutConfig(
  page: ShortcutPage,
  enabled: boolean,
  openInNewWindow?: boolean,
): ShortcutConfig {
  return {
    id: page.id,
    name: page.name,
    url: page.url,
    description: page.description,
    icon: page.icon,
    enabled,
    ...(openInNewWindow !== undefined && { openInNewWindow }),
  };
}

export const DEFAULT_SHORTCUTS: ShortcutConfig[] = [
  '/icons',
  '/today',
  '/triage',
  '/projects',
].map(url => {
  const page = getShortcutPage(url);
  if (!page) throw new Error(`Missing shortcut catalog entry for ${url}`);
  return createShortcutConfig(page, true);
});

export interface AppSettings {
  mode: AppMode;
  demoSeededAt?: string;
  timezone?: string; // IANA timezone, e.g. "America/New_York"
  shortcuts?: ShortcutConfig[];
  shortcutConfigVersion?: number;
  launchMode?: LaunchMode; // PWA launch behavior, defaults to 'navigate-existing'
}

function readSettings(): AppSettings {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch {
    // Fall through to default
  }
  return { mode: 'demo' };
}

function writeSettings(settings: AppSettings): void {
  const dir = path.dirname(SETTINGS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

export function getAppMode(): AppMode {
  // Env var takes precedence
  const envMode = process.env.MC_MODE;
  if (envMode === 'live' || envMode === 'demo') return envMode;
  return readSettings().mode;
}

export function setAppMode(mode: AppMode): void {
  const settings = readSettings();
  settings.mode = mode;
  writeSettings(settings);
}

export function getSettings(): AppSettings {
  return readSettings();
}

export function updateSettings(partial: Partial<AppSettings>): void {
  const settings = readSettings();
  Object.assign(settings, partial);
  writeSettings(settings);
}

export function isDemoMode(): boolean {
  return getAppMode() === 'demo';
}

export function isLiveMode(): boolean {
  return getAppMode() === 'live';
}

/**
 * Get the configured IANA timezone (e.g. "America/New_York").
 * Falls back to the server's local timezone if not explicitly set.
 */
export function getTimezone(): string {
  const settings = readSettings();
  return settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Get the configured taskbar shortcuts.
 * Falls back to DEFAULT_SHORTCUTS if not configured.
 */
export function getShortcuts(): ShortcutConfig[] {
  const settings = readSettings();
  if (!settings.shortcuts) return DEFAULT_SHORTCUTS;

  const canonicalShortcuts = settings.shortcuts.flatMap(shortcut => {
    const page = getShortcutPage(shortcut.url);
    if (!page) return [];
    return [createShortcutConfig(page, shortcut.enabled, shortcut.openInNewWindow)];
  });

  if (settings.shortcutConfigVersion === SHORTCUT_CONFIG_VERSION) {
    return canonicalShortcuts;
  }

  const iconFinder = getShortcutPage('/icons');
  const hasIconFinder = canonicalShortcuts.some(shortcut => shortcut.url === '/icons');
  let remainingEnabledSlots = hasIconFinder
    ? MAX_ENABLED_SHORTCUTS
    : MAX_ENABLED_SHORTCUTS - 1;
  const cappedShortcuts = canonicalShortcuts.map(shortcut => {
    if (!shortcut.enabled) return shortcut;
    if (remainingEnabledSlots === 0) return { ...shortcut, enabled: false };
    remainingEnabledSlots -= 1;
    return shortcut;
  });
  const migratedShortcuts = iconFinder && !hasIconFinder
    ? [createShortcutConfig(iconFinder, true), ...cappedShortcuts]
    : cappedShortcuts;

  settings.shortcuts = migratedShortcuts;
  settings.shortcutConfigVersion = SHORTCUT_CONFIG_VERSION;
  writeSettings(settings);
  return migratedShortcuts;
}

/**
 * Get the configured PWA launch mode.
 * Defaults to 'navigate-existing' (reuse existing window).
 */
export function getLaunchMode(): LaunchMode {
  const settings = readSettings();
  return settings.launchMode || 'navigate-existing';
}

/**
 * Convert an IANA timezone to the Windows timezone name expected by Microsoft Graph.
 * Covers common US/world timezones; falls back to UTC for unknown ones.
 */
export function ianaToWindowsTimezone(iana: string): string {
  const map: Record<string, string> = {
    'America/New_York': 'Eastern Standard Time',
    'America/Chicago': 'Central Standard Time',
    'America/Denver': 'Mountain Standard Time',
    'America/Los_Angeles': 'Pacific Standard Time',
    'America/Anchorage': 'Alaskan Standard Time',
    'Pacific/Honolulu': 'Hawaiian Standard Time',
    'America/Phoenix': 'US Mountain Standard Time',
    'America/Indiana/Indianapolis': 'US Eastern Standard Time',
    'America/Toronto': 'Eastern Standard Time',
    'America/Vancouver': 'Pacific Standard Time',
    'America/Winnipeg': 'Central Standard Time',
    'America/Edmonton': 'Mountain Standard Time',
    'America/Halifax': 'Atlantic Standard Time',
    'Europe/London': 'GMT Standard Time',
    'Europe/Paris': 'Romance Standard Time',
    'Europe/Berlin': 'W. Europe Standard Time',
    'Europe/Moscow': 'Russian Standard Time',
    'Asia/Tokyo': 'Tokyo Standard Time',
    'Asia/Shanghai': 'China Standard Time',
    'Asia/Kolkata': 'India Standard Time',
    'Australia/Sydney': 'AUS Eastern Standard Time',
    'Pacific/Auckland': 'New Zealand Standard Time',
    'UTC': 'UTC',
  };
  return map[iana] || 'UTC';
}
