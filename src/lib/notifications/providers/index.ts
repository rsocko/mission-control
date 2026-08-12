export type {
  NotificationActionDraft,
  NotificationProviderActionContext,
  NotificationProviderActionResult,
  NotificationProviderPresentation,
  NotificationPresentationLink,
  NotificationPresentationStat,
  NotificationPresentationTone,
  NotificationRichContent,
  NotificationSignature,
  NotificationSourceProvider,
  ResolvedNotificationProvider,
} from './types';
export {
  clearNotificationProvidersForTests,
  createFallbackPresentation,
  executeNotificationProviderAction,
  getAllNotificationProviders,
  getNotificationProvider,
  materializeNotificationActions,
  normalizeInternalNavigationTarget,
  normalizeNotificationUrl,
  registerNotificationProvider,
  resolveNotificationProvider,
} from './registry';

import { githubNotificationProvider } from './github';
import { documentIntelligenceNotificationProvider } from './document-intelligence';
import { financeNotificationProvider } from './finance';
import { getNotificationProvider, registerNotificationProvider } from './registry';

export function registerDefaultNotificationProviders(): void {
  const defaultProviders = [
    githubNotificationProvider,
    documentIntelligenceNotificationProvider,
    financeNotificationProvider,
  ];
  for (const provider of defaultProviders) {
    if (!getNotificationProvider(provider.sourceType)) {
      registerNotificationProvider(provider);
    }
  }
}

registerDefaultNotificationProviders();
