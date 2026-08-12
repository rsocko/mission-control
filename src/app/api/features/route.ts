import { NextResponse } from 'next/server';
import db from '@/db';
import { connectorConfigs } from '@/db/schema';
import { isNull } from 'drizzle-orm';
import { getProviderInfo, getResolvedAIConfig } from '@/lib/ai';
import { CAPABILITY_DEFAULTS } from '@/lib/connectors/capabilities';
import { resolveConnectorCapabilities } from '@/lib/connectors/task-source-profiles';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';
import type { ConnectorCapabilities } from '@/types';
const LIST_SELECTION_MODE_DEFAULTS: Record<string, string> = {
  'github-issues': 'required',
  'microsoft-todo': 'optional',
};

/** Canonical tagScope per connector type (source of truth from connector classes) */
const TAG_SCOPE_DEFAULTS: Record<string, 'global' | 'per-list'> = {
  'github-issues': 'per-list',
  'microsoft-todo': 'global',
};

/** Canonical tagCreationMode per connector type */
const TAG_CREATION_MODE_DEFAULTS: Record<string, 'freeform' | 'predefined'> = {
  'github-issues': 'predefined',
  'microsoft-todo': 'freeform',
};

/** Connectors that natively support file attachments via API */
const ATTACHMENT_SUPPORT: Record<string, boolean> = {
  'microsoft-todo': true,
};

export interface FeatureFlags {
  /** Whether any task-capable connector is enabled (shows task creation UI) */
  taskCreation: boolean;
  /** List of enabled task destinations (connector type + name) */
  taskDestinations: Array<{
    id: string;
    type: string;
    name: string;
    capabilities: Record<string, unknown>;
    account?: string;
    listSelectionMode: 'required' | 'optional' | 'not-applicable';
  }>;
  /** Whether AI features are available */
  aiEnabled: boolean;
  /** AI provider info when enabled */
  aiProvider?: { provider: string; model: string; baseUrl: string };
  /** Which source types are enabled for filtering */
  enabledSources: Array<{ type: string; name: string; icon: string; notificationOnly: boolean; tagScope?: 'global' | 'per-list'; tagCreationMode?: 'freeform' | 'predefined' }>;
  /** Whether message-based providers (RyMessage) are enabled */
  messagingEnabled: boolean;
  /** Whether finance features are enabled */
  financeEnabled: boolean;
}

const SOURCE_ICONS: Record<string, string> = {
  'microsoft-todo': '✅',
  'github-issues': '🐙',
  'outlook-email': '📧',
  'outlook-calendar': '📅',
  'rymessage': '💬',
  finance: '💰',
  'finance-manager': '💰',
  'monarch-money': '💰',
  'document-intelligence': '📄',
  'scout': '🔭',
  'custom-rest': '🔗',
};

export async function GET() {
  try {
    const configs = await db.select().from(connectorConfigs).where(isNull(connectorConfigs.deletedAt));
    const enabledConfigs = configs
      .filter(c => c.enabled)
      .map(c => {
        const storedCapabilities = (
          typeof c.capabilities === 'string'
            ? JSON.parse(c.capabilities)
            : c.capabilities
        ) as ConnectorCapabilities;
        const settings = (
          typeof c.settings === 'string'
            ? JSON.parse(c.settings)
            : c.settings
        ) as Record<string, unknown>;
        return {
          config: c,
          capabilities: resolveConnectorCapabilities(
            c.type,
            { ...CAPABILITY_DEFAULTS[c.type], ...storedCapabilities } as ConnectorCapabilities,
            settings,
          ),
          settings,
        };
      });

    // Notification-only connectors must never become task mutation destinations.
    const taskDestinations = enabledConfigs
      .filter(({ capabilities }) => (
        !capabilities.notificationOnly
        && (capabilities.taskCreate ?? capabilities.write) === true
      ))
      .map(({ config: c, capabilities: caps, settings }) => {
        const listSelectionMode = (caps.listSelectionMode as string) || LIST_SELECTION_MODE_DEFAULTS[c.type] || 'not-applicable';
        return {
          id: c.id,
          type: c.type,
          name: c.name,
          capabilities: {
            ...caps,
            tagScope: (caps.tagScope as string) || TAG_SCOPE_DEFAULTS[c.type] || 'global',
            tagCreationMode: (caps.tagCreationMode as string) || TAG_CREATION_MODE_DEFAULTS[c.type] || 'freeform',
            attachments: caps.attachments ?? ATTACHMENT_SUPPORT[c.type] ?? false,
          },
          account: settings.accountType as string | undefined,
          listSelectionMode: listSelectionMode as 'required' | 'optional' | 'not-applicable',
        };
      });

    const aiInfo = getProviderInfo();
    const aiConfigured = getResolvedAIConfig().configured;

    // Enabled sources for sidebar filtering (include notificationOnly flag and tagScope)
    const enabledSources = [
      // Always include Local as a source — it exists without a connector config
      { type: 'local', name: 'Local', icon: '📝', notificationOnly: false, tagScope: 'global' as const, tagCreationMode: 'freeform' as const },
      ...enabledConfigs.map(({ config: c, capabilities: caps }) => {
        return {
          type: c.type,
          name: c.name,
          icon: SOURCE_ICONS[c.type] || '🔗',
          notificationOnly: caps.notificationOnly === true,
          tagScope: (caps.tagScope as 'global' | 'per-list') || TAG_SCOPE_DEFAULTS[c.type] || 'global',
          tagCreationMode: (caps.tagCreationMode as 'freeform' | 'predefined') || TAG_CREATION_MODE_DEFAULTS[c.type] || 'freeform',
        };
      }),
    ];

    // Feature-specific checks
    const messagingEnabled = enabledConfigs.some(({ config }) => config.type === 'rymessage');
    const financeEnabled = enabledConfigs.some(({ config }) =>
      normalizeFinanceProviderAlias(config.type) !== null);

    const flags: FeatureFlags = {
      taskCreation: taskDestinations.length > 0,
      taskDestinations,
      aiEnabled: aiConfigured,
      aiProvider: aiConfigured ? {
        provider: aiInfo.provider,
        model: aiInfo.model,
        baseUrl: aiInfo.baseUrl,
      } : undefined,
      enabledSources,
      messagingEnabled,
      financeEnabled,
    };

    return NextResponse.json(flags);
  } catch (error) {
    console.error('Failed to load feature flags:', error);
    return NextResponse.json(
      { error: 'Failed to load feature flags' },
      { status: 500 },
    );
  }
}
