/**
 * Centralized color constants for Mission Control.
 * Use these instead of hardcoding hex values across components.
 */

/** Color presets for projects — the user can pick from these */
export const COLOR_PRESETS = [
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#f59e0b', // amber
  '#10b981', // emerald
  '#06b6d4', // cyan
  '#ef4444', // red
  '#6b7280', // gray
] as const;

/** Connector brand colors — used for destination pills and source indicators */
export const CONNECTOR_COLORS: Record<string, string> = {
  'microsoft-todo': '#5e3fa8',
  'github-issues': '#f97316',
  'local': '#10b981',
  'custom-rest': '#6366f1',
  'outlook-email': '#0078d4',
  'outlook-calendar': '#0078d4',
};

export const LOCAL_CONNECTOR_ICON_PATH = '/icons/connectors/local.svg';

/** Icon paths for connector logos */
export const CONNECTOR_ICON_PATHS: Record<string, string> = {
  'local': LOCAL_CONNECTOR_ICON_PATH,
  'microsoft-todo': '/icons/connectors/microsoft-todo.svg',
  'github-issues': '/icons/connectors/github.svg',
  'outlook-email': '/icons/connectors/outlook.svg',
  'outlook-calendar': '/icons/connectors/outlook-calendar.svg',
  'rymessage': '/icons/connectors/rymessage.svg',
  'document-intelligence': '/icons/agents/owl.svg',
  finance: '/icons/connectors/tyrion.svg',
  'finance-manager': '/icons/connectors/tyrion.svg',
  'monarch-money': '/icons/connectors/tyrion.svg',
  'custom-rest': '/icons/connectors/custom-rest.svg',
};

/** Human-friendly connector names for accessibility (alt text, aria-labels) */
export const CONNECTOR_LABELS: Record<string, string> = {
  'microsoft-todo': 'Microsoft To Do',
  'github-issues': 'GitHub Issues',
  'outlook-email': 'Outlook Email',
  'outlook-calendar': 'Outlook Calendar',
  'rymessage': 'RyMessage',
  'document-intelligence': 'OWL',
  finance: 'Tyrion',
  'finance-manager': 'Tyrion',
  'monarch-money': 'Tyrion',
  'custom-rest': 'Custom REST',
  'local': 'Local',
};

/**
 * Generate accessible tag pill styles.
 * Returns inline style object for background + text color.
 */
export function getTagPillStyle(color: string | null | undefined): { backgroundColor: string; color: string } {
  if (color) {
    return {
      backgroundColor: `${color}30`,
      color: `color-mix(in oklch, ${color} 60%, white)`,
    };
  }
  return {
    backgroundColor: 'var(--surface-2)',
    color: 'var(--text-secondary)',
  };
}
