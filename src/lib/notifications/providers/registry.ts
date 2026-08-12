import type { InboundNotification } from '@/types';
import type {
  NotificationActionDraft,
  NotificationProviderActionContext,
  NotificationProviderActionResult,
  NotificationProviderPresentation,
  NotificationSourceProvider,
  ResolvedNotificationProvider,
} from './types';
import { normalizeFinanceProviderAlias } from '@/lib/finance-insights/provider';

const providers = new Map<string, NotificationSourceProvider>();

function providerKey(sourceType: string): string {
  return normalizeFinanceProviderAlias(sourceType) ?? sourceType;
}

function applyPresentationActionPolicy(
  sourceType: string,
  presentation: NotificationProviderPresentation,
): NotificationProviderPresentation {
  if (!normalizeFinanceProviderAlias(sourceType) || !presentation.actions) return presentation;
  const actions = presentation.actions.filter(action => action.actionType !== 'create_task');
  if (actions.length === presentation.actions.length) return presentation;
  return {
    ...presentation,
    actions,
    ...(actions.length === 0 ? { isActionable: false } : {}),
  };
}

export function registerNotificationProvider(
  provider: NotificationSourceProvider,
  options: { replace?: boolean } = {},
): void {
  if (!provider.sourceType.trim()) {
    throw new Error('Notification provider sourceType is required');
  }
  if (provider.signatures.length === 0) {
    throw new Error(`Notification provider "${provider.sourceType}" must define at least one signature`);
  }
  const key = providerKey(provider.sourceType);
  if (providers.has(key) && !options.replace) {
    throw new Error(`Notification provider already registered for source: ${provider.sourceType}`);
  }
  providers.set(key, provider);
}

export function getNotificationProvider(sourceType: string): NotificationSourceProvider | undefined {
  return providers.get(providerKey(sourceType));
}

export function getAllNotificationProviders(): NotificationSourceProvider[] {
  return Array.from(providers.values());
}

export function resolveNotificationProvider(
  notification: InboundNotification,
): ResolvedNotificationProvider | null {
  const provider = providers.get(providerKey(notification.connectorType));
  if (!provider) return null;

  const signature = provider.signatures.find(candidate => candidate.matches(notification));
  if (!signature) return null;

  return {
    provider,
    signature,
    presentation: applyPresentationActionPolicy(
      notification.connectorType,
      signature.present(notification),
    ),
  };
}

export async function executeNotificationProviderAction(
  context: NotificationProviderActionContext,
): Promise<NotificationProviderActionResult | null> {
  if (
    normalizeFinanceProviderAlias(context.notification.connectorType)
    && context.action.actionType === 'create_task'
  ) {
    return {
      result: { type: 'finance_task_action_rejected' },
      error: {
        message: 'Finance notifications cannot create tasks',
        status: 400,
      },
    };
  }
  const provider = providers.get(providerKey(context.notification.connectorType));
  if (!provider?.executeAction) return null;
  return provider.executeAction(context);
}

export function createFallbackPresentation(
  notification: InboundNotification,
): NotificationProviderPresentation {
  const actions: NotificationActionDraft[] = notification.actionUrl
    ? [{
        actionType: 'open_url',
        label: 'Open',
        icon: 'external-link',
        variant: 'primary',
        isPrimary: true,
        payload: { url: notification.actionUrl },
        opensExternal: true,
        createdBy: 'connector',
      }]
    : [];

  return {
    title: notification.title,
    body: notification.body ?? null,
    category: notification.category,
    metadata: notification.metadata,
    presentation: {},
    actions,
  };
}

export function normalizeNotificationUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const normalized = value.trim();
    const url = new URL(normalized);
    return url.protocol === 'http:' || url.protocol === 'https:' ? normalized : null;
  } catch {
    return null;
  }
}

export function normalizeInternalNavigationTarget(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const target = value.trim();
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('\\')) return null;
  try {
    const base = new URL('https://mission-control.example');
    const resolved = new URL(target, base);
    return resolved.origin === base.origin
      ? `${resolved.pathname}${resolved.search}${resolved.hash}`
      : null;
  } catch {
    return null;
  }
}

export function materializeNotificationActions(
  notificationId: string,
  drafts: readonly NotificationActionDraft[],
  createId: () => string,
) {
  const explicitPrimaryIndex = drafts.findIndex(action => action.isPrimary);
  const primaryIndex = explicitPrimaryIndex >= 0 ? explicitPrimaryIndex : (drafts.length > 0 ? 0 : -1);

  return drafts.map((action, index) => ({
    id: createId(),
    notificationId,
    actionType: action.actionType,
    label: action.label,
    icon: action.icon || null,
    variant: action.variant,
    isPrimary: index === primaryIndex,
    sortOrder: action.sortOrder ?? index,
    payload: action.payload || {},
    opensExternal: action.opensExternal ?? false,
    requiresConfirmation: action.requiresConfirmation ?? false,
    createdBy: action.createdBy || 'connector',
  }));
}

export function clearNotificationProvidersForTests(): void {
  providers.clear();
}
