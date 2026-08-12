import {
  buildGitHubActionLabel,
  isGitHubNotification,
  parseGitHubNotification,
} from '@/lib/notifications/enrichment/github-parser';
import type { NotificationSourceProvider } from './types';

export const githubNotificationProvider: NotificationSourceProvider = {
  sourceType: 'github-issues',
  displayName: 'GitHub',
  signatures: [{
    key: 'github-thread',
    matches: isGitHubNotification,
    present(notification) {
      const parsed = parseGitHubNotification(notification);
      const actionUrl = notification.actionUrl || parsed.presentation.entityUrl;

      return {
        title: parsed.title,
        body: parsed.body,
        category: parsed.category,
        templateKey: parsed.templateKey,
        presentation: {
          ...parsed.presentation,
          sourceName: 'GitHub',
          providerSignature: 'github-thread',
        },
        metadata: notification.metadata,
        entityNumber: parsed.entityNumber,
        repository: parsed.repository,
        actions: actionUrl
          ? [{
              actionType: 'open_url',
              label: buildGitHubActionLabel(parsed.presentation),
              icon: 'external-link',
              variant: 'primary',
              isPrimary: true,
              payload: { url: actionUrl },
              opensExternal: true,
              createdBy: 'connector',
            }]
          : [],
      };
    },
  }],
};
